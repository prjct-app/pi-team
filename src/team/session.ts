import { rm } from 'node:fs/promises';
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
  /** The role that created the team: it may remove members and delete the team. */
  readonly admin: boolean;
  readonly activity?: Activity;
};
/** Why this terminal is no longer in its team. */
export type Fate = { readonly reason: 'deleted' } | { readonly reason: 'removed'; readonly by: string } | { readonly reason: 'replaced' };
/**
 * One thing that happened in a team, for the timeline: who joined or left,
 * who started or stopped working and on what, every message, every refused send.
 */
export const EVENT_TYPES = ['joined', 'left', 'working', 'idle', 'message', 'refused', 'removed'] as const;
export type TeamEvent = {
  readonly at: string;
  readonly type: (typeof EVENT_TYPES)[number];
  readonly role: string;
  readonly to?: string;
  readonly kind?: MessageKind;
  readonly text?: string;
};
const EventsSchema = Type.Array(Type.Object({
  at: TimestampSchema,
  type: Type.Union(EVENT_TYPES.map(type => Type.Literal(type))),
  role: Type.String({ maxLength: 48 }),
  to: Type.Optional(Type.String({ maxLength: 48 })),
  kind: Type.Optional(Type.Union(MESSAGE_KINDS.map(kind => Type.Literal(kind)))),
  text: Type.Optional(Type.String({ maxLength: 1200 })),
}, { additionalProperties: false }), { maxItems: 300 });
const assertEvents = (value: unknown): asserts value is TeamEvent[] => {
  if (!Value.Check(EventsSchema, value)) throw new Error('Invalid team timeline.');
};
const EVENTS_KEEP = 300;
const EVENTS_BYTES = 512 * 1024;

