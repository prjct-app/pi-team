import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { inspectProcess, sameProcess, type ProcessIdentity } from '../process-identity.ts';
import { DispatchSchema, LIMITS, bounded, metadata, normalizeTag, terminalAssignment, terminalRun,
  type Assignment, type Dispatch, type Expert, type Owner, type Run, type TeamState } from './domain.ts';
import { DynamicStore, type Project } from './store.ts';

export type ExpertExecution = { readonly teamId: string; readonly projectPath: string; readonly owner: Owner; readonly expert: Expert; readonly assignment: Assignment };
export type ExpertOutcome = { readonly status: 'completed' | 'failed' | 'cancelled'; readonly summary: string; readonly stopped: boolean };
export interface ExpertRunner {
  run(input: ExpertExecution, signal: AbortSignal): Promise<ExpertOutcome>;
  close(): Promise<void>;
}
export type ServiceOptions = {
  readonly sessionId: string;
  readonly identity: ProcessIdentity;
  readonly instanceId?: string;
  readonly now?: () => number;
  readonly ownerAlive?: (owner: Owner) => Promise<boolean>;
  readonly onRun?: (run: Run, state: TeamState) => void;
  readonly onResult?: (assignment: Assignment) => void;
};
export async function ownerAlive(owner: Owner): Promise<boolean> {
  const identity = await inspectProcess(owner.processPid);
  if (identity) return sameProcess(owner, identity);
  // Inability to inspect is not proof of death (permissions/platform failure).
  try { process.kill(owner.processPid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
const owns = (state: TeamState, owner?: Owner): boolean => !!owner && state.owner?.instanceId === owner.instanceId && state.owner.epoch === owner.epoch;
const timestamp = (now: () => number): string => new Date(now()).toISOString();

function prune(state: TeamState): TeamState {
  const removable = state.runs.filter(run => terminalRun(run) && !state.assignments.some(a => a.runId === run.id && a.status === 'cancelled_waiting'));
  const remove = new Set(removable.slice(0, Math.max(0, state.runs.length - LIMITS.runs + 1)).map(run => run.id));
  const assignments = state.assignments.filter(a => !remove.has(a.runId));
  const excess = Math.max(0, assignments.length - LIMITS.assignments + 1);
  const old = new Set(assignments.filter(a => terminalAssignment(a) && a.status !== 'cancelled_waiting').slice(0, excess).map(a => a.id));
  return { ...state, runs: state.runs.filter(run => !remove.has(run.id)), assignments: assignments.filter(a => !old.has(a.id)) };
}

export class DynamicTeamService {
  private owner?: Owner;
  private closed = false;
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly now: () => number;
  private readonly instanceId: string;
  constructor(readonly store: DynamicStore, readonly project: Project, readonly runner: ExpertRunner, private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.instanceId = options.instanceId ?? randomUUID();
  }
  get isOwner(): boolean { return !!this.owner && !this.closed; }
  snapshot(): Promise<TeamState | undefined> { return this.store.read(this.project.teamId); }
  private assertOwner(state: TeamState | undefined): asserts state is TeamState {
    if (this.closed || !state || !owns(state, this.owner)) throw new Error('Run owner is fenced; use /team doctor.');
  }
  async submit(objective: string): Promise<Run> {
    if (this.closed) throw new Error('Team session is shutting down.');
    bounded(objective, 8192, 'Objective');
    if (!objective.trim()) throw new Error('An objective is required.');
    const at = timestamp(this.now);
    const run: Run = { id: randomUUID(), objective: metadata(objective, 8192), summary: '', status: 'queued', createdAt: at, updatedAt: at };
    const result = await this.store.update(this.project, async current => {
      const state = prune(current ?? {
        schemaVersion: 1, teamId: this.project.teamId, projectPath: this.project.path, epoch: 0,
        orchestrator: { summary: '' }, experts: [], assignments: [], runs: [], createdAt: at, updatedAt: at,
      });
      if (state.runs.length >= LIMITS.runs) throw new Error('Run queue quota reached. Cancel queued Runs first.');
      const claim = !state.owner || owns(state, this.owner) || !await (this.options.ownerAlive ?? ownerAlive)(state.owner);
      if (!claim) return { state: { ...state, runs: [...state.runs, run], updatedAt: at }, result: undefined };
      const owner: Owner = owns(state, this.owner) ? this.owner! : {
        ...this.options.identity, sessionId: this.options.sessionId, instanceId: this.instanceId, epoch: state.epoch + 1,
      };
      const interrupted = !owns(state, this.owner);
      const abandoned = state.assignments.filter(a => a.status === 'running');
      return { state: {
        ...state, owner, epoch: owner.epoch, updatedAt: at,
        orchestrator: { ...state.orchestrator, lastSessionId: owner.sessionId },
        runs: [...state.runs.map(r => interrupted && r.status === 'active' ? {
          ...r, status: 'interrupted' as const, summary: 'Previous owner ended; no automatic retry.', updatedAt: at, endedAt: at,
        } : r), run],
        assignments: state.assignments.map(a => interrupted && !terminalAssignment(a) ? {
          ...a, status: a.status === 'running' ? 'cancelled_waiting' as const : 'cancelled' as const,
          task: '', error: 'Previous owner ended; execution is not retried.', updatedAt: at, endedAt: at,
        } : a),
        experts: state.experts.map(e => interrupted && abandoned.some(a => a.expertId === e.id) ? { ...e, status: 'blocked' as const, updatedAt: at } : e),
      }, result: owner };
    });
    if (result) this.owner = result;
    return run;
  }
  async tick(startRun = true): Promise<void> {
    if (!this.isOwner) return;
    if (startRun) {
      const activated = await this.store.update(this.project, state => {
        this.assertOwner(state);
        if (state.runs.some(r => r.status === 'active')) return { state, result: undefined };
        const next = state.runs.find(r => r.status === 'queued');
        if (!next) return { state, result: undefined };
        const at = timestamp(this.now);
        const run: Run = { ...next, status: 'active', startedAt: at, updatedAt: at };
        const updated = { ...state, runs: state.runs.map(r => r.id === run.id ? run : r), updatedAt: at };
        return { state: updated, result: { run, state: updated } };
      });
      if (activated) {
        try { this.options.onRun?.(activated.run, activated.state); }
        catch { await this.cancelRun(activated.run.id, 'Orchestrator turn could not start; no retry.'); }
      }
    }
    await this.pump();
  }
  async dispatch(input: Dispatch): Promise<{ expertId: string; sessionRef: string; assignmentId: string; decision: 'created' | 'reused' }> {
    if (!Value.Check(DispatchSchema, input)) throw new Error('Invalid dispatch.');
    bounded(input.task, 8192, 'Task'); bounded(input.instructions ?? '', 4096, 'Instructions');
    const role = normalizeTag(input.role);
    const capabilities = [...new Set(input.capabilities.map(normalizeTag))].sort();
    const result = await this.store.update(this.project, current => {
      this.assertOwner(current);
      const state = prune(current);
      const run = state.runs.find(r => r.status === 'active');
      if (!run) throw new Error('No active Run. Start with /team <objective>.');
      if (state.assignments.length >= LIMITS.assignments) throw new Error('Assignment quota reached.');
      const candidates = state.experts.filter(e => capabilities.every(c => e.capabilities.includes(c)))
        .sort((a, b) => Number(b.role === role) - Number(a.role === role) || a.id.localeCompare(b.id));
      const sameRole = state.experts.find(e => e.role === role);
      const existing = sameRole ?? candidates[0];
      if (existing && !capabilities.every(c => existing.capabilities.includes(c))) throw new Error('Existing role lacks these capabilities; duplicate-role capacity is disabled.');
      if (existing && (existing.policy.tools.length !== input.policy.tools.length || input.policy.tools.some(t => !existing.policy.tools.includes(t)))) {
        throw new Error('Existing Expert tool policy differs; implicit policy changes are forbidden.');
      }
      if (!existing && state.experts.length >= LIMITS.experts) throw new Error('Expert registry quota reached.');
      const at = timestamp(this.now);
      const expert: Expert = existing ?? {
        id: randomUUID(), role, capabilities, instructions: metadata(input.instructions ?? ''), policy: input.policy,
        sessionRef: randomUUID(), generation: 0, status: 'idle', memory: '', history: [], createdAt: at, updatedAt: at,
      };
      if (expert.status === 'blocked') throw new Error('Expert has unresolved execution; /team doctor. No duplicate will be created.');
      const assignment: Assignment = {
        id: randomUUID(), runId: run.id, expertId: expert.id, generation: 0, ownerEpoch: this.owner!.epoch,
        status: 'queued', task: metadata(input.task, 8192), result: '', error: '', createdAt: at, updatedAt: at,
      };
      const updatedExpert = { ...expert, history: [...expert.history, assignment.id].slice(-LIMITS.history), updatedAt: at };
      return { state: { ...state,
        experts: existing ? state.experts.map(e => e.id === expert.id ? updatedExpert : e) : [...state.experts, updatedExpert],
        assignments: [...state.assignments, assignment], updatedAt: at,
      }, result: { expertId: expert.id, sessionRef: expert.sessionRef, assignmentId: assignment.id, decision: existing ? 'reused' as const : 'created' as const } };
    });
    await this.pump();
    return result;
  }
  private async pump(): Promise<void> {
    if (!this.isOwner) return;
    const launches = await this.store.update(this.project, state => {
      this.assertOwner(state);
      const active = state.runs.find(r => r.status === 'active');
      const free = LIMITS.concurrent - state.experts.filter(e => e.status === 'busy' || e.status === 'blocked').length;
      const selected: Assignment[] = [];
      const writerBusy = state.experts.some(e => e.status === 'busy' && e.policy.tools.some(tool => ['edit', 'write', 'bash'].includes(tool)));
      for (const a of state.assignments) {
        const expert = state.experts.find(e => e.id === a.expertId);
        const writer = expert?.policy.tools.some(tool => ['edit', 'write', 'bash'].includes(tool)) ?? false;
        if (selected.length >= free) break;
        if (a.runId === active?.id && a.status === 'queued' && expert?.status === 'idle' &&
            !selected.some(s => s.expertId === a.expertId) && !(writer && (writerBusy || selected.some(s => {
              const candidate = state.experts.find(e => e.id === s.expertId);
              return candidate?.policy.tools.some(tool => ['edit', 'write', 'bash'].includes(tool));
            })))) selected.push(a);
      }
      const at = timestamp(this.now);
      const experts = state.experts.map(e => selected.some(a => a.expertId === e.id) ? { ...e, generation: e.generation + 1, status: 'busy' as const, updatedAt: at } : e);
      const assignments = state.assignments.map(a => selected.some(s => s.id === a.id) ? {
        ...a, generation: experts.find(e => e.id === a.expertId)!.generation, status: 'running' as const, updatedAt: at,
      } : a);
      const executions = assignments.filter(a => selected.some(s => s.id === a.id)).map(assignment => ({
        teamId: state.teamId, projectPath: state.projectPath, owner: this.owner!, expert: experts.find(e => e.id === assignment.expertId)!, assignment,
      }));
      return { state: { ...state, experts, assignments, updatedAt: at }, result: executions };
    });
    for (const execution of launches) {
      if (!this.isOwner) break;
      const controller = new AbortController();
      // The durable running transition precedes model exposure. Even a crash here never retries it.
      const promise = Promise.resolve().then(() => this.runner.run(execution, controller.signal))
        .catch((): ExpertOutcome => ({ status: 'failed', summary: 'Worker execution failed; inspect /team doctor.', stopped: false }))
        .then(outcome => this.settle(execution.assignment, outcome))
        .catch(() => {})
        .finally(() => { this.executions.delete(execution.assignment.id); });
      this.executions.set(execution.assignment.id, { controller, promise });
    }
  }
  private async settle(original: Assignment, outcome: ExpertOutcome): Promise<void> {
    const settled = await this.store.update(this.project, state => {
      if (!state || !owns(state, this.owner)) return { state: state!, result: undefined };
      const assignment = state.assignments.find(a => a.id === original.id);
      const expert = state.experts.find(e => e.id === original.expertId);
      if (!assignment || !expert || assignment.generation !== original.generation || expert.generation !== original.generation || assignment.ownerEpoch !== this.owner?.epoch) return { state, result: undefined };
      const at = timestamp(this.now);
      if (terminalAssignment(assignment)) {
        // A proved stop can release capacity, but a late result never changes the cancelled outcome.
        if (assignment.status !== 'cancelled_waiting' || !outcome.stopped) return { state, result: undefined };
        return { state: { ...state,
          assignments: state.assignments.map(a => a.id === assignment.id ? { ...a, status: 'cancelled' as const, updatedAt: at } : a),
          experts: state.experts.map(e => e.id === expert.id ? { ...e, status: 'idle' as const, updatedAt: at } : e),
        }, result: undefined };
      }
      if (state.runs.find(r => r.id === assignment.runId)?.status !== 'active') return { state, result: undefined };
      const success = outcome.status === 'completed' && outcome.stopped;
      const next: Assignment = { ...assignment, task: '', status: success ? 'completed' : 'failed',
        result: success ? metadata(outcome.summary) : '', error: success ? '' : metadata(outcome.summary, 512), endedAt: at, updatedAt: at };
      return { state: { ...state, updatedAt: at,
        assignments: state.assignments.map(a => a.id === next.id ? next : a),
        experts: state.experts.map(e => e.id === expert.id ? { ...e, status: outcome.stopped ? 'idle' as const : 'blocked' as const,
          memory: success ? next.result : e.memory, updatedAt: at } : e),
      }, result: next };
    });
    if (settled && !this.closed) this.options.onResult?.(settled);
    if (!this.closed) await this.pump();
  }
  async finish(summary: string): Promise<void> {
    bounded(summary, 4096, 'Summary');
    await this.store.update(this.project, state => {
      this.assertOwner(state);
      const run = state.runs.find(r => r.status === 'active');
      if (!run) throw new Error('No active Run.');
      if (state.assignments.some(a => a.runId === run.id && (!terminalAssignment(a) || a.status === 'cancelled_waiting'))) throw new Error('Assignments remain outstanding; finish is blocked.');
      const at = timestamp(this.now);
      return { state: { ...state, updatedAt: at, orchestrator: { ...state.orchestrator, summary: metadata(summary) },
        runs: state.runs.map(r => r.id === run.id ? { ...r, status: 'completed' as const, summary: metadata(summary), updatedAt: at, endedAt: at } : r),
      }, result: undefined };
    });
  }
  async cancelAssignment(id: string, reason = 'Cancelled by orchestrator.'): Promise<void> {
    await this.store.update(this.project, state => {
      this.assertOwner(state);
      const a = state.assignments.find(a => a.id === id);
      if (!a) throw new Error('Unknown assignment.');
      if (terminalAssignment(a)) return { state, result: undefined };
      const at = timestamp(this.now);
      return { state: { ...state, updatedAt: at,
        assignments: state.assignments.map(item => item.id === id ? { ...item, status: a.status === 'running' ? 'cancelled_waiting' as const : 'cancelled' as const,
          task: '', error: metadata(reason, 512), updatedAt: at, endedAt: at } : item),
        experts: state.experts.map(e => e.id === a.expertId && a.status === 'running' ? { ...e, status: 'blocked' as const, updatedAt: at } : e),
      }, result: undefined };
    });
    this.executions.get(id)?.controller.abort();
  }
  async cancelRun(id?: string, reason = 'Cancelled by user.'): Promise<void> {
    const cancelled = await this.store.update(this.project, state => {
      this.assertOwner(state);
      const run = id ? state.runs.find(r => r.id === id) : state.runs.find(r => r.status === 'active');
      if (!run) throw new Error('Unknown Run.');
      if (terminalRun(run)) return { state, result: [] as string[] };
      const at = timestamp(this.now);
      const targets = state.assignments.filter(a => a.runId === run.id && !terminalAssignment(a));
      return { state: { ...state, updatedAt: at,
        runs: state.runs.map(r => r.id === run.id ? { ...r, status: 'cancelled' as const, summary: metadata(reason), updatedAt: at, endedAt: at } : r),
        assignments: state.assignments.map(a => targets.some(t => t.id === a.id) ? { ...a, task: '',
          status: a.status === 'running' ? 'cancelled_waiting' as const : 'cancelled' as const,
          error: metadata(reason, 512), updatedAt: at, endedAt: at } : a),
        experts: state.experts.map(e => targets.some(a => a.expertId === e.id && a.status === 'running') ? { ...e, status: 'blocked' as const, updatedAt: at } : e),
      }, result: targets.map(a => a.id) };
    });
    for (const assignmentId of cancelled) this.executions.get(assignmentId)?.controller.abort();
  }
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    const state = await this.snapshot();
    if (state && owns(state, this.owner)) {
      const active = state.runs.find(r => r.status === 'active');
      if (active) await this.cancelRun(active.id, `Session ${reason}; safe interruption, no automatic retry.`);
    }
    this.closed = true;
    for (const execution of this.executions.values()) execution.controller.abort();
    try {
      await this.runner.close();
      await Promise.all([...this.executions.values()].map(execution => execution.promise));
    } finally {
      if (this.owner) await this.store.update(this.project, current => {
        if (!current || !owns(current, this.owner)) return { state: current!, result: undefined };
        const { owner: _owner, ...retained } = current;
        return { state: { ...retained, epoch: current.epoch + 1, updatedAt: timestamp(this.now) }, result: undefined };
      });
      this.owner = undefined;
    }
  }
}
