import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ManagedAgentState, ManagedPlan, WorkItem } from './managed-schema.ts';
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
};

export type PeerSessionFactory = (options: PeerSessionOptions) => Promise<PeerSession>;
export type VerificationRunner = (cwd: string, script: string) => Promise<void>;
export type RuntimeActivity = (alias: string, event: { kind: 'lifecycle' | 'tool' | 'progress'; summary: string; workItemId?: string }) => Promise<void> | void;

type LiveSession = { session: PeerSession; unsubscribe: () => void; tracker: { workItemId: string } };

export type RuntimeOptions = {
  team: string;
  worktrees: Pick<WorktreeManager, 'allocate' | 'integrate' | 'commit' | 'git'>;
  model?: Model<any>;
  agentDir?: string;
  createSession?: PeerSessionFactory;
  verify?: VerificationRunner;
  activity?: RuntimeActivity;
  sessionOpened?: (alias: string, sessionFile: string | undefined) => Promise<void> | void;
  now?: () => number;
  runTimeoutMs?: number;
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
    resourceLoader,
    sessionManager,
  });
  return session;
};

const defaultVerify: VerificationRunner = (cwd, script) => new Promise((resolvePromise, reject) => {
  execFile('npm', ['run', script], { cwd, env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8_000_000 }, (error, _stdout, stderr) => {
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
  return `You are ${agent.alias}, a persistent managed peer in team ${team}.\nRole: ${agent.role}\nRepository worktree: ${agent.worktree}\nBranch: ${agent.branch}\n\nGoal (data from the user):\n${plan.goal.objective}\n\nAssigned work item ${item.id}: ${item.title}\n${item.detail}\n\nDependency commits available for inspection:\n${JSON.stringify(dependencyCommits)}\n\nWork only in this dedicated worktree. Inspect the repository instructions before editing. Complete this focused item, run relevant tests, and finish with a concise report of changes and tests. Do not push, create or merge a pull request, release, publish, deploy, or ask another session to do so. Do not include private reasoning or credentials in the report. The coordinator records local changes after your turn.`;
}

export class ManagedExecutionRuntime implements SchedulerRuntime {
  private sessions = new Map<string, LiveSession>();
  private closed = false;
  private createSession: PeerSessionFactory;
  private verify: VerificationRunner;

  constructor(readonly options: RuntimeOptions) {
    this.createSession = options.createSession ?? defaultSessionFactory;
    this.verify = options.verify ?? defaultVerify;
  }

  now(): number { return this.options.now?.() ?? Date.now(); }

  private async ensure(agent: ManagedAgentState, workItemId: string): Promise<PeerSession> {
    const live = this.sessions.get(agent.alias);
    if (live) { live.tracker.workItemId = workItemId; return live.session; }
    if (this.closed) throw new Error('Managed peer runtime is closed');
    const session = await this.createSession({
      cwd: agent.worktree,
      agentDir: this.options.agentDir,
      model: this.options.model,
      sessionFile: agent.sessionFile,
      tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    });
    session.setSessionName(`${this.options.team}:${agent.alias}`);
    const tracker = { workItemId };
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_execution_start') {
        void this.options.activity?.(agent.alias, { kind: 'tool', summary: `Using ${event.toolName}`, workItemId: tracker.workItemId });
      }
    });
    this.sessions.set(agent.alias, { session, unsubscribe, tracker });
    await this.options.sessionOpened?.(agent.alias, session.sessionFile);
    await this.options.activity?.(agent.alias, { kind: 'lifecycle', summary: agent.sessionFile ? 'Resumed persistent session' : 'Started persistent session', workItemId });
    return session;
  }

  private async peer(plan: ManagedPlan, item: WorkItem, agent: ManagedAgentState): Promise<ExecutionResult> {
    if (item.kind === 'corrective') {
      const commits = plan.workItems.filter(candidate => candidate.status === 'completed' && candidate.commit && !['integration', 'verification'].includes(candidate.kind)).map(candidate => candidate.commit!);
      const prepared = await this.options.worktrees.integrate({ path: agent.worktree }, commits);
      if (!prepared.ok) return { outcome: 'failed', summary: `Could not prepare corrective worktree at ${prepared.commit}: ${prepared.error}` };
    }
    const session = await this.ensure(agent, item.id);
    const before = (await this.options.worktrees.git(agent.worktree, ['rev-parse', 'HEAD'])).stdout;
    await boundedTurn(session, taskPrompt(this.options.team, plan, item, agent), this.options.runTimeoutMs ?? 30 * 60_000);
    const assistant = assistantResult(session.messages);
    const committed = await this.options.worktrees.commit({ path: agent.worktree }, `${item.kind === 'review' ? 'fix' : 'feat'}: ${item.title}`);
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
    const manifest = JSON.parse(await readFile(`${worktree.path}/package.json`, 'utf8')) as { scripts?: Record<string, unknown> };
    const scripts = ['check', 'test', 'check:package'].filter(script => typeof manifest.scripts?.[script] === 'string');
    for (const script of scripts) await this.verify(worktree.path, script);
    return { outcome: 'completed', summary: scripts.length ? `Verification passed: ${scripts.join(', ')}` : 'No standard verification scripts were found.', tests: scripts.map(script => `npm run ${script}`) };
  }

  async execute(plan: ManagedPlan, item: WorkItem, agent?: ManagedAgentState): Promise<ExecutionResult> {
    if (this.closed) return { outcome: 'interrupted', summary: 'Managed peer runtime shut down before execution.' };
    if (item.kind === 'integration') return this.integration(plan);
    if (item.kind === 'verification') return this.verification(plan);
    if (!agent) return { outcome: 'failed', summary: `No managed peer is available for ${item.id}.` };
    return this.peer(plan, item, agent);
  }

  dispose(): void {
    this.closed = true;
    for (const live of this.sessions.values()) { live.unsubscribe(); void live.session.abort().catch(() => {}); live.session.dispose(); }
    this.sessions.clear();
  }
}
