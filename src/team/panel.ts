import { SYMBOL, ago, type PanelAction, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import type { TeamEvent, TeamOverview, Teammate } from './session.ts';

/** Everything the panel shows: every team on disk, its members and its timeline. */
export type TeamSnapshot = {
  readonly joined?: { readonly team: string; readonly role: string };
  readonly teams: readonly TeamOverview[];
};

/**
 * What the person asked for from the panel that needs typed input. The panel
 * closes, the extension asks, does it, and opens the panel again on `select`.
 */
export type TeamIntent =
  | { readonly action: 'create' }
  | { readonly action: 'join'; readonly team: string }
  | { readonly action: 'message'; readonly team: string; readonly role: string };

export type TeamPanelOps = Readonly<{
  load(): Promise<TeamSnapshot>;
  /** Close the panel and handle what needs input. */
  request(intent: TeamIntent): void;
  leave(): Promise<string>;
  now(): number;
}>;

const TEAM = 'team:';
const MEMBER = 'member:';
export const teamItemId = (team: string): string => `${TEAM}${team}`;
export const memberItemId = (team: string, role: string): string => `${MEMBER}${team}:${role}`;
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
  !mate.online ? [SYMBOL.idle, 'dim'] : mate.activity?.state === 'working' ? [SYMBOL.active, 'accent'] : [SYMBOL.idle, 'success'];

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
  }
}

/** Every team with its members under it, the whole timeline in detail, and actions to create, join, message, leave. */
export function teamPanelSpec(ops: TeamPanelOps, initial: TeamSnapshot, select?: string): PanelSpec {
  const cell: { value: TeamSnapshot } = { value: initial };
  const listeners = new Set<() => void>();
  const reload = async (): Promise<void> => {
    cell.value = await ops.load();
    for (const listener of listeners) listener();
  };
  const teamOf = (item: PanelItem | undefined): TeamOverview | undefined => {
    const name = item?.id.startsWith(TEAM) ? item.id.slice(TEAM.length)
      : item?.id.startsWith(MEMBER) ? item.id.slice(MEMBER.length).split(':')[0] : undefined;
    return cell.value.teams.find(entry => entry.team === name);
  };
  const mateOf = (item: PanelItem | undefined): Teammate | undefined => {
    if (!item?.id.startsWith(MEMBER)) return undefined;
    const [, role] = item.id.slice(MEMBER.length).split(':');
    return teamOf(item)?.mates.find(entry => entry.role === role);
  };
  const inTeam = (team: string | undefined): boolean => !!team && cell.value.joined?.team === team;

  const actions: PanelAction[] = [
    { key: 'n', label: 'New team', run: (_item, panel) => { panel.close(); ops.request({ action: 'create' }); } },
    {
      key: 'a', label: item => `Join ${teamOf(item)?.team ?? ''}`.trim(),
      when: item => !!teamOf(item) && !inTeam(teamOf(item)?.team),
      run: (item, panel) => { panel.close(); ops.request({ action: 'join', team: teamOf(item)!.team }); },
    },
    {
      key: 'm', label: item => `Message ${mateOf(item)?.role ?? ''}`.trim(),
      when: item => { const mate = mateOf(item); return !!mate && mate.online && !mate.self && inTeam(teamOf(item)?.team); },
      run: (item, panel) => { panel.close(); ops.request({ action: 'message', team: teamOf(item)!.team, role: mateOf(item)!.role }); },
    },
    {
      key: 'l', label: 'Leave team', confirm: true,
      when: item => inTeam(teamOf(item)?.team),
      run: async (_item, panel) => { const text = await ops.leave(); await reload(); panel.notice(text, 'success'); },
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
        const head: PanelItem = {
          id: teamItemId(entry.team), label: entry.team, symbol: inTeam(entry.team) ? SYMBOL.mode : online ? SYMBOL.active : SYMBOL.idle,
          tone: inTeam(entry.team) ? 'accent' : online ? 'success' : 'dim',
          meta: `${online}/${entry.mates.length} online${working ? ` · ${working} working` : ''}${inTeam(entry.team) ? ' · you' : ''}`,
        };
        return [head, ...entry.mates.map((mate): PanelItem => {
          const [symbol, tone] = look(mate);
          return { id: memberItemId(entry.team, mate.role), label: `  ${mate.role}${mate.self ? ' (you)' : ''}`, symbol, tone, meta: held(mate, now), search: `${entry.team} ${mate.activity?.focus ?? ''}` };
        })];
      });
    },
    detail: item => {
      const now = ops.now();
      const team = teamOf(item);
      const mate = mateOf(item);
      if (team && mate) {
        const trace = team.events.filter(event => event.role === mate.role || event.to === mate.role).reverse();
        return {
          title: `${mate.role}${mate.self ? ' (you)' : ''}`,
          subtitle: `${held(mate, now)} · team ${team.team}`, subtitleTone: look(mate)[1],
          fields: [
            { label: 'on', value: mate.activity?.focus ? one(mate.activity.focus, 400) : '—' },
            { label: 'since', value: mate.activity ? clock(mate.activity.since) : '—' },
            { label: 'cwd', value: mate.cwd },
          ],
          sections: [{ title: `Timeline (${trace.length})`, lines: trace.map(eventLine) }],
        };
      }
      if (!team) return { title: 'Team' };
      const member = inTeam(team.team);
      return {
        title: team.team,
        subtitle: member ? `You are ${cell.value.joined!.role}. Messages are delivered now or refused now; nothing queues.` : 'You are not in this team. Press a or Enter to join.',
        subtitleTone: member ? 'accent' : 'muted',
        fields: [
          { label: 'online', value: team.mates.filter(entry => entry.online).map(entry => entry.role).join(', ') || '—' },
          { label: 'offline', value: team.mates.filter(entry => !entry.online).map(entry => entry.role).join(', ') || '—' },
        ],
        sections: [
          { title: 'Members', lines: team.mates.map(entry => `${look(entry)[0]} ${entry.role.padEnd(16)} ${held(entry, now).padEnd(14)} ${entry.activity?.focus ? one(entry.activity.focus, 80) : ''}`) },
          { title: `Timeline (${team.events.length})`, lines: [...team.events].reverse().map(eventLine) },
        ],
      };
    },
    actions,
    activate: {
      label: 'Join',
      when: item => !!item?.id.startsWith(TEAM) && !inTeam(teamOf(item)?.team),
      run: (item, panel) => { panel.close(); ops.request({ action: 'join', team: teamOf(item)!.team }); },
    },
    empty: 'No teams yet. Press n to create one.',
    subscribe: listener => {
      listeners.add(listener);
      const timer = setInterval(() => { void reload().catch(() => undefined); }, 1000);
      timer.unref?.();
      return () => { listeners.delete(listener); clearInterval(timer); };
    },
    ...(select ? { initial: select } : initial.joined ? { initial: teamItemId(initial.joined.team) } : {}),
  };
}
