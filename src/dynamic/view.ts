import { metadata, LIMITS, type TeamState } from './domain.ts';

/** Explicit projection only: never serialize owner, lease, control, or process tokens. */
export function teamView(state: TeamState | undefined, mode: 'status' | 'history' | 'doctor' = 'status'): string {
  if (!state) return 'No project Team yet. Start with /team <objective>.';
  const runs = mode === 'history' ? state.runs.slice(-20) : state.runs.filter(r => ['active', 'queued'].includes(r.status)).slice(0, 20);
  const lines = [
    `Team ${state.teamId}`,
    `Runs: ${state.runs.length} | Experts: ${state.experts.length} | Parallel limit: ${LIMITS.concurrent}`,
    ...runs.map(r => `Run ${r.id} [${r.status}] ${metadata(r.objective, 160).replace(/\s+/g, ' ')}`),
    ...state.experts.map(e => `Expert ${e.id} ${e.role} [${e.status}] generation ${e.generation} | history ${e.history.length}`),
    ...state.assignments.slice(-20).map(a => `Assignment ${a.id} [${a.status}] expert ${a.expertId}`),
  ];
  if (mode === 'doctor') lines.push(
    `Owner: ${state.owner ? 'recorded (not a liveness guarantee)' : 'none'} | epoch ${state.epoch}`,
    `Blocked experts: ${state.experts.filter(e => e.status === 'blocked').length}`,
    'Production execution requires authenticated Pi and tmux. No automatic retry or worker adoption.',
    'Blocked execution requires manual process-identity verification; never signal by name or unverified PID.',
  );
  return metadata(lines.join('\n'), 16384);
}
