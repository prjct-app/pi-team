import { SYMBOL, ago, type PanelAction, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import type { LogEntry, Teammate } from './session.ts';

/** Everything the panel shows, loaded in one go and refreshed while it is open. */
export type TeamSnapshot = {
  readonly joined?: { readonly team: string; readonly role: string };
  readonly mates: readonly Teammate[];
  readonly log: readonly LogEntry[];
  readonly teams: readonly { readonly team: string; readonly online: number; readonly total: number }[];
};

/** What the /team panel can ask of the extension. */
export type TeamPanelOps = Readonly<{
  load(): Promise<TeamSnapshot>;
  /** Close the panel and leave `text` in the editor. */
  compose(text: string): void;
  leave(): Promise<string>;
  now(): number;
}>;

const TEAM = 'team';
const MATE = 'mate:';
const JOIN = 'join:';
const one = (text: string, max = 120): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const time = (iso: string | undefined): number | undefined => {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
/** "working 3m" / "idle 20s": the state and how long it has held. */
const held = (mate: Teammate, now: number): string => {
  if (!mate.online) return 'offline';
  if (!mate.activity) return 'online';
  return `${mate.activity.state} ${ago(time(mate.activity.since), now).replace(/ ago$/, '')}`;
};
const look = (mate: Teammate): [string, Tone] =>
  !mate.online ? [SYMBOL.idle, 'dim'] : mate.activity?.state === 'working' ? [SYMBOL.active, 'accent'] : [SYMBOL.idle, 'success'];
const logLine = (entry: LogEntry, now: number): string => `${ago(time(entry.at), now).padEnd(8)} ${entry.from} → ${entry.to} ${entry.kind}: ${one(entry.body, 160)}`;

/** The team, one row per teammate with live activity; the message trace in detail. */
export function teamPanelSpec(ops: TeamPanelOps, initial: TeamSnapshot): PanelSpec {
  const cell: { value: TeamSnapshot } = { value: initial };
  const listeners = new Set<() => void>();
  const reload = async (): Promise<void> => {
    cell.value = await ops.load();
    for (const listener of listeners) listener();
  };
  const mate = (item: PanelItem | undefined): Teammate | undefined =>
    item?.id.startsWith(MATE) ? cell.value.mates.find(entry => entry.role === item.id.slice(MATE.length)) : undefined;
  const team = (item: PanelItem | undefined): string | undefined => item?.id.startsWith(JOIN) ? item.id.slice(JOIN.length) : undefined;

  const actions: PanelAction[] = [
    {
      key: 'm', label: item => `Message ${mate(item)?.role ?? ''}`.trim(),
      when: item => { const found = mate(item); return !!found && found.online && !found.self; },
      run: (item, panel) => { panel.close(); ops.compose(`/team send ${mate(item)!.role} `); },
    },
    {
      key: 'l', label: 'Leave team', confirm: true,
      when: () => !!cell.value.joined,
      run: async (_item, panel) => { const text = await ops.leave(); await reload(); panel.notice(text, 'success'); },
    },
  ];

  return {
    title: 'Team',
    summary: () => {
      const { joined, mates } = cell.value;
      if (!joined) return `not in a team · ${cell.value.teams.length} team${cell.value.teams.length === 1 ? '' : 's'}`;
      const online = mates.filter(entry => entry.online);
      const working = online.filter(entry => entry.activity?.state === 'working').length;
      return `${joined.team} · you are ${joined.role} · ${online.length} online · ${working} working`;
    },
    items: () => {
      const { joined, mates, teams } = cell.value;
      const now = ops.now();
      if (!joined) {
        return teams.map((entry): PanelItem => ({
          id: `${JOIN}${entry.team}`, label: entry.team, symbol: entry.online ? SYMBOL.active : SYMBOL.idle,
          tone: entry.online ? 'success' : 'dim', meta: `${entry.online}/${entry.total} online`,
        }));
      }
      return [
        { id: TEAM, label: joined.team, symbol: SYMBOL.mode, tone: 'accent', meta: `${cell.value.log.length} messages` },
        ...mates.map((entry): PanelItem => {
          const [symbol, tone] = look(entry);
          return { id: `${MATE}${entry.role}`, label: `${entry.role}${entry.self ? ' (you)' : ''}`, symbol, tone, meta: held(entry, now), search: entry.activity?.focus ?? '' };
        }),
      ];
    },
    detail: item => {
      const now = ops.now();
      const found = mate(item);
      if (found) {
        const talk = [...cell.value.log].reverse().filter(entry => entry.from === found.role || entry.to === found.role);
        return {
          title: `${found.role}${found.self ? ' (you)' : ''}`,
          subtitle: held(found, now), subtitleTone: look(found)[1],
          fields: [
            { label: 'on', value: found.activity?.focus ? one(found.activity.focus, 400) : '—' },
            { label: 'cwd', value: found.cwd },
          ],
          sections: [{ title: `Messages (${talk.length})`, lines: talk.map(entry => logLine(entry, now)) }],
        };
      }
      const joining = team(item);
      if (joining) {
        const entry = cell.value.teams.find(candidate => candidate.team === joining);
        return {
          title: joining,
          subtitle: `${entry?.online ?? 0} of ${entry?.total ?? 0} online`,
          fields: [{ label: 'join', value: `Enter, then type your role: /team join ${joining} <role>` }],
        };
      }
      const { joined, mates } = cell.value;
      return {
        title: joined?.team ?? 'team',
        subtitle: 'Messages are delivered now or refused now. Nothing queues.',
        fields: [
          { label: 'you', value: joined?.role ?? '—' },
          { label: 'online', value: mates.filter(entry => entry.online).map(entry => entry.role).join(', ') || '—' },
          { label: 'offline', value: mates.filter(entry => !entry.online).map(entry => entry.role).join(', ') || '—' },
        ],
        sections: [{ title: 'Recent messages', lines: [...cell.value.log].reverse().map(entry => logLine(entry, now)) }],
      };
    },
    actions,
    activate: {
      label: 'Join',
      when: item => !!team(item),
      run: (item, panel) => { panel.close(); ops.compose(`/team join ${team(item)!} `); },
    },
    empty: 'No teams yet. Type /team join <team> <role> to create one.',
    subscribe: listener => {
      listeners.add(listener);
      const timer = setInterval(() => { void reload().catch(() => undefined); }, 1000);
      timer.unref?.();
      return () => { listeners.delete(listener); clearInterval(timer); };
    },
    ...(initial.joined ? { initial: TEAM } : {}),
  };
}
