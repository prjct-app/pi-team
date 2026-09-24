import { SYMBOL, ago, type PanelAction, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import type { TeamEvent, TeamOverview, Teammate } from './session.ts';

/** Everything the panel shows: every team on disk, its members and its timeline. */
export type TeamSnapshot = {
  readonly joined?: { readonly teamId: string; readonly memberId: string; readonly team: string; readonly role: string };
  readonly teams: readonly TeamOverview[];
};

/**
 * What the person asked for from the panel that needs typed input or a
 * confirmation. The panel closes, the extension asks, acts, and reopens the
 * panel. Teams and members travel by ID; names are for the questions.
 */
export type TeamIntent =
  | { readonly action: 'create' }
  | { readonly action: 'join'; readonly teamId: string; readonly team: string }
  | { readonly action: 'message'; readonly teamId: string; readonly memberId: string; readonly role: string }
  | { readonly action: 'leave'; readonly teamId: string; readonly team: string }
  | { readonly action: 'delete'; readonly teamId: string; readonly team: string }
  | { readonly action: 'rename-team'; readonly teamId: string; readonly team: string }
  | { readonly action: 'rename-member'; readonly teamId: string; readonly memberId: string; readonly role: string }
  | { readonly action: 'remove'; readonly teamId: string; readonly memberId: string; readonly role: string };

export type TeamPanelOps = Readonly<{
  load(): Promise<TeamSnapshot>;
  /** Close the panel and handle what needs input or confirmation. */
  request(intent: TeamIntent): void;
  now(): number;
}>;

/**
 * The admin is told apart by shape, not by a word or a picture: a diamond
 * where everyone else has a dot, filled while working, hollow while idle.
 */
export const LEAD = { working: '◆', idle: '◇' } as const;
/** Teams are squares: filled while anyone is online. Shapes say what a row is; color says its state. */
export const TEAM_MARK = { live: '■', empty: '□' } as const;
/** The state mark for a member: dots for members, diamonds for the admin. */
export const mark = (mate: Pick<Teammate, 'admin' | 'online' | 'activity'>): string =>
  mate.admin ? (mate.online && mate.activity?.state === 'working' ? LEAD.working : LEAD.idle)
    : mate.online && mate.activity?.state === 'working' ? SYMBOL.active : SYMBOL.idle;
const TEAM = 'team:';
const MEMBER = 'member:';
export const teamItemId = (teamId: string): string => `${TEAM}${teamId}`;
export const memberItemId = (teamId: string, memberId: string): string => `${MEMBER}${teamId}:${memberId}`;
const one = (text: string, max = 120): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const time = (iso: string | undefined): number | undefined => {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
/** "18:02:11": the exact moment, for tracing; the list shows how long ago. */
const clock = (iso: string): string => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
/** "working 3m" / "idle 20s": the state and how long it has held. */
const held = (mate: Teammate, now: number): string => {
  if (!mate.online) return 'offline';
  if (!mate.activity) return 'online';
  return `${mate.activity.state} ${ago(time(mate.activity.since), now).replace(/ ago$/, '')}`;
};
const look = (mate: Teammate): [string, Tone] =>
  [mark(mate), !mate.online ? 'dim' : mate.activity?.state === 'working' ? 'accent' : 'success'];
const named = (mate: Teammate): string => `${mate.role}${mate.self ? ' (you)' : ''}`;

/** One timeline line: "18:02:11  reviewer → backend question: Which code?" */
export function eventLine(event: TeamEvent): string {
  const at = clock(event.at);
  const text = event.text ? one(event.text, 400) : '';
  switch (event.type) {
    case 'joined': return `${at}  ${event.role} joined${text ? ` · ${text}` : ''}`;
    case 'left': return `${at}  ${event.role} left`;
    case 'working': return `${at}  ${event.role} working${text ? ` · ${text}` : ''}`;
    case 'idle': return `${at}  ${event.role} idle`;
    case 'message': return `${at}  ${event.role} → ${event.to} ${event.kind}: ${text}`;
    case 'refused': return `${at}  ${event.role} → ${event.to} ${event.kind} refused (${text})`;
    case 'removed': return `${at}  ${event.role} removed ${event.to}`;
    case 'renamed': return `${at}  ${event.role} renamed ${text}`;
    default: return `${at}  ${event.role} ${event.type}`;
  }
}

/**
 * Every team with its members under it, the whole timeline in detail, and
 * actions to create, join, message, rename, remove, leave and delete.
 */
export function teamPanelSpec(ops: TeamPanelOps, initial: TeamSnapshot, select?: string): PanelSpec {
  const cell: { value: TeamSnapshot } = { value: initial };
  const listeners = new Set<() => void>();
  const reload = async (): Promise<void> => {
    cell.value = await ops.load();
    for (const listener of listeners) listener();
  };
  const teamOf = (item: PanelItem | undefined): TeamOverview | undefined => {
    const id = item?.id.startsWith(TEAM) ? item.id.slice(TEAM.length)
      : item?.id.startsWith(MEMBER) ? item.id.slice(MEMBER.length).split(':')[0] : undefined;
    return cell.value.teams.find(entry => entry.id === id);
  };
  const mateOf = (item: PanelItem | undefined): Teammate | undefined => {
    if (!item?.id.startsWith(MEMBER)) return undefined;
    const memberId = item.id.slice(MEMBER.length).split(':')[1];
    return teamOf(item)?.mates.find(entry => entry.id === memberId);
  };
  const isTeamRow = (item: PanelItem | undefined): boolean => !!item?.id.startsWith(TEAM);
  const inTeam = (teamId: string | undefined): boolean => !!teamId && cell.value.joined?.teamId === teamId;
  /** Only the admin, while in its own team, may rename it, rename or remove members, or delete it. */
  const amAdmin = (teamId: string | undefined): boolean =>
    inTeam(teamId) && !!cell.value.teams.find(entry => entry.id === teamId)?.mates.some(mate => mate.admin && mate.self);
  /** Why the selected member cannot be messaged right now, or undefined when it can. */
  const whyNot = (item: PanelItem | undefined): string | undefined => {
    const mate = mateOf(item);
    const team = teamOf(item);
    if (!mate || !team) return 'Select a member to message.';
    if (mate.self) return 'That is you.';
    if (!inTeam(team.id)) return `Join ${team.name} first to message its members: select ${team.name} and press a.`;
    if (!mate.online) return `${mate.role} is offline; nothing would be delivered.`;
    return undefined;
  };
  const ask = (panel: { close(): void }, intent: TeamIntent): void => { panel.close(); ops.request(intent); };
  const message = (item: PanelItem | undefined, panel: { close(): void; notice(text: string, tone?: Tone): void }): void => {
    const blocked = whyNot(item);
    if (blocked) { panel.notice(blocked, 'warning'); return; }
    const mate = mateOf(item)!;
    ask(panel, { action: 'message', teamId: teamOf(item)!.id, memberId: mate.id, role: mate.role });
  };

  const actions: PanelAction[] = [
    { key: 'n', label: 'New team', run: (_item, panel) => ask(panel, { action: 'create' }) },
    {
      key: 'a', label: item => `Join ${teamOf(item)?.name ?? ''}`.trim(),
      when: item => !!teamOf(item) && !inTeam(teamOf(item)?.id),
      run: (item, panel) => ask(panel, { action: 'join', teamId: teamOf(item)!.id, team: teamOf(item)!.name }),
    },
    // Shown on every member row, so it is always findable; says why when it cannot send.
    { key: 'm', label: item => `Message ${mateOf(item)?.role ?? ''}`.trim(), when: item => !!mateOf(item), run: message },
    {
      key: 'r', label: item => mateOf(item) ? `Rename ${mateOf(item)!.role}` : `Rename ${teamOf(item)?.name ?? 'team'}`,
      // A member may rename itself; the admin may rename anyone and the team.
      when: item => mateOf(item) ? inTeam(teamOf(item)?.id) && (mateOf(item)!.self || amAdmin(teamOf(item)?.id)) : isTeamRow(item) && amAdmin(teamOf(item)?.id),
      run: (item, panel) => {
        const team = teamOf(item)!;
        const mate = mateOf(item);
        ask(panel, mate ? { action: 'rename-member', teamId: team.id, memberId: mate.id, role: mate.role } : { action: 'rename-team', teamId: team.id, team: team.name });
      },
    },
    {
      key: 'x', label: item => `Remove ${mateOf(item)?.role ?? ''}`.trim(),
      when: item => { const mate = mateOf(item); return !!mate && !mate.self && amAdmin(teamOf(item)?.id); },
      run: (item, panel) => { const mate = mateOf(item)!; ask(panel, { action: 'remove', teamId: teamOf(item)!.id, memberId: mate.id, role: mate.role }); },
    },
    {
      key: 'l', label: 'Leave team',
      when: item => inTeam(teamOf(item)?.id),
      run: (item, panel) => ask(panel, { action: 'leave', teamId: teamOf(item)!.id, team: teamOf(item)!.name }),
    },
    {
      key: 'd', label: item => `Delete ${teamOf(item)?.name ?? 'team'}`,
      when: item => isTeamRow(item) && amAdmin(teamOf(item)?.id),
      run: (item, panel) => ask(panel, { action: 'delete', teamId: teamOf(item)!.id, team: teamOf(item)!.name }),
    },
  ];

  return {
    title: 'Team',
    summary: () => {
      const { joined, teams } = cell.value;
      const count = `${teams.length} team${teams.length === 1 ? '' : 's'}`;
      return joined ? `you are ${joined.role} in ${joined.team} · ${count}` : `not in a team · ${count}`;
    },
    items: () => {
      const now = ops.now();
      return cell.value.teams.flatMap(entry => {
        const online = entry.mates.filter(mate => mate.online).length;
        const working = entry.mates.filter(mate => mate.online && mate.activity?.state === 'working').length;
        const mine = inTeam(entry.id);
        const head: PanelItem = {
          id: teamItemId(entry.id), label: entry.name, symbol: online ? TEAM_MARK.live : TEAM_MARK.empty,
          tone: mine ? 'accent' : online ? 'success' : 'dim',
          meta: `${online}/${entry.mates.length} online${working ? ` · ${working} working` : ''}${mine ? ' · you' : ''}`,
        };
        return [head, ...entry.mates.map((mate): PanelItem => {
          const [symbol, tone] = look(mate);
          return { id: memberItemId(entry.id, mate.id), label: `  ${named(mate)}`, symbol, tone, meta: held(mate, now), search: `${entry.name} ${mate.activity?.focus ?? ''}` };
        })];
      });
    },
    detail: item => {
      const now = ops.now();
      const team = teamOf(item);
      const mate = mateOf(item);
      if (team && mate) {
        const trace = team.events.filter(event => event.byId === mate.id || event.toId === mate.id).reverse();
        return {
          title: `${mate.admin ? `${LEAD.working} ` : ''}${named(mate)}`,
          subtitle: `${held(mate, now)} · team ${team.name} · ${whyNot(item) ?? 'Enter or m to message'}`, subtitleTone: look(mate)[1],
          fields: [
            { label: 'on', value: mate.activity?.focus ? one(mate.activity.focus, 400) : '—' },
            { label: 'since', value: mate.activity ? clock(mate.activity.since) : '—' },
            { label: 'cwd', value: mate.cwd },
            { label: 'id', value: mate.id },
          ],
          sections: [{ title: `Timeline (${trace.length})`, lines: trace.map(eventLine) }],
        };
      }
      if (!team) return { title: 'Team' };
      const member = inTeam(team.id);
      const admin = team.mates.find(entry => entry.admin);
      return {
        title: team.name,
        subtitle: member ? `You are ${cell.value.joined!.role}. Messages are delivered now or refused now; nothing queues.` : 'You are not in this team. Press a or Enter to join.',
        subtitleTone: member ? 'accent' : 'muted',
        fields: [
          { label: LEAD.working, value: admin ? admin.role : '—' },
          { label: 'online', value: team.mates.filter(entry => entry.online).map(entry => entry.role).join(', ') || '—' },
          { label: 'offline', value: team.mates.filter(entry => !entry.online).map(entry => entry.role).join(', ') || '—' },
          { label: 'id', value: team.id },
        ],
        sections: [
          { title: 'Members', lines: team.mates.map(entry => `${look(entry)[0]} ${named(entry).padEnd(18)} ${held(entry, now).padEnd(14)} ${entry.activity?.focus ? one(entry.activity.focus, 80) : ''}`) },
          { title: `Timeline (${team.events.length})`, lines: [...team.events].reverse().map(eventLine) },
        ],
      };
    },
    actions,
    // Enter acts on the row: join a team you are not in, message a member.
    activate: {
      label: item => mateOf(item) ? `Message ${mateOf(item)!.role}` : `Join ${teamOf(item)?.name ?? ''}`.trim(),
      when: item => !!mateOf(item) || (isTeamRow(item) && !inTeam(teamOf(item)?.id)),
      run: (item, panel) => {
        if (mateOf(item)) { message(item, panel); return; }
        ask(panel, { action: 'join', teamId: teamOf(item)!.id, team: teamOf(item)!.name });
      },
    },
    empty: 'No teams yet. Press n to create one.',
    subscribe: listener => {
      listeners.add(listener);
      const timer = setInterval(() => { void reload().catch(() => undefined); }, 1000);
      timer.unref?.();
      return () => { listeners.delete(listener); clearInterval(timer); };
    },
    ...(select ? { initial: select } : initial.joined ? { initial: teamItemId(initial.joined.teamId) } : {}),
  };
}
