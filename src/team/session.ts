import { join } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { assertTeamId, TimestampSchema } from '../domain/team.ts';
import type { Membership } from '../runtime/membership.ts';
import type { TeamRuntime } from '../runtime/team-runtime.ts';
import { ensurePrivateDirectory, readJson, replaceAtomicJson, withStorageLock } from '../storage/atomic.ts';
import { bounded, clean } from './text.ts';

/**
 * Kinds of message between terminals. None of them is a request that waits
 * for a result: a message is information, delivered now or refused now.
 */
export const MESSAGE_KINDS = ['info', 'question', 'handoff'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** What a terminal is doing right now, so a stall is visible instead of silent. */
export type Activity = { readonly state: 'idle' | 'working'; readonly since: string; readonly focus?: string };
const ActivitySchema = Type.Object({
  state: Type.Union([Type.Literal('idle'), Type.Literal('working')]),
  since: TimestampSchema,
  focus: Type.Optional(Type.String({ maxLength: 512 })),
}, { additionalProperties: false });
const assertActivity = (value: unknown): asserts value is Activity => {
  if (!Value.Check(ActivitySchema, value)) throw new Error('Invalid teammate activity record.');
};

export type Teammate = {
  readonly role: string;
  readonly online: boolean;
  readonly cwd: string;
  readonly self: boolean;
  readonly activity?: Activity;
};
/** One message as the panel shows it: who talked to whom, and when. */
export type LogEntry = { readonly at: string; readonly from: string; readonly to: string; readonly kind: MessageKind; readonly body: string };
const LogSchema = Type.Array(Type.Object({
  at: TimestampSchema, from: Type.String({ maxLength: 48 }), to: Type.String({ maxLength: 48 }),
  kind: Type.Union(MESSAGE_KINDS.map(kind => Type.Literal(kind))), body: Type.String({ maxLength: 600 }),
}, { additionalProperties: false }), { maxItems: 100 });
const assertLog = (value: unknown): asserts value is LogEntry[] => {
  if (!Value.Check(LogSchema, value)) throw new Error('Invalid team message log.');
};
const LOG_KEEP = 100;

export type Incoming = { readonly from: string; readonly kind: MessageKind; readonly body: string };
export type Joined = { readonly team: string; readonly role: string; readonly membership: Membership };

/** A message that is not picked up within this window is dropped, never replayed later. */
const MESSAGE_TTL_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 4000;

/**
 * One terminal's place in a named team: join under a role, see teammates and
 * what each is doing, send and receive messages. Holds no queue of work.
 */
export class TeamSession {
  private readonly state: { get: () => Joined | undefined; set: (next: (current: Joined | undefined) => Joined | undefined) => void };

  constructor(private readonly runtime: TeamRuntime, private readonly now: () => number = Date.now) {
    const cell: { value?: Joined } = {};
    this.state = { get: () => cell.value, set: next => { cell.value = next(cell.value); } };
  }

  current(): Joined | undefined { return this.state.get(); }

  async teams(): Promise<string[]> { return this.runtime.teams.list().catch(() => []); }

  /** Joins `team` as `role`, creating the team on first use. Leaves any team joined before. */
  async join(input: { readonly team: string; readonly role: string; readonly sessionId: string; readonly cwd: string }): Promise<{ readonly created: boolean }> {
    const team = assertTeamId(input.team);
    const role = assertTeamId(input.role);
    await this.leave();
    const timestamp = new Date(this.now()).toISOString();
    const created = await this.runtime.teams.create({ schemaVersion: 2, teamId: team, state: 'open', createdAt: timestamp, updatedAt: timestamp })
      .then(() => true, error => {
        if ((error as { code?: string }).code === 'ALREADY_EXISTS') return false;
        throw error;
      });
    const membership = await this.runtime.memberships.join({ teamId: team, alias: role, sessionId: input.sessionId, cwd: input.cwd, kind: 'external' })
      .catch(error => {
        if ((error as { code?: string }).code === 'ALREADY_EXISTS') throw new Error(`"${role}" is already online in team ${team}. Pick another role.`);
        throw error;
      });
    this.state.set(() => ({ team, role, membership }));
    await this.setActivity({ state: 'idle', since: timestamp });
    return { created };
  }

  async leave(): Promise<Joined | undefined> {
    const joined = this.state.get();
    if (!joined) return undefined;
    this.state.set(() => undefined);
    await this.runtime.memberships.leave(joined.membership).catch(() => {});
    return joined;
  }

  /** Renews presence. False when another terminal took this role: this one is no longer a member. */
  async heartbeat(): Promise<boolean> {
    const joined = this.state.get();
    if (!joined) return false;
    const alive = await this.runtime.memberships.heartbeat(joined.membership).then(() => true, () => false);
    if (!alive) this.state.set(current => current === joined ? undefined : current);
    return alive;
  }

  private activityPath(team: string, memberId: string): string {
    return join(this.runtime.paths.team(team), 'activity', `${memberId}.json`);
  }

  async setActivity(activity: Activity): Promise<void> {
    const joined = this.state.get();
    if (!joined) return;
    const directory = join(this.runtime.paths.team(joined.team), 'activity');
    await ensurePrivateDirectory(directory);
    const record = { ...activity, ...(activity.focus ? { focus: clean(activity.focus, 512) } : {}) };
    await replaceAtomicJson(this.activityPath(joined.team, joined.membership.memberId), record, { maxBytes: 2048 });
  }

  /** Everyone in the joined team (or `team`), newest record per role, with live activity. */
  async teammates(team = this.state.get()?.team): Promise<Teammate[]> {
    if (!team) return [];
    const self = this.state.get();
    const members = await this.runtime.teams.listMembers(team);
    const latest = [...members]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((member, index, all) => all.findIndex(other => other.alias === member.alias) === index);
    const list = await Promise.all(latest.map(async member => {
      const online = await this.runtime.presence.online(member);
      const activity = online
        ? await readJson(this.activityPath(team, member.memberId), assertActivity, 2048).catch(() => undefined)
        : undefined;
      return { role: member.alias, online, cwd: member.cwd, self: self?.team === team && self.membership.memberId === member.memberId, ...(activity ? { activity } : {}) };
    }));
    return list.sort((a, b) => Number(b.online) - Number(a.online) || a.role.localeCompare(b.role));
  }

  /** Delivers now or fails now: an offline teammate is an error, never a queue. */
  async send(to: string, kind: MessageKind, body: string): Promise<void> {
    const joined = this.state.get();
    if (!joined) throw new Error('Not in a team. Use /team join <team> <role>.');
    if (to === joined.role) throw new Error('That is you. Message another role.');
    bounded(body, MAX_BODY_BYTES, 'Message');
    const target = (await this.teammates(joined.team)).find(mate => mate.role === to);
    if (!target) throw new Error(`No "${to}" in team ${joined.team}.`);
    if (!target.online) throw new Error(`${to} is offline, so nothing was sent. Do not wait for them: carry on with your own work.`);
    await this.runtime.requests.send(joined.membership, { to, kind, body: clean(body, MAX_BODY_BYTES), ttlMs: MESSAGE_TTL_MS });
    await this.record(joined.team, { at: new Date(this.now()).toISOString(), from: joined.role, to, kind, body: clean(body, 300) }).catch(() => {});
  }

  private logPath(team: string): string { return join(this.runtime.paths.team(team), 'messages.json'); }

  /** The trace behind the panel. The message itself travels through the inbox. */
  private async record(team: string, entry: LogEntry): Promise<void> {
    await withStorageLock(this.runtime.paths.lock(`log-${team}`), async () => {
      const log = await readJson(this.logPath(team), assertLog, 128 * 1024).catch(() => undefined) ?? [];
      await replaceAtomicJson(this.logPath(team), [...log, entry].slice(-LOG_KEEP), { maxBytes: 128 * 1024 });
    });
  }

  /** Recent messages in the joined team (or `team`), oldest first. */
  async recent(team = this.state.get()?.team): Promise<LogEntry[]> {
    if (!team) return [];
    return await readJson(this.logPath(team), assertLog, 128 * 1024).catch(() => undefined) ?? [];
  }

  /** Every team on disk with how many are online, for the panel when this terminal is in none. */
  async overview(): Promise<{ readonly team: string; readonly online: number; readonly total: number }[]> {
    const teams = await this.teams();
    return Promise.all(teams.map(async team => {
      const mates = await this.teammates(team).catch(() => []);
      return { team, online: mates.filter(mate => mate.online).length, total: mates.length };
    }));
  }

  /** Takes every message waiting for this terminal, each exactly once. */
  async receive(): Promise<Incoming[]> {
    const joined = this.state.get();
    if (!joined) return [];
    const { membership } = joined;
    const page = await this.runtime.inbox.listPending(membership.teamId, membership.memberId, 20);
    const take = async (messageId: string): Promise<Incoming | undefined> => {
      try {
        await this.runtime.delivery.claim(membership, messageId);
        const read = await this.runtime.delivery.read(membership, messageId);
        await this.runtime.delivery.finish(membership, messageId);
        if (!(MESSAGE_KINDS as readonly string[]).includes(read.kind)) return undefined;
        const sender = await this.runtime.memberships.member(membership.teamId, read.fromMemberId);
        return { from: sender?.alias ?? 'a teammate', kind: read.kind as MessageKind, body: clean(read.body, MAX_BODY_BYTES) };
      } catch { return undefined; }
    };
    // In arrival order, one at a time, so a conversation reads in sequence.
    const received: Incoming[] = [];
    for (const message of [...page.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const item = await take(message.messageId);
      if (item) received.push(item);
    }
    return received;
  }
}
