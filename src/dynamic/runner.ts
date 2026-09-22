import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateTree, createAtomicJson } from '../storage/atomic.ts';
import { TeamPaths } from '../storage/paths.ts';
import { TeamRuntime } from '../runtime/team-runtime.ts';
import type { Lease } from '../domain/lease.ts';
import type { Membership } from '../runtime/membership.ts';
import { TeamSupervisor, type SupervisorOptions } from '../supervisor/supervisor.ts';
import type { ExpertExecution, ExpertOutcome, ExpertRunner } from './service.ts';
import { DynamicStore } from './store.ts';
import { metadata } from './domain.ts';
import { expertWorkspace, isGitCheckout } from './workspace.ts';
import { expertMemory, expertStance, type ExpertStance } from './memory.ts';

export type SupervisorPort = Pick<TeamSupervisor, 'launch' | 'stop' | 'close' | 'owner'>;
type RunnerSetup = { readonly membership: Membership; readonly supervisor: SupervisorPort };
export type RunnerOptions = {
  readonly runtime?: TeamRuntime;
  readonly supervisor?: (options: SupervisorOptions) => SupervisorPort;
  readonly command?: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  /** Where a write-capable Expert works. Defaults to its own Git worktree when the project is a checkout. */
  readonly workspace?: (input: ExpertExecution) => Promise<string>;
  /** Project memory for the Expert's stance and task. Defaults to the view pi-memory publishes. */
  readonly memory?: (stance: ExpertStance, query: string) => Promise<string>;
};
const WRITE_TOOLS = ['edit', 'write', 'bash'];
// The compiled local build ships index.js; source checkouts execute index.ts directly.
const ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../index.ts' : '../../index.js', import.meta.url));

/**
 * Why an Expert did not start, safe to show: a failed child command's message
 * repeats its arguments (tmux -e carries control and lease tokens), so it is
 * replaced, and anything token-shaped is masked.
 */
export function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  const text = /Command failed|spawn|tmux\s/i.test(error.message) ? 'tmux could not start the Expert session' : error.message;
  return metadata(`${text.replace(/[A-Za-z0-9_+/=-]{32,}/g, '…')}${typeof code === 'string' ? ` (${code})` : ''}`, 240);
}