/** A team with its members, as the panel lists every team on disk. */
export type TeamOverview = { readonly team: string; readonly mates: readonly Teammate[]; readonly events: readonly TeamEvent[] };

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

  /** Teams on disk; a half-deleted directory is not a team. */
  async teams(): Promise<string[]> {
    const names = await this.runtime.teams.list().catch(() => [] as string[]);
    const present = await Promise.all(names.map(async name => (await this.exists(name)) ? name : undefined));
    return present.filter((name): name is string => name !== undefined);
  }

  private async exists(team: string): Promise<boolean> {
    return this.runtime.teams.read(team).then(record => !!record, () => false);
  }

  /** The admin is the role that created the team: the member who joined first. */
  async adminOf(team: string): Promise<string | undefined> {
    const members = await this.runtime.teams.listMembers(team).catch(() => []);
    return [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0]?.alias;
  }

  private async requireAdmin(): Promise<Joined> {
    const joined = this.state.get();
    if (!joined) throw new Error('Not in a team.');
    const admin = await this.adminOf(joined.team);
    if (admin !== joined.role) throw new Error(`Only the admin of ${joined.team} (${admin ?? 'nobody'}) can do that.`);
    return joined;
  }

  /** Admin only: takes `role` out of the team. Its terminal notices within seconds. */
  async removeMember(role: string): Promise<void> {
    const joined = await this.requireAdmin();
    if (role === joined.role) throw new Error('You cannot remove yourself; leave or delete the team instead.');
    const members = await this.runtime.teams.listMembers(joined.team);
    const target = members.find(member => member.alias === role && member.state === 'active');
    if (!target) throw new Error(`${role} is not an active member of ${joined.team}.`);
    // Recorded first: the removed terminal reads the timeline to learn why it lost its role.
    await this.record(joined.team, { type: 'removed', role: joined.role, to: role });
    const timestamp = new Date(this.now()).toISOString();
    await this.runtime.teams.updateMember(joined.team, target.memberId, target.generation, current => ({ ...current, state: 'left', leftAt: timestamp, updatedAt: timestamp }));
  }

  /** Admin only: deletes the team, its members, messages and timeline. Every terminal in it notices within seconds. */
  async deleteTeam(): Promise<string> {
    const joined = await this.requireAdmin();
    this.state.set(() => undefined);
    await withStorageLock(this.runtime.paths.teamLock(joined.team), () => rm(this.runtime.paths.team(joined.team), { recursive: true, force: true }));
    return joined.team;
  }

  /** After losing membership: was the team deleted, was this role removed, or did another terminal take it? */
  async fate(team: string, role: string): Promise<Fate> {
    if (!await this.exists(team)) return { reason: 'deleted' };
    const removal = (await this.events(team)).reverse().find(event => event.type === 'removed' && event.to === role);
    const rejoined = (await this.events(team)).reverse().find(event => event.type === 'joined' && event.role === role);
    if (removal && (!rejoined || removal.at >= rejoined.at)) return { reason: 'removed', by: removal.role };
    return { reason: 'replaced' };
  }

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
    await this.record(team, { type: 'joined', role, text: input.cwd });
    await this.setActivity({ state: 'idle', since: timestamp });
    return { created };
  }

  async leave(): Promise<Joined | undefined> {
    const joined = this.state.get();
    if (!joined) return undefined;
    this.state.set(() => undefined);
    await this.runtime.memberships.leave(joined.membership).catch(() => {});
    await this.record(joined.team, { type: 'left', role: joined.role });
    return joined;
  }

  /** Renews presence. When this terminal is no longer a member, returns the team and role it lost. */
  async heartbeat(): Promise<{ readonly team: string; readonly role: string } | undefined> {
    const joined = this.state.get();
    if (!joined) return undefined;
    const alive = await this.runtime.memberships.heartbeat(joined.membership).then(() => true, () => false);
    if (alive) return undefined;
    this.state.set(current => current === joined ? undefined : current);
    return { team: joined.team, role: joined.role };
  }

  private activityPath(team: string, memberId: string): string {
    return join(this.runtime.paths.team(team), 'activity', `${memberId}.json`);
  }

  async setActivity(activity: Activity): Promise<void> {
    const joined = this.state.get();
    // A deleted team must not be brought back as a half directory.
    if (!joined || !await this.exists(joined.team)) return;
    const directory = join(this.runtime.paths.team(joined.team), 'activity');
    await ensurePrivateDirectory(directory);
    const record = { ...activity, ...(activity.focus ? { focus: clean(activity.focus, 512) } : {}) };
    const path = this.activityPath(joined.team, joined.membership.memberId);
    const previous = await readJson(path, assertActivity, 2048).catch(() => undefined);
    await replaceAtomicJson(path, record, { maxBytes: 2048 });
    // The timeline keeps changes only: a new state, or new work while working. Joining already says idle.
    const changed = previous ? previous.state !== record.state : record.state === 'working';
    if (changed || (record.state === 'working' && previous?.focus !== record.focus)) {
      await this.record(joined.team, { type: record.state, role: joined.role, ...(record.state === 'working' && record.focus ? { text: record.focus } : {}) });
    }
  }

  /** Everyone in the joined team (or `team`), newest record per role, with live activity. */
  async teammates(team = this.state.get()?.team): Promise<Teammate[]> {
    if (!team) return [];
    const self = this.state.get();
    const members = await this.runtime.teams.listMembers(team);
    const admin = [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0]?.alias;
    const latest = [...members]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((member, index, all) => all.findIndex(other => other.alias === member.alias) === index);
    const list = await Promise.all(latest.map(async member => {
      const online = await this.runtime.presence.online(member);
      const activity = online
        ? await readJson(this.activityPath(team, member.memberId), assertActivity, 2048).catch(() => undefined)
        : undefined;
      return { role: member.alias, online, cwd: member.cwd, self: self?.team === team && self.membership.memberId === member.memberId, admin: member.alias === admin, ...(activity ? { activity } : {}) };
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
    const refusal = !target ? `No "${to}" in team ${joined.team}.`
      : !target.online ? `${to} is offline, so nothing was sent. Do not wait for them: carry on with your own work.` : undefined;
    if (refusal) {
      await this.record(joined.team, { type: 'refused', role: joined.role, to, kind, text: target ? 'offline' : 'no such role' });
      throw new Error(refusal);
    }
    await this.runtime.requests.send(joined.membership, { to, kind, body: clean(body, MAX_BODY_BYTES), ttlMs: MESSAGE_TTL_MS });
    await this.record(joined.team, { type: 'message', role: joined.role, to, kind, text: body });
  }

  private eventsPath(team: string): string { return join(this.runtime.paths.team(team), 'events.json'); }

  /** Appends to the team timeline. Best-effort: tracing never blocks the work it traces. */
  private async record(team: string, event: Omit<TeamEvent, 'at'>): Promise<void> {
    const entry: TeamEvent = { ...event, at: new Date(this.now()).toISOString(), ...(event.text ? { text: clean(event.text, 1200) } : {}) };
    await withStorageLock(this.runtime.paths.lock(`events-${team}`), async () => {
      if (!await this.exists(team)) return;
      const events = await this.events(team);
      await replaceAtomicJson(this.eventsPath(team), [...events, entry].slice(-EVENTS_KEEP), { maxBytes: EVENTS_BYTES });
    }).catch(() => {});
  }

  /** The team timeline (the joined team by default), oldest first. */
  async events(team = this.state.get()?.team): Promise<TeamEvent[]> {
    if (!team) return [];
    return await readJson(this.eventsPath(team), assertEvents, EVENTS_BYTES).catch(() => undefined) ?? [];
  }

  /** Every team on disk with its members and timeline, the joined one first. */
  async overview(): Promise<TeamOverview[]> {
    const joined = this.state.get()?.team;
    const teams = await this.teams();
    const all = await Promise.all(teams.map(async team => ({
      team, mates: await this.teammates(team).catch(() => []), events: await this.events(team),
    })));
    return all.sort((a, b) => Number(b.team === joined) - Number(a.team === joined) || a.team.localeCompare(b.team));
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
