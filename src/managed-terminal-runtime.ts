import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Model } from '@earendil-works/pi-ai/compat';
import { sanitizeActivityText } from './activity.ts';
import { Mailbox, type Membership, type Message } from './mailbox.ts';
import { ManagedExecutionRuntime, type RuntimeOptions } from './managed-runtime.ts';
import type { ManagedAgentState, ManagedPlan, WorkItem } from './managed-schema.ts';
import { defaultProcessController, sameProcess, type ProcessController, type ProcessIdentity } from './process-identity.ts';
import type { ExecutionResult, SchedulerRuntime } from './scheduler.ts';

export type TerminalCommandResult = Readonly<{ stdout: string; stderr: string }>;
export type TerminalCommand = (program: string, args: readonly string[], cwd?: string) => Promise<TerminalCommandResult | void>;
type ShutdownTimings = Readonly<{ gracefulMs: number; termMs: number; killMs: number; pollMs: number }>;
type TerminalRuntimeOptions = RuntimeOptions & {
  mailboxRoot?: string;
  command?: TerminalCommand;
  piBin?: string;
  extensionPath?: string;
  pollMs?: number;
  mailbox?: Pick<Mailbox, 'teams' | 'create' | 'join' | 'leave' | 'heartbeat' | 'snapshot' | 'receive' | 'send'>;
  processController?: ProcessController;
  shutdownTimings?: Partial<ShutdownTimings>;
  ownerInstanceId?: string;
  ownershipToken?: string;
};

type OwnedTerminal = Readonly<{
  session: string;
  runtimeId: string;
  ownerInstanceId: string;
  tokenHash: string;
  ownerEpoch: number;
  marked: boolean;
  identity?: ProcessIdentity;
}>;

const TMUX_RUNTIME_ID = '@pi-team-runtime-id';
const TMUX_OWNER_INSTANCE = '@pi-team-owner-instance';
const TMUX_TOKEN_HASH = '@pi-team-token-hash';
const ENV_RUNTIME_ID = 'PI_TEAM_RUNTIME_ID';
const ENV_OWNER_INSTANCE = 'PI_TEAM_OWNER_INSTANCE';
const ENV_TOKEN_HASH = 'PI_TEAM_TOKEN_HASH';
const DEFAULT_SHUTDOWN: ShutdownTimings = { gracefulMs: 5_000, termMs: 2_000, killMs: 1_000, pollMs: 50 };

function shutdownTimings(input: Partial<ShutdownTimings> | undefined): ShutdownTimings {
  const value = { ...DEFAULT_SHUTDOWN, ...input };
  const durations = [value.gracefulMs, value.termMs, value.killMs];
  if (durations.some(duration => !Number.isFinite(duration) || duration < 0) ||
      !Number.isFinite(value.pollMs) || value.pollMs <= 0) {
    throw new Error('Shutdown timings require non-negative finite durations and a positive poll interval');
  }
  return value;
}