/** Durable request/reply transport; a launch or a model turn alone is never success. */
export class ProductionExpertRunner implements ExpertRunner {
  readonly runtime: TeamRuntime;
  private setup?: Promise<RunnerSetup>;
  private refresh?: Promise<RunnerSetup>;
  private readonly closing = new AbortController();
  private readonly pending = new Set<Promise<ExpertOutcome>>();
  constructor(readonly store: DynamicStore, private readonly options: RunnerOptions = {}) {
    this.runtime = options.runtime ?? new TeamRuntime(new TeamPaths(join(store.root, 'transport')));
  }
  private initialize(input: ExpertExecution) {
    return this.setup ??= (async () => {
      const at = new Date().toISOString();
      if (!await this.runtime.teams.read(input.teamId)) {
        await this.runtime.teams.create({ schemaVersion: 2, teamId: input.teamId, state: 'open', createdAt: at, updatedAt: at });
      }
      const membership = await this.runtime.memberships.join({ teamId: input.teamId, alias: 'orchestrator',
        sessionId: input.owner.sessionId, cwd: input.projectPath, kind: 'external' });
      const options: SupervisorOptions = { teamId: input.teamId, ownerSessionId: input.owner.sessionId,
        ownerInstanceId: input.owner.instanceId, ownerEpoch: input.owner.epoch,
        paths: this.runtime.paths, teams: this.runtime.teams, runtimes: this.runtime.runtimes };
      return { membership, supervisor: this.options.supervisor?.(options) ?? new TeamSupervisor(options) };
    })();
  }
  private async activeSetup(input: ExpertExecution): Promise<RunnerSetup> {
    const setup = await this.initialize(input);
    try {
      await this.runtime.memberships.heartbeat(setup.membership);
      return setup;
    } catch (error) {
      if ((error as { code?: string }).code !== 'FENCED') throw error;
      this.refresh ??= (async () => {
        const membership = await this.runtime.memberships.join({ teamId: input.teamId, alias: 'orchestrator',
          sessionId: input.owner.sessionId, cwd: input.projectPath, kind: 'external' });
        const refreshed = { ...setup, membership };
        this.setup = Promise.resolve(refreshed);
        return refreshed;
      })().finally(() => { this.refresh = undefined; });
      return this.refresh;
    }
  }
  private readonly defaultWorkspace = async (input: ExpertExecution): Promise<string> =>
    await isGitCheckout(input.projectPath)
      ? expertWorkspace({ root: this.store.root, teamId: input.teamId, expertId: input.expert.id, projectPath: input.projectPath })
      : input.projectPath;
  run(input: ExpertExecution, signal: AbortSignal): Promise<ExpertOutcome> {
    const operation = this.execute(input, AbortSignal.any([signal, this.closing.signal, AbortSignal.timeout(this.options.timeoutMs ?? 600_000)]));
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }
  private async execute(input: ExpertExecution, signal: AbortSignal): Promise<ExpertOutcome> {
    const state: { runtimeId?: string; requestId?: string; peer?: Membership; supervisor?: SupervisorPort; owner?: Membership;
      resource?: Lease; outcome: ExpertOutcome } = { outcome: { status: 'failed', summary: 'Expert execution failed; inspect /team doctor.', stopped: false } };
    try {
      signal.throwIfAborted();
      const { membership, supervisor } = await this.activeSetup(input);
      state.owner = membership; state.supervisor = supervisor;
      await ensurePrivateTree(this.store.root, 'projects', input.teamId, 'sessions');
      const session = this.store.sessionPath(input.teamId, input.expert.sessionRef);
      const info = await lstat(session).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (info && (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)) throw new Error('Unsafe Expert session.');
      const writer = input.expert.policy.tools.some(tool => WRITE_TOOLS.includes(tool));
      const cwd = writer ? await (this.options.workspace ?? this.defaultWorkspace)(input) : input.projectPath;
      if (!info) await createAtomicJson(session, { type: 'session', version: 3, id: input.expert.sessionRef,
        timestamp: new Date().toISOString(), cwd });
      state.peer = await this.runtime.memberships.join({ teamId: input.teamId, alias: `e-${input.expert.id}`,
        sessionId: input.expert.sessionRef, cwd, kind: 'supervised' });
      if (writer) {
        state.resource = await this.runtime.resources.claim(state.peer, '.', undefined, signal);
      }
      signal.throwIfAborted();
      const command: readonly [string, ...string[]] = this.options.command ?? (process.argv[1]
        ? [process.execPath, process.argv[1]] : ['pi']);
      const launched = await supervisor.launch({ memberId: state.peer.memberId, cwd,
        workerMembership: state.peer, autoRequests: true, environment: this.options.environment ?? process.env,
        command: [...command,
          '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
          '--extension', ENTRY, '--team-store', this.store.root,
          '--session', session, '--tools', [...input.expert.policy.tools, 'team_reply', 'team_peers', 'team_message'].join(','),
          '--name', `expert:${input.expert.role}`] as [string, ...string[]] });
      state.runtimeId = launched.runtimeId;
      signal.throwIfAborted();
      const memory = await (this.options.memory ?? expertMemory)(expertStance(input.expert.role, input.expert.policy.tools),
        input.assignment.task).catch(() => '');
      signal.throwIfAborted();
      const request = await this.runtime.requests.send(membership, { to: state.peer.alias, kind: 'request',
        body: JSON.stringify({ assignmentId: input.assignment.id, generation: input.assignment.generation,
          ownerEpoch: input.assignment.ownerEpoch, task: input.assignment.task, ...(memory ? { memory } : {}) }), signal });
      state.requestId = request.messageId;
      const heartbeat = { at: 0 };
      while (!signal.aborted) {
        if (Date.now() - heartbeat.at >= 10_000) {
          await this.runtime.memberships.heartbeat(membership);
          if (state.resource && state.peer) state.resource = await this.runtime.resources.renew(state.peer, '.',
            state.resource.token, state.resource.generation);
          heartbeat.at = Date.now();
        }
        const receipt = await this.runtime.receipts.read(input.teamId, state.peer.memberId, request.messageId);
        if (receipt?.status === 'replied') {
          const reply = await this.runtime.requests.receive(membership, `reply-${request.messageId}`, signal);
          if (!reply.discarded && reply.message?.kind === 'reply' && reply.message.requestId === request.messageId &&
              reply.message.fromMemberId === state.peer.memberId && reply.message.senderGeneration === state.peer.memberGeneration) {
            state.outcome = { status: 'completed', summary: metadata(reply.message.body), stopped: false };
          }
          break;
        }
        if (receipt && ['failed', 'cancelled', 'expired'].includes(receipt.status)) break;
        const record = await this.runtime.runtimes.read(input.teamId, launched.runtimeId);
        if (!record || ['lost', 'terminated'].includes(record.state)) break;
        await delay(this.options.pollMs ?? 250, undefined, { signal });
      }
    } catch (error) {
      // Never expose command stderr: tmux arguments contain control/lease
      // credentials. The error's own message and code are safe and say why.
      const reason = safeReason(error);
      state.outcome = { status: signal.aborted ? 'cancelled' : 'failed', summary: signal.aborted
        ? 'Expert execution interrupted or timed out.' : `Expert could not start: ${reason}. Inspect /team doctor.`, stopped: false };
    } finally {
      if (state.requestId && state.owner && state.outcome.status !== 'completed') {
        await this.runtime.requests.cancel(state.owner, state.requestId).catch(() => {});
      }
      const stopped = state.runtimeId && state.supervisor
        ? await state.supervisor.stop(state.runtimeId, 'stop').then(r => r.status === 'terminated', () => false)
        : true;
      state.outcome = { ...state.outcome, stopped };
      if (stopped) {
        if (state.resource && state.peer) await this.runtime.resources.release(state.peer, '.',
          state.resource.token, state.resource.generation).catch(() => {});
        if (state.peer) await this.runtime.requests.leave(state.peer).catch(() => {});
        if (state.runtimeId && state.supervisor) {
          await this.runtime.runtimes.removeTerminated(input.teamId, state.runtimeId, state.supervisor.owner).catch(() => {});
        }
      }
    }
    return state.outcome;
  }
  async close(): Promise<void> {
    this.closing.abort();
    await Promise.allSettled([...this.pending]);
    const setup = await this.setup?.catch(() => undefined);
    if (setup) {
      try { await setup.supervisor.close(); }
      finally { await this.runtime.requests.leave(setup.membership).catch(() => {}); }
    }
  }
}
