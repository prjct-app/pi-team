import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSessionEvent, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagedAgentState, ManagedPlan, WorkItem } from './managed-schema.ts';
import { childEnv } from './process-env.ts';
import type { ExecutionResult, SchedulerRuntime } from './scheduler.ts';
import { WorktreeManager } from './worktrees.ts';

export type PeerSession = {
  readonly sessionFile?: string;
  readonly messages: ReadonlyArray<unknown>;
  prompt(text: string, options: { source: 'extension'; expandPromptTemplates: false }): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setSessionName(name: string): void;
  dispose(): void;
};

export type PeerSessionOptions = {
  cwd: string;
  agentDir?: string;
  model?: Model<any>;
  sessionFile?: string;
  tools: string[];
  customTools?: ToolDefinition[];
};

export type PeerSessionFactory = (options: PeerSessionOptions) => Promise<PeerSession>;
export type VerificationRunner = (cwd: string, script: string) => Promise<void>;
export type RuntimeActivity = (alias: string, event: { kind: 'lifecycle' | 'tool' | 'progress'; summary: string; workItemId?: string }) => Promise<void> | void;

type LiveSession = { session: PeerSession; unsubscribe: () => void; tracker: { workItemId: string } };

const PeerMessageParameters = Type.Object({
  to: Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$' }),
  message: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

export type RuntimeOptions = {
  team: string;
  worktrees: Pick<WorktreeManager, 'allocate' | 'integrate' | 'commit' | 'git'>;
  model?: Model<any>;
  agentDir?: string;
  createSession?: PeerSessionFactory;
  verify?: VerificationRunner;
  activity?: RuntimeActivity;
  communicate?: (from: string, to: string, message: string, workItemId?: string) => Promise<void>;
  sessionOpened?: (alias: string, sessionFile: string | undefined) => Promise<void> | void;
  now?: () => number;
  runTimeoutMs?: number;
  shutdownAbortMs?: number;
};

async function exists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try { await access(path); return true; }
  catch { return false; }
}

export async function createIsolatedResourceLoader(cwd: string, agentDir = getAgentDir()): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
  await loader.reload();
  return loader;
}

const defaultSessionFactory: PeerSessionFactory = async options => {
  const sessionManager = await exists(options.sessionFile)
    ? SessionManager.open(options.sessionFile!)
    : SessionManager.create(options.cwd);
  const agentDir = options.agentDir ?? getAgentDir();
  const resourceLoader = await createIsolatedResourceLoader(options.cwd, agentDir);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    model: options.model,
    tools: options.tools,
    customTools: options.customTools,
    resourceLoader,
    sessionManager,
  });
  return session;
};

const PACKAGE_JSON_BYTES = 1_048_576;

