import { SYMBOL, ago, type PanelAction, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import { LIMITS, metadata, type Assignment, type Expert, type Run, type TeamState } from './domain.ts';

/** What the /team panel can ask of the extension. */
export type TeamOps = Readonly<{
  load(): Promise<TeamState | undefined>;
  /** Whether this session owns the project Team and may cancel Runs. */
  isOwner(): boolean;
  cancel(runId: string): Promise<string>;
  /** Close the panel and put "/team " in the editor for a new objective. */
  compose(): void;
}>;

const TEAM = 'team';
const RUN = 'run:';
const EXPERT = 'expert:';
const one = (text: string, max = 160): string => metadata(text, max).replace(/\s+/g, ' ').trim();
const time = (iso: string | undefined): number | undefined => {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const RUN_TONE: Record<Run['status'], [string, Tone]> = {
  active: [SYMBOL.active, 'accent'], queued: [SYMBOL.idle, 'muted'], completed: [SYMBOL.ok, 'success'],
  cancelled: [SYMBOL.idle, 'dim'], interrupted: [SYMBOL.attention, 'warning'],
};
const EXPERT_TONE: Record<Expert['status'], [string, Tone]> = {
  busy: [SYMBOL.active, 'accent'], idle: [SYMBOL.idle, 'muted'], blocked: [SYMBOL.attention, 'warning'],
};
const ASSIGNMENT_MARK: Record<Assignment['status'], string> = {
  queued: SYMBOL.idle, running: SYMBOL.active, completed: SYMBOL.ok, failed: SYMBOL.error, cancelled: SYMBOL.idle, cancelled_waiting: SYMBOL.attention,
};

/** Runs (newest first) and Experts, with every assignment traceable from both sides. */
export function teamPanelSpec(ops: TeamOps, initial: TeamState | undefined): PanelSpec {
  const state = { team: initial };
  const listeners = new Set<() => void>();
  const reload = async (): Promise<void> => { state.team = await ops.load(); for (const listener of listeners) listener(); };
  const run = (item: PanelItem | undefined) => item?.id.startsWith(RUN) ? state.team?.runs.find(entry => entry.id === item.id.slice(RUN.length)) : undefined;
  const expert = (id: string) => state.team?.experts.find(entry => entry.id === id);
  const assignmentLine = (assignment: Assignment, by: 'run' | 'expert'): string => {
    const who = by === 'run' ? expert(assignment.expertId)?.role ?? assignment.expertId : state.team?.runs.find(entry => entry.id === assignment.runId)?.id ?? assignment.runId;
    const outcome = assignment.error ? ` · ${one(assignment.error, 80)}` : assignment.result ? ` · ${one(assignment.result, 80)}` : '';
    return `${ASSIGNMENT_MARK[assignment.status]} ${assignment.status.padEnd(9)} ${one(who, 32)} · ${one(assignment.task, 60)}${outcome}`;
  };

  const actions: PanelAction[] = [
    { key: 'n', label: 'New objective', run: (_item, panel) => { panel.close(); ops.compose(); } },
    {
      key: 'c', label: 'Cancel run', confirm: true,
      when: item => { const found = run(item); return !!found && ['active', 'queued'].includes(found.status) && ops.isOwner(); },
      run: async (item, panel) => { const text = await ops.cancel(run(item)!.id); await reload(); panel.notice(text, 'success'); },
    },
  ];

  return {
    title: 'Team',
    summary: () => {
      const team = state.team;
      if (!team) return 'no Team yet';
      const active = team.runs.filter(entry => entry.status === 'active').length;
      const queued = team.runs.filter(entry => entry.status === 'queued').length;
      const busy = team.experts.filter(entry => entry.status === 'busy').length;
      return `${active} active · ${queued} queued · ${busy}/${team.experts.length} experts busy`;
    },
    items: () => {
      const team = state.team;
      if (!team) return [];
      const blocked = team.experts.filter(entry => entry.status === 'blocked').length;
      return [
        { id: TEAM, label: 'team', symbol: blocked ? SYMBOL.attention : SYMBOL.active, tone: blocked ? 'warning' : 'success', meta: team.owner ? 'owned' : 'no owner' },
        ...[...team.runs].reverse().map((entry): PanelItem => {
          const [symbol, tone] = RUN_TONE[entry.status];
          return { id: `${RUN}${entry.id}`, label: one(entry.objective, 60), symbol, tone, meta: `${entry.status} · ${ago(time(entry.updatedAt))}`, search: entry.id };
        }),
        ...team.experts.map((entry): PanelItem => {
          const [symbol, tone] = EXPERT_TONE[entry.status];
          return { id: `${EXPERT}${entry.id}`, label: `expert · ${one(entry.role, 40)}`, symbol, tone, meta: entry.status, search: entry.capabilities.join(' ') };
        }),
      ];
    },
    detail: item => {
      const team = state.team!;
      const found = run(item);
      if (found) {
        const work = team.assignments.filter(entry => entry.runId === found.id).reverse();
        return {
          title: one(found.objective, 200),
          subtitle: found.status, subtitleTone: RUN_TONE[found.status][1],
          fields: [
            { label: 'run', value: found.id },
            { label: 'started', value: found.startedAt ? ago(time(found.startedAt)) : 'not yet' },
            ...(found.endedAt ? [{ label: 'ended', value: ago(time(found.endedAt)) }] : []),
            ...(found.summary ? [{ label: 'summary', value: one(found.summary, 600) }] : []),
          ],
          sections: [{ title: `Assignments (${work.length})`, lines: work.map(entry => assignmentLine(entry, 'run')) }],
        };
      }
      if (item.id.startsWith(EXPERT)) {
        const person = expert(item.id.slice(EXPERT.length))!;
        const work = team.assignments.filter(entry => entry.expertId === person.id).reverse();
        return {
          title: one(person.role, 80),
          subtitle: person.status, subtitleTone: EXPERT_TONE[person.status][1],
          fields: [
            { label: 'expert', value: person.id },
            { label: 'can', value: person.capabilities.join(', ') || '—' },
            { label: 'generation', value: String(person.generation) },
            { label: 'updated', value: ago(time(person.updatedAt)) },
            ...(person.memory ? [{ label: 'memory', value: one(person.memory, 400) }] : []),
          ],
          sections: [{ title: `Assignments (${work.length})`, lines: work.map(entry => assignmentLine(entry, 'expert')) }],
        };
      }
      const blocked = team.experts.filter(entry => entry.status === 'blocked').length;
      return {
        title: 'team',
        subtitle: blocked ? `${blocked} blocked expert${blocked === 1 ? '' : 's'} need manual process verification.` : 'Healthy.',
        subtitleTone: blocked ? 'warning' : 'success',
        fields: [
          { label: 'team', value: team.teamId },
          { label: 'owner', value: team.owner ? `recorded · epoch ${team.epoch} (not a liveness guarantee)` : 'none' },
          { label: 'this session', value: ops.isOwner() ? 'owner' : 'observer' },
          { label: 'parallel', value: `up to ${LIMITS.concurrent} experts` },
          { label: 'runs', value: String(team.runs.length) },
          { label: 'experts', value: String(team.experts.length) },
        ],
        sections: [
          ...(team.orchestrator.summary ? [{ title: 'Orchestrator', lines: [one(team.orchestrator.summary, 800)] }] : []),
          { title: 'Recent assignments', lines: team.assignments.slice(-10).reverse().map(entry => assignmentLine(entry, 'run')) },
        ],
      };
    },
    actions,
    empty: 'No Team for this project yet. Press n, or type /team <objective>.',
    subscribe: listener => {
      listeners.add(listener);
      const timer = setInterval(() => { void reload().catch(() => undefined); }, 2000);
      timer.unref?.();
      return () => { listeners.delete(listener); clearInterval(timer); };
    },
  };
}
