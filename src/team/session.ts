import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { EntityIdSchema, TEAM_ID_PATTERN, TimestampSchema } from '../domain/team.ts';
import type { Member } from '../domain/member.ts';
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

/** Team names and roles: what people type. Identity is always the ID behind them. */
export const NAME_PATTERN = TEAM_ID_PATTERN;
export const assertName = (value: string, label: string): string => {
  if (!NAME_PATTERN.test(value)) throw new Error(`${label} "${value}" is not valid: use 1–48 lowercase letters, digits or hyphens, starting with a letter.`);
  return value;
};

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

/** The team's display name and its admin, by member ID. The directory is named by the team ID. */
type Profile = { readonly name: string; readonly adminId?: string; readonly createdAt: string };
const ProfileSchema = Type.Object({
  name: Type.String({ pattern: TEAM_ID_PATTERN.source }),
  adminId: Type.Optional(EntityIdSchema),
  createdAt: TimestampSchema,
}, { additionalProperties: false });
const assertProfile = (value: unknown): asserts value is Profile => {
  if (!Value.Check(ProfileSchema, value)) throw new Error('Invalid team profile.');
};

export type Teammate = {
  /** Member ID: the identity. `role` is its current, renameable name. */
  readonly id: string;
  readonly role: string;
  readonly online: boolean;
  readonly cwd: string;
  readonly self: boolean;
  /** Created the team: may rename it, rename and remove members, and delete it. */
  readonly admin: boolean;
  readonly activity?: Activity;
};
/** Why this terminal is no longer in its team. */
export type Fate = { readonly reason: 'deleted' } | { readonly reason: 'removed'; readonly by: string } | { readonly reason: 'replaced' };

/**
 * One thing that happened in a team. Stored by member ID, so renames never
 * break the trace; shown with the names members have now.
 */