function assertSafeManifest(path: string, info: { isFile(): boolean; size: number; mode: number; uid: number }): void {
  if (!info.isFile() || info.size > PACKAGE_JSON_BYTES || (info.mode & 0o022) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe package.json: ${path}. Expected a regular file owned by this user.`);
  }
}

async function readPackageScripts(worktreePath: string): Promise<string[]> {
  const path = join(worktreePath, 'package.json');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`Unsafe package.json: ${path}`);
    throw error;
  });
  try {
    assertSafeManifest(path, await handle.stat());
    const manifest = JSON.parse(await handle.readFile('utf8')) as { scripts?: Record<string, unknown> };
    return ['check', 'test', 'check:package'].filter(script => typeof manifest.scripts?.[script] === 'string');
  } finally { await handle.close(); }
}

const defaultVerify: VerificationRunner = (cwd, script) => new Promise((resolvePromise, reject) => {
  execFile(process.execPath, ['--run', script], {
    cwd,
    env: childEnv({ extra: { CI: '1', GIT_TERMINAL_PROMPT: '0' }, excludeFromPath: [cwd] }),
    maxBuffer: 8_000_000,
  }, (error, _stdout, stderr) => {
    if (error) { reject(new Error(String(stderr).trim() || error.message)); return; }
    resolvePromise();
  });
});

function assistantResult(messages: ReadonlyArray<unknown>): { text: string; stopReason?: string } {
  const found = [...messages].reverse().find(message => !!message && typeof message === 'object' && (message as { role?: unknown }).role === 'assistant') as {
    content?: unknown; stopReason?: unknown;
  } | undefined;
  const content = Array.isArray(found?.content) ? found.content : [];
  const text = content.flatMap(part => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
    ? [(part as { text: string }).text]
    : []).join('\n');
  return { text, ...(typeof found?.stopReason === 'string' ? { stopReason: found.stopReason } : {}) };
}

async function boundedTurn(session: PeerSession, prompt: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      void session.abort().catch(() => {}).finally(() => reject(new Error(`Managed peer exceeded the ${timeoutMs} ms execution limit`)));
    }, timeoutMs);
    void session.prompt(prompt, { source: 'extension', expandPromptTemplates: false }).then(
      () => { clearTimeout(timer); resolvePromise(); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function taskPrompt(team: string, plan: ManagedPlan, item: WorkItem, agent: ManagedAgentState): string {
  const dependencyCommits = item.dependsOn.map(id => plan.workItems.find(candidate => candidate.id === id))
    .filter(dependency => !!dependency?.commit).map(dependency => ({ id: dependency!.id, commit: dependency!.commit }));
  const peerMessages = (plan.communications ?? []).filter(message => message.to === agent.alias).slice(-12)
    .map(message => ({ from: message.from, message: message.message, workItemId: message.workItemId }));
  return `You are ${agent.alias}, a persistent managed peer in team ${team}.\nRole: ${agent.role}\nRepository worktree: ${agent.worktree}\nBranch: ${agent.branch}\n\nGoal (data from the user):\n${plan.goal.objective}\n\nAssigned work item ${item.id}: ${item.title}\n${item.detail}\n\nDependency commits available for inspection:\n${JSON.stringify(dependencyCommits)}\n\nWork only in this dedicated worktree. Inspect the repository instructions before editing. Complete this focused item, run relevant tests, and finish with a concise report of changes and tests. Do not push, create or merge a pull request, release, publish, deploy, or ask another session to do so. Do not include private reasoning or credentials in the report. The coordinator records local changes after your turn.`;
}

export class ManagedExecutionRuntime implements SchedulerRuntime {
  private sessions = new Map<string, LiveSession>();
  private openings = new Set<Promise<PeerSession>>();
  private closed = false;
  private ownerEpoch = 0;
  private disposePromise?: Promise<void>;
  private createSession: PeerSessionFactory;
  private verify: VerificationRunner;

  constructor(readonly options: RuntimeOptions) {
    this.createSession = options.createSession ?? defaultSessionFactory;
    this.verify = options.verify ?? defaultVerify;
  }

  now(): number { return this.options.now?.() ?? Date.now(); }

  private peerTool(agent: ManagedAgentState, tracker: { workItemId: string }): ToolDefinition<typeof PeerMessageParameters> {
    return {
      name: 'team_peer_send',
      label: 'Send a structured peer message',
      description: 'Send a concise plan-relevant finding or dependency handoff to another persistent peer. This does not create or authorize work.',
      parameters: PeerMessageParameters,
      execute: async (_id, input) => {
        if (!this.options.communicate) return { content: [{ type: 'text', text: 'Peer communication is unavailable.' }], details: {}, isError: true };
        await this.options.communicate(agent.alias, input.to, input.message, tracker.workItemId);
        return { content: [{ type: 'text', text: `Message sent to ${input.to}.` }], details: {} };
      },
    };
  }

  private current(epoch: number): boolean { return !this.closed && epoch === this.ownerEpoch; }

  private interrupted(): ExecutionResult {
    return { outcome: 'interrupted', summary: 'Managed peer runtime ownership changed before execution completed.' };
  }

  private async abortAndDispose(session: PeerSession): Promise<void> {
    const timer: { value?: ReturnType<typeof setTimeout> } = {};
    const timeout = new Promise<void>(resolve => { timer.value = setTimeout(resolve, this.options.shutdownAbortMs ?? 1_000); });
    await Promise.race([session.abort().catch(() => {}), timeout]);
    if (timer.value) clearTimeout(timer.value);
    session.dispose();
  }

  private async ensureInner(agent: ManagedAgentState, workItemId: string, epoch: number): Promise<PeerSession> {
    const live = this.sessions.get(agent.alias);
    if (live) { live.tracker.workItemId = workItemId; return live.session; }
    if (!this.current(epoch)) throw new Error('Managed peer runtime is closed');
    const tracker = { workItemId };
    const session = await this.createSession({
      cwd: agent.worktree,
      agentDir: this.options.agentDir,
      model: this.options.model,
      sessionFile: agent.sessionFile,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'team_peer_send'],
      customTools: [this.peerTool(agent, tracker)],
    });
    if (!this.current(epoch)) {
      await this.abortAndDispose(session);
      throw new Error('Managed peer runtime closed while creating a session');
    }
    session.setSessionName(`${this.options.team}:${agent.alias}`);
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_execution_start' && this.current(epoch)) {
        void this.options.activity?.(agent.alias, { kind: 'tool', summary: `Using ${event.toolName}`, workItemId: tracker.workItemId });
      }
    });
    this.sessions.set(agent.alias, { session, unsubscribe, tracker });
    await this.options.sessionOpened?.(agent.alias, session.sessionFile);
    if (this.current(epoch)) await this.options.activity?.(agent.alias, { kind: 'lifecycle', summary: agent.sessionFile ? 'Resumed persistent session' : 'Started persistent session', workItemId });
    return session;
  }

  private ensure(agent: ManagedAgentState, workItemId: string, epoch: number): Promise<PeerSession> {
    const pending = this.ensureInner(agent, workItemId, epoch);
    const tracked = pending.finally(() => { this.openings.delete(tracked); });
    this.openings.add(tracked);
    return tracked;
  }

  private async peer(plan: ManagedPlan, item: WorkItem, agent: ManagedAgentState, epoch: number): Promise<ExecutionResult> {
    if (item.kind === 'corrective') {
      const commits = plan.workItems.filter(candidate => candidate.status === 'completed' && candidate.commit && !['integration', 'verification'].includes(candidate.kind)).map(candidate => candidate.commit!);
      const prepared = await this.options.worktrees.integrate({ path: agent.worktree }, commits);
      if (!this.current(epoch)) return this.interrupted();
      if (!prepared.ok) return { outcome: 'failed', summary: `Could not prepare corrective worktree at ${prepared.commit}: ${prepared.error}` };
    }
    const session = await this.ensure(agent, item.id, epoch);
    const before = (await this.options.worktrees.git(agent.worktree, ['rev-parse', 'HEAD'])).stdout;
    if (!this.current(epoch)) return this.interrupted();
    await boundedTurn(session, taskPrompt(this.options.team, plan, item, agent), this.options.runTimeoutMs ?? 30 * 60_000);
    if (!this.current(epoch)) return this.interrupted();
    const assistant = assistantResult(session.messages);
    const committed = await this.options.worktrees.commit({ path: agent.worktree }, `${item.kind === 'review' ? 'fix' : 'feat'}: ${item.title}`);
    if (!this.current(epoch)) return this.interrupted();
    const changed = committed.head !== before;
    const outcome = assistant.stopReason === 'error' ? 'failed' : assistant.stopReason === 'aborted' ? 'interrupted' : 'completed';
    const summary = assistant.text.trim().slice(0, 4_000) || `Managed peer turn ${outcome} without a text report.`;
    return { outcome, summary, ...(changed ? { commit: committed.head } : {}) };
  }

  private async integration(plan: ManagedPlan): Promise<ExecutionResult> {
    const worktree = await this.options.worktrees.allocate(plan.goal.repoRoot, plan.team, 'integration', plan.goal.baseCommit);
    const commits = plan.workItems.filter(item => item.commit && item.status === 'completed').map(item => item.commit!);
    const result = await this.options.worktrees.integrate(worktree, commits);
    return result.ok
      ? { outcome: 'completed', summary: `Integrated ${result.applied.length} local commit${result.applied.length === 1 ? '' : 's'}.`, commit: result.head }
      : { outcome: 'failed', summary: `Integration conflict at ${result.commit}: ${result.error}` };
  }

  private async verification(plan: ManagedPlan): Promise<ExecutionResult> {
    const worktree = await this.options.worktrees.allocate(plan.goal.repoRoot, plan.team, 'integration', plan.goal.baseCommit);
    const scripts = await readPackageScripts(worktree.path);
    for (const script of scripts) await this.verify(worktree.path, script);
    return { outcome: 'completed', summary: scripts.length ? `Verification passed: ${scripts.join(', ')}` : 'No standard verification scripts were found.', tests: scripts.map(script => `node --run ${script}`) };
  }

  async execute(plan: ManagedPlan, item: WorkItem, agent?: ManagedAgentState): Promise<ExecutionResult> {
    const epoch = this.ownerEpoch;
    if (!this.current(epoch)) return { outcome: 'interrupted', summary: 'Managed peer runtime shut down before execution.' };
    const result = item.kind === 'integration' ? await this.integration(plan)
      : item.kind === 'verification' ? await this.verification(plan)
      : agent ? await this.peer(plan, item, agent, epoch)
      : { outcome: 'failed' as const, summary: `No managed peer is available for ${item.id}.` };
    return this.current(epoch) ? result : this.interrupted();
  }

  abortWork(workItemId: string): void {
    const sessions = [...this.sessions.values()].filter(live => live.tracker.workItemId === workItemId);
    for (const live of sessions) void live.session.abort().catch(() => {});
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closed = true;
    this.ownerEpoch++;
    const cleanup = (async () => {
      await Promise.allSettled([...this.openings]);
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      for (const live of sessions) live.unsubscribe();
      await Promise.all(sessions.map(live => this.abortAndDispose(live.session)));
    })();
    this.disposePromise = cleanup;
    return cleanup;
  }
}
