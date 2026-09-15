import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Model } from '@earendil-works/pi-ai/compat';
import { sanitizeActivityText } from './activity.ts';
import { Mailbox, type Membership, type Message } from './mailbox.ts';
import { ManagedExecutionRuntime, type RuntimeOptions } from './managed-runtime.ts';
import type { ManagedAgentState, ManagedPlan, WorkItem } from './managed-schema.ts';
import type { ExecutionResult, SchedulerRuntime } from './scheduler.ts';

export type TerminalCommand = (program: string, args: readonly string[], cwd?: string) => Promise<void>;
type TerminalRuntimeOptions = RuntimeOptions & {
  mailboxRoot?: string;
  command?: TerminalCommand;
  piBin?: string;
  extensionPath?: string;
  pollMs?: number;
  mailbox?: Pick<Mailbox, 'teams' | 'create' | 'join' | 'leave' | 'heartbeat' | 'snapshot' | 'receive' | 'send'>;
};

const defaultCommand: TerminalCommand = (program, args, cwd) => new Promise((resolvePromise, reject) => {
  execFile(program, [...args], { cwd, env: process.env }, error => error ? reject(error) : resolvePromise());
});

export function terminalSessionName(team: string, alias: string): string {
  const base = `pi-team-${team}-${alias}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72);
  const hash = createHash('sha256').update(`${team}\0${alias}`).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export function terminalSessionId(team: string, alias: string): string {
  const hash = createHash('sha256').update(`pi-team-session\0${team}\0${alias}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function succeeds(action: Promise<unknown>): Promise<boolean> {
  try { await action; return true; } catch { return false; }
}

export async function openTerminalSession(team: string, alias: string, run: TerminalCommand = defaultCommand): Promise<string> {
  const session = terminalSessionName(team, alias);
  if (!await succeeds(run('tmux', ['has-session', '-t', `=${session}`]))) throw new Error(`Terminal for ${team}/${alias} is not running`);
  const attach = `tmux attach-session -t =${session}`;
  if (platform() === 'darwin') await run('open', ['-na', 'Ghostty.app', '--args', '-e', 'tmux', 'attach-session', '-t', `=${session}`]);
  else await run('x-terminal-emulator', ['-e', 'tmux', 'attach-session', '-t', `=${session}`]);
  return attach;
}

function peerResult(message: Message): ExecutionResult {
  if (!message.result) return { outcome: 'failed', summary: 'Terminal peer returned no structured result.' };
  return { outcome: message.result.outcome, summary: message.result.body, tests: message.result.tests };
}

function peerPrompt(team: string, plan: ManagedPlan, item: WorkItem, agent: ManagedAgentState): string {
  const dependencies = item.dependsOn.map(id => plan.workItems.find(candidate => candidate.id === id))
    .filter(candidate => !!candidate?.commit).map(candidate => ({ id: candidate!.id, commit: candidate!.commit }));
  const peers = plan.agents.filter(candidate => candidate.alias !== agent.alias).map(candidate => ({ alias: candidate.alias, role: candidate.role }));
  return sanitizeActivityText(`You are ${agent.alias}, a persistent terminal peer in managed team ${team}.
Role: ${agent.role}
Goal: ${plan.goal.objective}
Assigned item ${item.id}: ${item.title}
${item.detail}
Dependency commits: ${JSON.stringify(dependencies)}
Other peers: ${JSON.stringify(peers)}

Work only in your assigned worktree and branch. Inspect repository instructions before editing. Use team_send for focused questions or dependency handoffs to another listed peer, and team_status to track replies. Do not accept or invent work outside this managed plan. Complete this item autonomously, run relevant tests, and finish with a concise report. Never push, open or merge a pull request, release, publish, or deploy. A user can observe or steer this real Pi terminal at any time; if interrupted, preserve a clear status report.`, 15_500);
}

/** Persistent user-attachable tmux peers, coordinated through the durable mailbox. */
export class ManagedTerminalRuntime implements SchedulerRuntime {
  private readonly mailbox: Pick<Mailbox, 'teams' | 'create' | 'join' | 'leave' | 'heartbeat' | 'snapshot' | 'receive' | 'send'>;
  private readonly run: TerminalCommand;
  private readonly local: ManagedExecutionRuntime;
  private readonly results = new Map<string, Message>();
  private readonly terminalItems = new Map<string, string>();
  private readonly planAliases = new Set<string>();
  private readonly observedMessages = new Set<string>();
  private member?: Membership;
  private initialize?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(readonly options: TerminalRuntimeOptions) {
    const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    this.mailbox = options.mailbox ?? new Mailbox(options.mailboxRoot ?? join(agentDir, 'teams'));
    this.run = options.command ?? defaultCommand;
    this.local = new ManagedExecutionRuntime(options);
  }

  now(): number { return this.options.now?.() ?? Date.now(); }

  private async joinLead(deadline: number): Promise<Membership> {
    try { return await this.mailbox.join(this.options.team, 'managed-lead', `managed-${process.pid}`, process.cwd()); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
      return this.joinLead(deadline);
    }
  }

  private async infrastructure(): Promise<void> {
    if (this.initialize) return this.initialize;
    this.initialize = (async () => {
      if (!await succeeds(this.run('tmux', ['-V']))) throw new Error('Managed terminal peers require tmux. Install tmux and retry the plan.');
      if (!(await this.mailbox.teams()).includes(this.options.team)) await this.mailbox.create(this.options.team);
      this.member = await this.joinLead(Date.now() + 31_000);
      const timer = setInterval(() => {
        if (this.member) void this.mailbox.heartbeat(this.member, 'idle')
          .then(() => this.member ? this.mailbox.snapshot(this.member) : undefined)
          .then(snapshot => snapshot ? this.syncCommunications(snapshot) : undefined).catch(() => {});
      }, 5_000);
      timer.unref();
      this.heartbeat = timer;
    })();
    return this.initialize;
  }

  private sessionDirectory(alias: string): string {
    const agentDir = this.options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    return join(agentDir, 'managed-teams', this.options.team, 'sessions', alias);
  }

  private async waitForMember(alias: string, deadline: number): Promise<void> {
    if (!this.member) throw new Error('Managed terminal mailbox is unavailable');
    if ((await this.mailbox.snapshot(this.member)).members.some(member => member.alias === alias && member.status !== 'offline')) return;
    if (Date.now() >= deadline) throw new Error(`Terminal peer ${alias} did not join ${this.options.team}`);
    await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 100));
    return this.waitForMember(alias, deadline);
  }

  private async ensureTerminal(agent: ManagedAgentState): Promise<void> {
    await this.infrastructure();
    const session = terminalSessionName(this.options.team, agent.alias);
    if (await succeeds(this.run('tmux', ['has-session', '-t', `=${session}`]))) {
      // Never inject text or kill a terminal that may currently be inside a tool.
      // Durable presence is the only safe proof that this tmux session is our Pi peer.
      await this.waitForMember(agent.alias, Date.now() + 30_000);
      return;
    }
    const sessionDir = this.sessionDirectory(agent.alias);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const extensionPath = this.options.extensionPath ?? fileURLToPath(new URL('../index.ts', import.meta.url));
    const model = this.options.model as (Model<any> & { provider?: string }) | undefined;
    const modelName = model ? `${model.provider ? `${model.provider}/` : ''}${model.id}` : undefined;
    const piCommand = this.options.piBin ? [this.options.piBin] : process.argv[1] ? [process.execPath, process.argv[1]] : ['pi'];
    const args = ['new-session', '-d', '-s', session, '-c', agent.worktree, '--', '/usr/bin/env',
      `PI_TEAM_MANAGED_TEAM=${this.options.team}`, `PI_TEAM_MANAGED_ALIAS=${agent.alias}`, 'PI_TEAM_AUTO_TURNS=0', ...piCommand,
      '--no-extensions', '--extension', extensionPath, '--session-dir', sessionDir, '--session-id', terminalSessionId(this.options.team, agent.alias), '--name', `${this.options.team}:${agent.alias}`,
      ...(modelName ? ['--model', modelName] : []), '--approve', `/team join ${this.options.team} ${agent.alias}`];
    await this.run('tmux', args);
    await this.waitForMember(agent.alias, Date.now() + 30_000);
    await this.options.sessionOpened?.(agent.alias, undefined);
    await this.options.activity?.(agent.alias, { kind: 'lifecycle', summary: 'Started or resumed persistent terminal session' });
  }

  private async syncCommunications(snapshot: Awaited<ReturnType<Mailbox['snapshot']>>): Promise<void> {
    const messages = snapshot.messages.filter(message => this.planAliases.has(message.from) && this.planAliases.has(message.to) && !this.observedMessages.has(message.id));
    for (const message of messages) {
      this.observedMessages.add(message.id);
      try {
        const detail = sanitizeActivityText(message.result?.body ?? message.body, 1_000).trim();
        if (detail && this.options.communicate) {
          const workItemId = [...this.terminalItems].find(([, alias]) => alias === message.from)?.[0];
          await this.options.communicate(message.from, message.to, `${message.subject}: ${detail}`, workItemId);
        }
      } catch (error) { this.observedMessages.delete(message.id); throw error; }
    }
  }

  async prepare(plan: ManagedPlan): Promise<void> {
    await this.infrastructure();
    for (const agent of plan.agents) this.planAliases.add(agent.alias);
    await Promise.all(plan.agents.map(agent => this.ensureTerminal(agent)));
    if (this.member) await this.syncCommunications(await this.mailbox.snapshot(this.member));
  }

  private async receive(requestId: string, timeoutAt: number): Promise<Message> {
    const cached = this.results.get(requestId);
    if (cached) { this.results.delete(requestId); return cached; }
    if (!this.member) throw new Error('Managed terminal mailbox is unavailable');
    await this.syncCommunications(await this.mailbox.snapshot(this.member));
    const incoming = await this.mailbox.receive(this.member, true);
    if (incoming?.kind === 'result' && incoming.parentId) this.results.set(incoming.parentId, incoming);
    const found = this.results.get(requestId);
    if (found) { this.results.delete(requestId); return found; }
    if (Date.now() >= timeoutAt) throw new Error(`Terminal peer exceeded the ${this.options.runTimeoutMs ?? 30 * 60_000} ms execution limit`);
    await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 100));
    return this.receive(requestId, timeoutAt);
  }

  private async peer(plan: ManagedPlan, item: WorkItem, agent: ManagedAgentState): Promise<ExecutionResult> {
    await this.ensureTerminal(agent);
    if (!this.member) throw new Error('Managed terminal mailbox is unavailable');
    const before = (await this.options.worktrees.git(agent.worktree, ['rev-parse', 'HEAD'])).stdout;
    this.terminalItems.set(item.id, agent.alias);
    const request = await this.mailbox.send(this.member, {
      to: agent.alias, kind: 'request', subject: `${item.id}: ${item.title}`.slice(0, 160), body: peerPrompt(this.options.team, plan, item, agent),
    });
    const message = await this.receive(request.id, Date.now() + (this.options.runTimeoutMs ?? 30 * 60_000));
    this.terminalItems.delete(item.id);
    const committed = await this.options.worktrees.commit({ path: agent.worktree }, `${item.kind === 'review' ? 'fix' : 'feat'}: ${item.title}`);
    const result = peerResult(message);
    return { ...result, ...(committed.head !== before ? { commit: committed.head } : {}) };
  }

  async execute(plan: ManagedPlan, item: WorkItem, agent?: ManagedAgentState): Promise<ExecutionResult> {
    if (this.closed) return { outcome: 'interrupted', summary: 'Managed terminal runtime shut down before execution.' };
    if (['integration', 'verification'].includes(item.kind)) return this.local.execute(plan, item, agent);
    if (!agent) return { outcome: 'failed', summary: `No managed terminal peer is available for ${item.id}.` };
    return this.peer(plan, item, agent);
  }

  abortWork(workItemId: string): void {
    const alias = this.terminalItems.get(workItemId);
    if (alias) void this.run('tmux', ['send-keys', '-t', `=${terminalSessionName(this.options.team, alias)}`, 'C-c']);
  }

  async resumeAgent(alias: string): Promise<void> {
    const target = `=${terminalSessionName(this.options.team, alias)}`;
    await this.run('tmux', ['send-keys', '-t', target, '-l', '/team resume']);
    await this.run('tmux', ['send-keys', '-t', target, 'Enter']);
  }

  openTerminal(alias: string): Promise<string> { return openTerminalSession(this.options.team, alias, this.run); }

  dispose(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.member) void this.mailbox.leave(this.member).catch(() => {});
    this.member = undefined;
    this.local.dispose();
  }
}