const defaultCommand: TerminalCommand = (program, args, cwd) => new Promise((resolvePromise, reject) => {
  execFile(program, [...args], { cwd, env: process.env, timeout: 10_000 }, (error, stdout, stderr) => error ? reject(error) : resolvePromise({ stdout: String(stdout), stderr: String(stderr) }));
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

function stdout(result: TerminalCommandResult | void): string {
  return result?.stdout.trim() ?? '';
}

function parsePid(value: string): number | undefined {
  const processPid = Number(value);
  return Number.isSafeInteger(processPid) && processPid > 1 ? processPid : undefined;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
  private readonly processController: ProcessController;
  private readonly shutdownTimings: ShutdownTimings;
  private readonly ownerInstanceId: string;
  private readonly ownershipTokenHash: string;
  private readonly results = new Map<string, Message>();
  private readonly terminalItems = new Map<string, string>();
  private readonly planAliases = new Set<string>();
  private readonly observedMessages = new Set<string>();
  private readonly ownedTerminals = new Map<string, OwnedTerminal>();
  private readonly launches = new Set<Promise<void>>();
  private member?: Membership;
  private initialize?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private disposePromise?: Promise<void>;
  private closed = false;
  private ownerEpoch = 0;

  constructor(readonly options: TerminalRuntimeOptions) {
    const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    this.mailbox = options.mailbox ?? new Mailbox(options.mailboxRoot ?? join(agentDir, 'teams'));
    this.run = options.command ?? defaultCommand;
    this.local = new ManagedExecutionRuntime(options);
    this.processController = options.processController ?? defaultProcessController;
    this.shutdownTimings = shutdownTimings(options.shutdownTimings);
    this.ownerInstanceId = options.ownerInstanceId ?? randomUUID();
    this.ownershipTokenHash = tokenHash(options.ownershipToken ?? randomBytes(32).toString('hex'));
  }

  now(): number { return this.options.now?.() ?? Date.now(); }

  private async joinLead(deadline: number): Promise<Membership> {
    if (this.closed) throw new Error('Managed terminal runtime is closed');
    try { return await this.mailbox.join(this.options.team, 'managed-lead', `managed-${process.pid}`, process.cwd()); }
    catch (error) {
      if (this.closed || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
      return this.joinLead(deadline);
    }
  }

  private async infrastructure(): Promise<void> {
    if (this.closed) throw new Error('Managed terminal runtime is closed');
    if (this.initialize) return this.initialize;
    const epoch = this.ownerEpoch;
    this.initialize = (async () => {
      if (!await succeeds(this.run('tmux', ['-V']))) throw new Error('Managed terminal peers require tmux. Install tmux and retry the plan.');
      if (!(await this.mailbox.teams()).includes(this.options.team)) await this.mailbox.create(this.options.team);
      const member = await this.joinLead(Date.now() + 31_000);
      if (this.closed || epoch !== this.ownerEpoch) {
        await this.mailbox.leave(member).catch(() => {});
        throw new Error('Managed terminal runtime closed during initialization');
      }
      this.member = member;
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
    if (this.closed) throw new Error('Managed terminal runtime is closed');
    if (!this.member) throw new Error('Managed terminal mailbox is unavailable');
    const snapshot = await this.mailbox.snapshot(this.member);
    if (this.closed) throw new Error('Managed terminal runtime closed while waiting for a peer');
    if (snapshot.members.some(member => member.alias === alias && member.status !== 'offline')) return;
    if (Date.now() >= deadline) throw new Error(`Terminal peer ${alias} did not join ${this.options.team}`);
    await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 100));
    return this.waitForMember(alias, deadline);
  }

  private ownership(session: string, ownerEpoch: number): OwnedTerminal {
    return {
      session, runtimeId: randomUUID(), ownerInstanceId: this.ownerInstanceId,
      tokenHash: this.ownershipTokenHash, ownerEpoch, marked: false,
    };
  }

  private async markOwned(partial: OwnedTerminal): Promise<OwnedTerminal> {
    await this.run('tmux', ['set-option', '-t', `=${partial.session}`, TMUX_RUNTIME_ID, partial.runtimeId]);
    await this.run('tmux', ['set-option', '-t', `=${partial.session}`, TMUX_OWNER_INSTANCE, partial.ownerInstanceId]);
    await this.run('tmux', ['set-option', '-t', `=${partial.session}`, TMUX_TOKEN_HASH, partial.tokenHash]);
    const processPid = parsePid(stdout(await this.run('tmux', ['display-message', '-p', '-t', `=${partial.session}`, '#{pane_pid}'])));
    const identity = processPid ? await this.processController.inspect(processPid) : undefined;
    const owned = { ...partial, marked: true, ...(identity ? { identity } : {}) };
    this.ownedTerminals.set(partial.session, owned);
    return owned;
  }

  private async metadataMatches(owned: OwnedTerminal): Promise<boolean> {
    const format = `#{${TMUX_RUNTIME_ID}}\t#{${TMUX_OWNER_INSTANCE}}\t#{${TMUX_TOKEN_HASH}}`;
    const value = await this.run('tmux', ['display-message', '-p', '-t', `=${owned.session}`, format]).then(stdout).catch(() => '');
    return value === `${owned.runtimeId}\t${owned.ownerInstanceId}\t${owned.tokenHash}`;
  }

  private async environmentMatches(owned: OwnedTerminal): Promise<boolean> {
    const output = await this.run('tmux', ['show-environment', '-t', `=${owned.session}`]).then(stdout).catch(() => '');
    const values = new Map(output.split('\n').filter(line => line.includes('=')).map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return values.get(ENV_RUNTIME_ID) === owned.runtimeId && values.get(ENV_OWNER_INSTANCE) === owned.ownerInstanceId &&
      values.get(ENV_TOKEN_HASH) === owned.tokenHash;
  }

  private async ownershipMatches(owned: OwnedTerminal): Promise<boolean> {
    return owned.marked ? this.metadataMatches(owned) : this.environmentMatches(owned);
  }

  private async identityMatches(owned: OwnedTerminal): Promise<boolean> {
    return !!owned.identity && sameProcess(owned.identity, await this.processController.inspect(owned.identity.processPid));
  }

  private async processMatches(owned: OwnedTerminal): Promise<boolean> {
    return await this.ownershipMatches(owned) && await this.identityMatches(owned);
  }

  private async waitForExit(owned: OwnedTerminal, remainingMs: number): Promise<boolean> {
    if (!await this.processMatches(owned)) return true;
    if (remainingMs <= 0) return false;
    const pause = Math.min(this.shutdownTimings.pollMs, remainingMs);
    await this.processController.delay(pause);
    return this.waitForExit(owned, remainingMs - pause);
  }

  private async signalOwned(owned: OwnedTerminal, signal: NodeJS.Signals): Promise<boolean> {
    if (!owned.identity || !await this.processMatches(owned) || !await this.ownershipMatches(owned)) return false;
    return this.processController.signal(owned.identity, signal);
  }

  private async stopOwned(owned: OwnedTerminal): Promise<void> {
    if (!await this.ownershipMatches(owned)) {
      if (await this.identityMatches(owned)) throw new Error(`Refusing to stop ${owned.session}: ownership metadata changed`);
      this.ownedTerminals.delete(owned.session);
      return;
    }
    const graceful = await this.signalOwned(owned, 'SIGHUP');
    const exitedGracefully = graceful && await this.waitForExit(owned, this.shutdownTimings.gracefulMs);
    const terminated = exitedGracefully || !await this.signalOwned(owned, 'SIGTERM') ||
      await this.waitForExit(owned, this.shutdownTimings.termMs);
    if (!terminated) {
      const killed = await this.signalOwned(owned, 'SIGKILL');
      if (killed) await this.waitForExit(owned, this.shutdownTimings.killMs);
    }
    if (await this.ownershipMatches(owned)) await this.run('tmux', ['kill-session', '-t', `=${owned.session}`]);
    else if (await this.identityMatches(owned)) throw new Error(`Refusing to kill ${owned.session}: ownership metadata changed`);
    this.ownedTerminals.delete(owned.session);
  }

  private async ensureTerminalInner(agent: ManagedAgentState): Promise<void> {
    await this.infrastructure();
    const epoch = this.ownerEpoch;
    const session = terminalSessionName(this.options.team, agent.alias);
    if (await succeeds(this.run('tmux', ['has-session', '-t', `=${session}`]))) {
      // A detected session is external to this runtime unless this instance created and token-marked it.
      await this.waitForMember(agent.alias, Date.now() + 30_000);
      return;
    }
    if (this.closed) throw new Error('Managed terminal runtime is closed');
    const sessionDir = this.sessionDirectory(agent.alias);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const extensionPath = this.options.extensionPath ?? fileURLToPath(new URL('../index.ts', import.meta.url));
    const model = this.options.model as (Model<any> & { provider?: string }) | undefined;
    const modelName = model ? `${model.provider ? `${model.provider}/` : ''}${model.id}` : undefined;
    const piCommand = this.options.piBin ? [this.options.piBin] : process.argv[1] ? [process.execPath, process.argv[1]] : ['pi'];
    const partial = this.ownership(session, epoch);
    this.ownedTerminals.set(session, partial);
    const args = ['new-session', '-d', '-s', session, '-c', agent.worktree,
      '-e', `${ENV_RUNTIME_ID}=${partial.runtimeId}`, '-e', `${ENV_OWNER_INSTANCE}=${partial.ownerInstanceId}`, '-e', `${ENV_TOKEN_HASH}=${partial.tokenHash}`,
      '--', '/usr/bin/env', `PI_TEAM_MANAGED_TEAM=${this.options.team}`, `PI_TEAM_MANAGED_ALIAS=${agent.alias}`, 'PI_TEAM_AUTO_TURNS=0', ...piCommand,
      '--no-extensions', '--extension', extensionPath, '--session-dir', sessionDir, '--session-id', terminalSessionId(this.options.team, agent.alias), '--name', `${this.options.team}:${agent.alias}`,
      ...(modelName ? ['--model', modelName] : []), '--approve', `/team join ${this.options.team} ${agent.alias}`];
    await this.run('tmux', args);
    const owned = await this.markOwned(partial);
    if (this.closed || epoch !== this.ownerEpoch) {
      await this.stopOwned(owned);
      throw new Error('Managed terminal runtime closed while launching a peer');
    }
    await this.waitForMember(agent.alias, Date.now() + 30_000);
    if (this.closed || epoch !== this.ownerEpoch) throw new Error('Managed terminal runtime closed while launching a peer');
    await this.options.sessionOpened?.(agent.alias, undefined);
    if (!this.closed && epoch === this.ownerEpoch) await this.options.activity?.(agent.alias, { kind: 'lifecycle', summary: 'Started persistent terminal session' });
  }

  private ensureTerminal(agent: ManagedAgentState): Promise<void> {
    const pending = this.ensureTerminalInner(agent);
    const tracked = pending.finally(() => { this.launches.delete(tracked); });
    this.launches.add(tracked);
    return tracked;
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
    if (this.member && !this.closed) await this.syncCommunications(await this.mailbox.snapshot(this.member));
  }

  private async receive(requestId: string, timeoutAt: number): Promise<Message> {
    if (this.closed) throw new Error('Managed terminal runtime closed during execution');
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

  private interrupted(): ExecutionResult {
    return { outcome: 'interrupted', summary: 'Managed terminal runtime ownership changed before execution completed.' };
  }

  private async peer(plan: ManagedPlan, item: WorkItem, agent: ManagedAgentState, epoch: number): Promise<ExecutionResult> {
    await this.ensureTerminal(agent);
    if (this.closed || epoch !== this.ownerEpoch) return this.interrupted();
    if (!this.member) throw new Error('Managed terminal mailbox is unavailable');
    const before = (await this.options.worktrees.git(agent.worktree, ['rev-parse', 'HEAD'])).stdout;
    this.terminalItems.set(item.id, agent.alias);
    try {
      const request = await this.mailbox.send(this.member, {
        to: agent.alias, kind: 'request', subject: `${item.id}: ${item.title}`.slice(0, 160), body: peerPrompt(this.options.team, plan, item, agent),
      });
      const message = await this.receive(request.id, Date.now() + (this.options.runTimeoutMs ?? 30 * 60_000));
      if (this.closed || epoch !== this.ownerEpoch) return this.interrupted();
      const committed = await this.options.worktrees.commit({ path: agent.worktree }, `${item.kind === 'review' ? 'fix' : 'feat'}: ${item.title}`);
      if (this.closed || epoch !== this.ownerEpoch) return this.interrupted();
      const result = peerResult(message);
      return { ...result, ...(committed.head !== before ? { commit: committed.head } : {}) };
    } finally { this.terminalItems.delete(item.id); }
  }

  async execute(plan: ManagedPlan, item: WorkItem, agent?: ManagedAgentState): Promise<ExecutionResult> {
    const epoch = this.ownerEpoch;
    if (this.closed) return { outcome: 'interrupted', summary: 'Managed terminal runtime shut down before execution.' };
    const result = ['integration', 'verification'].includes(item.kind) ? await this.local.execute(plan, item, agent)
      : agent ? await this.peer(plan, item, agent, epoch)
      : { outcome: 'failed' as const, summary: `No managed terminal peer is available for ${item.id}.` };
    return this.closed || epoch !== this.ownerEpoch ? this.interrupted() : result;
  }

  abortWork(workItemId: string): void {
    const alias = this.terminalItems.get(workItemId);
    const session = alias ? terminalSessionName(this.options.team, alias) : undefined;
    const owned = session ? this.ownedTerminals.get(session) : undefined;
    const epoch = this.ownerEpoch;
    if (!owned || this.closed) return;
    void this.ownershipMatches(owned).then(matches => {
      if (matches && !this.closed && epoch === this.ownerEpoch) return this.run('tmux', ['send-keys', '-t', `=${session}`, 'C-c']);
      return undefined;
    }).catch(() => {});
  }

  async resumeAgent(alias: string): Promise<void> {
    if (this.closed) throw new Error('Managed terminal runtime is closed');
    const session = terminalSessionName(this.options.team, alias);
    const owned = this.ownedTerminals.get(session);
    const epoch = this.ownerEpoch;
    if (!owned || !await this.ownershipMatches(owned) || this.closed || epoch !== this.ownerEpoch) {
      throw new Error(`Terminal peer ${alias} is not owned by this runtime`);
    }
    const target = `=${session}`;
    await this.run('tmux', ['send-keys', '-t', target, '-l', '/team resume']);
    if (this.closed || epoch !== this.ownerEpoch || !await this.ownershipMatches(owned)) throw new Error('Managed terminal runtime ownership changed');
    await this.run('tmux', ['send-keys', '-t', target, 'Enter']);
  }

  openTerminal(alias: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Managed terminal runtime is closed'));
    return openTerminalSession(this.options.team, alias, this.run);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closed = true;
    this.ownerEpoch++;
    this.terminalItems.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const member = this.member;
    this.member = undefined;
    const cleanup = (async () => {
      await Promise.allSettled([...this.launches]);
      await Promise.all([
        this.local.dispose(),
        ...[...this.ownedTerminals.values()].map(owned => this.stopOwned(owned)),
        ...(member ? [this.mailbox.leave(member).catch(() => {})] : []),
      ]);
    })();
    this.disposePromise = cleanup;
    return cleanup;
  }
}