export const EVENT_TYPES = ['joined', 'left', 'working', 'idle', 'message', 'refused', 'removed', 'renamed'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
type StoredEvent = {
  readonly at: string;
  readonly type: EventType;
  readonly by: string;
  readonly to?: string;
  readonly kind?: MessageKind;
  readonly text?: string;
};
const EventsSchema = Type.Array(Type.Object({
  at: TimestampSchema,
  type: Type.Union(EVENT_TYPES.map(type => Type.Literal(type))),
  by: EntityIdSchema,
  to: Type.Optional(Type.String({ maxLength: 128 })),
  kind: Type.Optional(Type.Union(MESSAGE_KINDS.map(kind => Type.Literal(kind)))),
  text: Type.Optional(Type.String({ maxLength: 1200 })),
}, { additionalProperties: false }), { maxItems: 300 });
const assertEvents = (value: unknown): asserts value is StoredEvent[] => {
  if (!Value.Check(EventsSchema, value)) throw new Error('Invalid team timeline.');
};
const EVENTS_KEEP = 300;
const EVENTS_BYTES = 512 * 1024;

/** A timeline event as shown: IDs resolved to current names. */
export type TeamEvent = {
  readonly at: string;
  readonly type: EventType;
  readonly byId: string;
  readonly role: string;
  readonly toId?: string;
  readonly to?: string;
  readonly kind?: MessageKind;
  readonly text?: string;
};

/** A team with its members and timeline, as the panel lists every team on disk. */
export type TeamOverview = { readonly id: string; readonly name: string; readonly mates: readonly Teammate[]; readonly events: readonly TeamEvent[] };

export type Incoming = { readonly from: string; readonly kind: MessageKind; readonly body: string };
export type Joined = { readonly teamId: string; readonly team: string; readonly role: string; readonly membership: Membership };
/** A membership as saved in the session: IDs, plus the names for messages. */
export type Saved = { readonly teamId: string; readonly memberId: string; readonly team: string; readonly role: string };

/** A message that is not picked up within this window is dropped, never replayed later. */
const MESSAGE_TTL_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 4000;
const newTeamId = (): string => `t-${randomUUID()}`;

/**
 * One terminal's place in a team: join under a role, see teammates and what
 * each is doing, send and receive messages. Holds no queue of work.
 */
export class TeamSession {
  private readonly state: { get: () => Joined | undefined; set: (next: (current: Joined | undefined) => Joined | undefined) => void };

  constructor(private readonly runtime: TeamRuntime, private readonly now: () => number = Date.now) {
    const cell: { value?: Joined } = {};
    this.state = { get: () => cell.value, set: next => { cell.value = next(cell.value); } };
  }

  current(): Joined | undefined { return this.state.get(); }
  saved(): Saved | undefined {
    const joined = this.state.get();
    return joined ? { teamId: joined.teamId, memberId: joined.membership.memberId, team: joined.team, role: joined.role } : undefined;
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private async exists(teamId: string): Promise<boolean> {
    return this.runtime.teams.read(teamId).then(record => !!record, () => false);
  }
  private profilePath(teamId: string): string { return join(this.runtime.paths.team(teamId), 'profile.json'); }

  /** A team made before profiles is named by its ID, and its first member is admin. */
  private async profile(teamId: string): Promise<Profile> {
    const stored = await readJson(this.profilePath(teamId), assertProfile, 4096).catch(() => undefined);
    if (stored) return stored;
    const team = await this.runtime.teams.read(teamId).catch(() => undefined);
    const first = await this.firstMember(teamId);
    return { name: teamId, ...(first ? { adminId: first.memberId } : {}), createdAt: team?.createdAt ?? this.timestamp() };
  }
  private async firstMember(teamId: string): Promise<Member | undefined> {
    const members = await this.runtime.teams.listMembers(teamId).catch(() => [] as Member[]);
    return [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
  }

  /** Teams on disk by ID, with their names; a half-deleted directory is not a team. */
  async teams(): Promise<{ readonly id: string; readonly name: string }[]> {
    const ids = await this.runtime.teams.list().catch(() => [] as string[]);
    const found = await Promise.all(ids.map(async id => (await this.exists(id)) ? { id, name: (await this.profile(id)).name } : undefined));
    return found.filter((team): team is { id: string; name: string } => team !== undefined).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The team ID for a name, if a team with that name exists. */
  async findTeam(name: string): Promise<string | undefined> {
    return (await this.teams()).find(team => team.name === name)?.id;
  }

  /** Creates a team with a new ID. Names are unique, so people can type them. */
  private async createTeam(name: string): Promise<string> {
    return withStorageLock(this.runtime.paths.lock('team-names'), async () => {
      if (await this.findTeam(name)) throw new Error(`A team named ${name} already exists.`);
      const id = newTeamId();
      const at = this.timestamp();
      await this.runtime.teams.create({ schemaVersion: 2, teamId: id, state: 'open', createdAt: at, updatedAt: at });
      await replaceAtomicJson(this.profilePath(id), { name, createdAt: at } satisfies Profile, { maxBytes: 4096 });
      return id;
    });
  }

  private async requireAdmin(): Promise<Joined> {
    const joined = this.state.get();
    if (!joined) throw new Error('Not in a team.');
    const profile = await this.profile(joined.teamId);
    if (profile.adminId !== joined.membership.memberId) {
      const admin = (await this.teammates(joined.teamId)).find(mate => mate.admin)?.role;
      throw new Error(`Only the admin of ${joined.team} (${admin ?? 'nobody'}) can do that.`);
    }
    return joined;
  }
  /** For the command line: fails before asking the person to confirm something they may not do. */
  async assertAdmin(): Promise<void> { await this.requireAdmin(); }

  private async activeMember(teamId: string, role: string): Promise<Member> {
    const members = await this.runtime.teams.listMembers(teamId);
    const target = members.find(member => member.alias === role && member.state === 'active');
    if (!target) throw new Error(`${role} is not an active member of this team.`);
    return target;
  }

  /** The member shown under `role`: the active one, else the latest record with that name. */
  private async memberNamed(teamId: string, role: string): Promise<Member> {
    const members = (await this.runtime.teams.listMembers(teamId)).filter(member => member.alias === role);
    const target = members.find(member => member.state === 'active') ?? [...members].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!target) throw new Error(`No ${role} in this team.`);
    return target;
  }

  /** Admin only: takes `role` out of the team. Its terminal notices within seconds. */
  async removeMember(role: string): Promise<void> {
    const joined = await this.requireAdmin();
    if (role === joined.role) throw new Error('You cannot remove yourself; leave or delete the team instead.');
    const target = await this.activeMember(joined.teamId, role);
    // Recorded first: the removed terminal reads the timeline to learn why it lost its place.
    await this.record(joined.teamId, { type: 'removed', by: joined.membership.memberId, to: target.memberId });
    const at = this.timestamp();
    await this.runtime.teams.updateMember(joined.teamId, target.memberId, target.generation, current => ({ ...current, state: 'left', leftAt: at, updatedAt: at }));
  }

  /** Admin, or a member renaming itself: gives `role` a new name. The member keeps its ID, messages and trace. */
  async renameMember(role: string, next: string): Promise<void> {
    const joined = this.state.get();
    if (!joined) throw new Error('Not in a team.');
    assertName(next, 'Role');
    if (role !== joined.role) await this.requireAdmin();
    // Offline members can be renamed too; they rejoin by ID under the new name.
    const target = await this.memberNamed(joined.teamId, role);
    await this.runtime.teams.updateMember(joined.teamId, target.memberId, target.generation, current => ({ ...current, alias: next, updatedAt: this.timestamp() }))
      .catch(error => {
        if ((error as { code?: string }).code === 'ALREADY_EXISTS') throw new Error(`${next} is already a role in ${joined.team}.`);
        throw error;
      });
    if (target.memberId === joined.membership.memberId) this.state.set(current => current ? { ...current, role: next } : current);
    await this.record(joined.teamId, { type: 'renamed', by: joined.membership.memberId, to: target.memberId, text: `${role} → ${next}` });
  }

  /** Admin only: gives the team a new name. Its ID, members and trace stay. */
  async renameTeam(next: string): Promise<void> {
    const joined = await this.requireAdmin();
    assertName(next, 'Team');
    await withStorageLock(this.runtime.paths.lock('team-names'), async () => {
      const other = await this.findTeam(next);
      if (other && other !== joined.teamId) throw new Error(`A team named ${next} already exists.`);
      const profile = await this.profile(joined.teamId);
      await replaceAtomicJson(this.profilePath(joined.teamId), { ...profile, name: next }, { maxBytes: 4096 });
    });
    this.state.set(current => current ? { ...current, team: next } : current);
    await this.record(joined.teamId, { type: 'renamed', by: joined.membership.memberId, text: `team ${joined.team} → ${next}` });
  }

  /** Admin only: deletes the team, its members, messages and timeline. Every terminal in it notices within seconds. */
  async deleteTeam(): Promise<string> {
    const joined = await this.requireAdmin();
    this.state.set(() => undefined);
    await withStorageLock(this.runtime.paths.teamLock(joined.teamId), () => rm(this.runtime.paths.team(joined.teamId), { recursive: true, force: true }));
    return joined.team;
  }

  /** After losing membership: was the team deleted, was this member removed, or did another terminal take it? */
  async fate(teamId: string, memberId: string): Promise<Fate> {
    if (!await this.exists(teamId)) return { reason: 'deleted' };
    const events = [...await this.stored(teamId)].reverse();
    const removal = events.find(event => event.type === 'removed' && event.to === memberId);
    const rejoined = events.find(event => event.type === 'joined' && event.by === memberId);
    if (removal && (!rejoined || removal.at >= rejoined.at)) {
      const names = await this.names(teamId);
      return { reason: 'removed', by: names.get(removal.by) ?? 'the admin' };
    }
    return { reason: 'replaced' };
  }

  /**
   * Joins the team named `team` as `role`, creating it on first use. Leaves any
   * team joined before. With `saved`, rejoins that exact team and member by ID.
   */
  async join(input: { readonly team: string; readonly role: string; readonly sessionId: string; readonly cwd: string; readonly saved?: Saved }): Promise<{ readonly created: boolean }> {
    await this.leave();
    const found = input.saved && await this.exists(input.saved.teamId) ? input.saved.teamId : await this.findTeam(assertName(input.team, 'Team'));
    if (!found && input.saved) throw new Error(`Team ${input.saved.team} no longer exists.`);
    const teamId = found ?? await this.createTeam(input.team);
    // Rejoining by ID keeps the name the member has now, even if it was renamed while away.
    const current = input.saved ? (await this.runtime.teams.readMember(teamId, input.saved.memberId).catch(() => undefined)) : undefined;
    const role = current?.alias ?? assertName(input.role, 'Role');
    const membership = await this.runtime.memberships.join({ teamId, alias: role, sessionId: input.sessionId, cwd: input.cwd, kind: 'external', ...(current ? { memberId: current.memberId } : {}) })
      .catch(error => {
        if ((error as { code?: string }).code === 'ALREADY_EXISTS') throw new Error(`"${role}" is already online in team ${input.team}. Pick another role.`);
        throw error;
      });
    if (!found) {
      const profile = await this.profile(teamId);
      await replaceAtomicJson(this.profilePath(teamId), { ...profile, adminId: membership.memberId }, { maxBytes: 4096 });
    }
    const name = (await this.profile(teamId)).name;
    this.state.set(() => ({ teamId, team: name, role, membership }));
    await this.record(teamId, { type: 'joined', by: membership.memberId, text: input.cwd });
    await this.setActivity({ state: 'idle', since: this.timestamp() });
    return { created: !found };
  }

  async leave(): Promise<Joined | undefined> {
    const joined = this.state.get();
    if (!joined) return undefined;
    this.state.set(() => undefined);
    await this.runtime.memberships.leave(joined.membership).catch(() => {});
    await this.record(joined.teamId, { type: 'left', by: joined.membership.memberId });
    return joined;
  }

  /**
   * Renews presence and picks up renames. When this terminal is no longer a
   * member, returns what it lost; when its names changed, returns them.
   */
  async heartbeat(): Promise<{ readonly lost?: Saved; readonly renamed?: { readonly team: string; readonly role: string } }> {
    const joined = this.state.get();
    if (!joined) return {};
    const alive = await this.runtime.memberships.heartbeat(joined.membership).then(() => true, () => false);
    if (!alive) {
      this.state.set(current => current === joined ? undefined : current);
      return { lost: { teamId: joined.teamId, memberId: joined.membership.memberId, team: joined.team, role: joined.role } };
    }
    const member = await this.runtime.teams.readMember(joined.teamId, joined.membership.memberId).catch(() => undefined);
    const team = (await this.profile(joined.teamId)).name;
    const role = member?.alias ?? joined.role;
    if (team === joined.team && role === joined.role) return {};
    this.state.set(current => current === joined ? { ...current, team, role } : current);
    return { renamed: { team, role } };
  }

  private activityPath(teamId: string, memberId: string): string {
    return join(this.runtime.paths.team(teamId), 'activity', `${memberId}.json`);
  }

  async setActivity(activity: Activity): Promise<void> {
    const joined = this.state.get();
    // A deleted team must not be brought back as a half directory.
    if (!joined || !await this.exists(joined.teamId)) return;
    await ensurePrivateDirectory(join(this.runtime.paths.team(joined.teamId), 'activity'));
    const record = { ...activity, ...(activity.focus ? { focus: clean(activity.focus, 512) } : {}) };
    const path = this.activityPath(joined.teamId, joined.membership.memberId);
    const previous = await readJson(path, assertActivity, 2048).catch(() => undefined);
    await replaceAtomicJson(path, record, { maxBytes: 2048 });
    // The timeline keeps changes only: a new state, or new work while working. Joining already says idle.
    const changed = previous ? previous.state !== record.state : record.state === 'working';
    if (changed || (record.state === 'working' && previous?.focus !== record.focus)) {
      await this.record(joined.teamId, { type: record.state, by: joined.membership.memberId, ...(record.state === 'working' && record.focus ? { text: record.focus } : {}) });
    }
  }

  private async names(teamId: string): Promise<Map<string, string>> {
    const members = await this.runtime.teams.listMembers(teamId).catch(() => [] as Member[]);
    return new Map(members.map(member => [member.memberId, member.alias]));
  }

  /** Everyone in the joined team (or `teamId`), with live activity. */
  async teammates(teamId = this.state.get()?.teamId): Promise<Teammate[]> {
    if (!teamId) return [];
    const self = this.state.get();
    const members = await this.runtime.teams.listMembers(teamId);
    const { adminId } = await this.profile(teamId);
    // An active member wins over an old record that once had the same name.
    const shown = [...members]
      .sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active') || b.updatedAt.localeCompare(a.updatedAt))
      .filter((member, index, all) => all.findIndex(other => other.alias === member.alias) === index);
    const list = await Promise.all(shown.map(async member => {
      const online = await this.runtime.presence.online(member);
      const activity = online ? await readJson(this.activityPath(teamId, member.memberId), assertActivity, 2048).catch(() => undefined) : undefined;
      return {
        id: member.memberId, role: member.alias, online, cwd: member.cwd,
        self: self?.teamId === teamId && self.membership.memberId === member.memberId,
        admin: member.memberId === adminId, ...(activity ? { activity } : {}),
      };
    }));
    return list.sort((a, b) => Number(b.online) - Number(a.online) || a.role.localeCompare(b.role));
  }

  /** Delivers now or fails now: an offline teammate is an error, never a queue. */
  async send(to: string, kind: MessageKind, body: string): Promise<void> {
    const joined = this.state.get();
    if (!joined) throw new Error('Not in a team. Use /team join <team> <role>.');
    if (to === joined.role) throw new Error('That is you. Message another role.');
    bounded(body, MAX_BODY_BYTES, 'Message');
    const target = (await this.teammates(joined.teamId)).find(mate => mate.role === to);
    const refusal = !target ? `No "${to}" in team ${joined.team}.`
      : !target.online ? `${to} is offline, so nothing was sent. Do not wait for them: carry on with your own work.` : undefined;
    if (refusal) {
      await this.record(joined.teamId, { type: 'refused', by: joined.membership.memberId, to: target?.id ?? to, kind, text: target ? 'offline' : 'no such role' });
      throw new Error(refusal);
    }
    await this.runtime.requests.send(joined.membership, { to, kind, body: clean(body, MAX_BODY_BYTES), ttlMs: MESSAGE_TTL_MS });
    await this.record(joined.teamId, { type: 'message', by: joined.membership.memberId, to: target!.id, kind, text: body });
  }

  private eventsPath(teamId: string): string { return join(this.runtime.paths.team(teamId), 'events.json'); }

  /** Appends to the team timeline. Best-effort: tracing never blocks the work it traces. */
  private async record(teamId: string, event: Omit<StoredEvent, 'at'>): Promise<void> {
    const entry: StoredEvent = { ...event, at: this.timestamp(), ...(event.text ? { text: clean(event.text, 1200) } : {}) };
    await withStorageLock(this.runtime.paths.lock(`events-${teamId}`), async () => {
      if (!await this.exists(teamId)) return;
      const events = await this.stored(teamId);
      await replaceAtomicJson(this.eventsPath(teamId), [...events, entry].slice(-EVENTS_KEEP), { maxBytes: EVENTS_BYTES });
    }).catch(() => {});
  }
  private async stored(teamId: string): Promise<StoredEvent[]> {
    return await readJson(this.eventsPath(teamId), assertEvents, EVENTS_BYTES).catch(() => undefined) ?? [];
  }

  /** The timeline of the joined team (or `teamId`), oldest first, with current names. */
  async events(teamId = this.state.get()?.teamId): Promise<TeamEvent[]> {
    if (!teamId) return [];
    const [events, names] = await Promise.all([this.stored(teamId), this.names(teamId)]);
    return events.map(event => ({
      at: event.at, type: event.type, byId: event.by, role: names.get(event.by) ?? 'someone',
      ...(event.to ? { toId: event.to, to: names.get(event.to) ?? event.to } : {}),
      ...(event.kind ? { kind: event.kind } : {}), ...(event.text ? { text: event.text } : {}),
    }));
  }

  /** Every team on disk with its members and timeline, the joined one first. */
  async overview(): Promise<TeamOverview[]> {
    const joined = this.state.get()?.teamId;
    const teams = await this.teams();
    const all = await Promise.all(teams.map(async team => ({
      id: team.id, name: team.name, mates: await this.teammates(team.id).catch(() => []), events: await this.events(team.id),
    })));
    return all.sort((a, b) => Number(b.id === joined) - Number(a.id === joined) || a.name.localeCompare(b.name));
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
