import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManagedTerminalRuntime, openTerminalSession, terminalSessionId, terminalSessionName, type TerminalCommand } from '../src/managed-terminal-runtime.ts';
import type { Membership, Message, Snapshot } from '../src/mailbox.ts';
import type { ProcessController, ProcessIdentity } from '../src/process-identity.ts';
import type { ManagedAgentState, ManagedPlan, WorkItem } from '../src/managed-schema.ts';

const member: Membership = { team: 'demo', alias: 'managed-lead', session: 'managed', token: 'token' };
const agent: ManagedAgentState = {
  alias: 'backend', role: 'Backend engineer', status: 'idle', worktree: '/work/backend', branch: 'pi-team/demo/backend',
  lastSeen: 1, restarts: 0, activitySeq: 0,
};
const reviewer: ManagedAgentState = {
  alias: 'reviewer', role: 'Reviewer', status: 'idle', worktree: '/work/reviewer', branch: 'pi-team/demo/reviewer',
  lastSeen: 1, restarts: 0, activitySeq: 0,
};
const item: WorkItem = {
  id: 'login', title: 'Fix login', detail: 'Repair the production login flow', kind: 'implementation', status: 'active', dependsOn: [],
  assignee: 'backend', attempts: 1, maxAttempts: 2, createdAt: 1, updatedAt: 1, tests: [],
};
const plan: ManagedPlan = {
  version: 1, team: 'demo', leadSession: 'lead',
  goal: { id: 'goal', objective: 'Fix production login', status: 'active', repoRoot: '/repo', baseBranch: 'develop', baseCommit: 'a'.repeat(40), createdAt: 1, updatedAt: 1 },
  workItems: [item], blockers: [], approvals: [], agents: [agent, reviewer],
};

function snapshot(): Snapshot {
  const communication: Message = { id: 'peer-note', team: 'demo', from: 'backend', to: 'reviewer', subject: 'Login contract', body: 'The endpoint now returns 401 consistently.', kind: 'note', state: 'seen', created: 1, rootId: 'peer-note' };
  return { revision: 1, sweepable: false, members: [
    { ...member, alias: 'backend', cwd: agent.worktree, pid: 2, seen: Date.now(), status: 'idle' },
    { ...member, alias: 'reviewer', cwd: reviewer.worktree, pid: 3, seen: Date.now(), status: 'idle' },
  ], messages: [communication], flow: [] };
}

test('terminal session names are stable and an attach opens a real terminal window', async () => {
  assert.equal(terminalSessionName('demo', 'backend'), terminalSessionName('demo', 'backend'));
  assert.match(terminalSessionId('demo', 'backend'), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  const calls: { program: string; args: readonly string[] }[] = [];
  const run: TerminalCommand = async (program, args) => { calls.push({ program, args }); };
  const attach = await openTerminalSession('demo', 'backend', run);
  assert.match(attach, /^tmux attach-session/);
  assert.equal(calls[0]?.program, 'tmux');
  assert.equal(calls[1]?.program, process.platform === 'darwin' ? 'open' : 'x-terminal-emulator');
});

test('shutdown timing configuration rejects non-progressing waits', () => {
  assert.throws(() => new ManagedTerminalRuntime({
    team: 'demo', shutdownTimings: { pollMs: 0 },
    worktrees: {
      allocate: async () => ({ alias: 'integration', path: '/integration', branch: 'pi-team/demo/integration', head: 'a'.repeat(40), reused: false }),
      integrate: async () => ({ ok: true as const, head: 'b'.repeat(40), applied: [] }),
      git: async () => ({ stdout: 'a'.repeat(40), stderr: '' }), commit: async () => ({ head: 'a'.repeat(40), changed: false }),
    },
  }), /positive poll interval/);
});

test('managed peer work runs through a persistent tmux Pi terminal and durable mailbox', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: { program: string; args: readonly string[] }[] = [];
  const metadata = new Map<string, string>();
  const run: TerminalCommand = async (program, args) => {
    calls.push({ program, args });
    if (args[0] === 'has-session') throw new Error('missing');
    if (args[0] === 'set-option') metadata.set(String(args[3]), String(args[4]));
    if (args[0] === 'display-message' && String(args.at(-1)).includes('@pi-team-runtime-id')) {
      return { stdout: `${metadata.get('@pi-team-runtime-id')}\t${metadata.get('@pi-team-owner-instance')}\t${metadata.get('@pi-team-token-hash')}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const request: Message = { id: 'request-1', team: 'demo', from: member.alias, to: 'backend', subject: 'login', body: 'work', kind: 'request', state: 'pending', created: 1, rootId: 'request-1' };
  const result: Message = { id: 'result-1', team: 'demo', from: 'backend', to: member.alias, subject: 'result', body: 'done', kind: 'result', state: 'pending', created: 2, rootId: 'request-1', parentId: request.id,
    result: { outcome: 'completed', body: 'Login fixed', files: ['src/login.ts'], tests: ['npm test'] } };
  const sent: unknown[] = [];
  const communications: unknown[] = [];
  const runtime = new ManagedTerminalRuntime({
    team: 'demo', agentDir: root, command: run, pollMs: 1,
    communicate: async (from, to, message, workItemId) => { communications.push({ from, to, message, workItemId }); },
    mailbox: {
      teams: async () => [], create: async () => {}, join: async () => member, leave: async () => {}, heartbeat: async () => {},
      snapshot: async () => snapshot(), send: async (_membership, outgoing) => { sent.push(outgoing); return request; }, receive: async () => result,
    },
    worktrees: {
      allocate: async () => ({ alias: 'integration', path: '/integration', branch: 'pi-team/demo/integration', head: 'a'.repeat(40), reused: false }),
      integrate: async () => ({ ok: true as const, head: 'b'.repeat(40), applied: [] }),
      git: async () => ({ stdout: 'a'.repeat(40), stderr: '' }),
      commit: async () => ({ head: 'b'.repeat(40), changed: true }),
    },
  });
  t.after(() => runtime.dispose());
  await runtime.prepare(plan);
  const outcome = await runtime.execute(plan, item, agent);
  await runtime.resumeAgent('backend');
  assert.equal(outcome.outcome, 'completed');
  assert.equal(outcome.commit, 'b'.repeat(40));
  assert.match(String((sent[0] as { body?: string }).body), /team_send/);
  assert.deepEqual(communications, [{ from: 'backend', to: 'reviewer', message: 'Login contract: The endpoint now returns 401 consistently.', workItemId: undefined }]);
  const launch = calls.find(call => call.args[0] === 'new-session' && call.args.includes('PI_TEAM_MANAGED_ALIAS=backend'));
  assert.ok(launch);
  assert.ok(launch.args.indexOf('--') < launch.args.indexOf('PI_TEAM_MANAGED_TEAM=demo'));
  assert.ok(launch.args.includes('PI_TEAM_MANAGED_TEAM=demo'));
  assert.ok(launch.args.includes('PI_TEAM_MANAGED_ALIAS=backend'));
  assert.ok(launch.args.includes('PI_TEAM_AUTO_TURNS=0'));
  assert.ok(launch.args.includes('--no-extensions'));
  assert.ok(launch.args.includes('--session-id'));
  assert.ok(launch.args.includes('/team join demo backend'));
  assert.ok(calls.some(call => call.args.includes('/team resume')));
});

test('an existing terminal is accepted only through durable membership without injecting keys or killing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-terminal-rejoin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: { program: string; args: readonly string[] }[] = [];
  const runtime = new ManagedTerminalRuntime({
    team: 'demo', agentDir: root,
    command: async (program, args) => { calls.push({ program, args }); },
    mailbox: {
      teams: async () => ['demo'], create: async () => {}, join: async () => member, leave: async () => {}, heartbeat: async () => {},
      snapshot: async () => snapshot(), send: async () => { throw new Error('unused'); }, receive: async () => undefined,
    },
    worktrees: {
      allocate: async () => ({ alias: 'integration', path: '/integration', branch: 'pi-team/demo/integration', head: 'a'.repeat(40), reused: false }),
      integrate: async () => ({ ok: true as const, head: 'b'.repeat(40), applied: [] }),
      git: async () => ({ stdout: 'a'.repeat(40), stderr: '' }), commit: async () => ({ head: 'a'.repeat(40), changed: false }),
    },
  });
  t.after(() => runtime.dispose());
  await runtime.prepare(plan);
  await runtime.dispose();
  assert.ok(!calls.some(call => call.args[0] === 'send-keys'));
  assert.ok(!calls.some(call => call.args[0] === 'kill-session'));
  assert.ok(!calls.some(call => call.args[0] === 'new-session'));
});

type ControlledTerminal = {
  runtime: ManagedTerminalRuntime;
  calls: { program: string; args: readonly string[] }[];
  signals: NodeJS.Signals[];
  metadata: Map<string, string>;
};

function controlledTerminal(root: string, inspect: ProcessController['inspect'], onSignal?: (signal: NodeJS.Signals) => void, failOption?: string): ControlledTerminal {
  const calls: { program: string; args: readonly string[] }[] = [];
  const signals: NodeJS.Signals[] = [];
  const metadata = new Map<string, string>();
  const environment = new Map<string, string>();
  const run: TerminalCommand = async (program, args) => {
    calls.push({ program, args });
    if (args[0] === 'has-session') throw new Error('missing');
    if (args[0] === 'new-session') {
      for (const value of args.filter(value => /^PI_TEAM_(?:RUNTIME_ID|OWNER_INSTANCE|TOKEN_HASH)=/.test(value))) {
        const separator = value.indexOf('=');
        environment.set(value.slice(0, separator), value.slice(separator + 1));
      }
    }
    if (args[0] === 'set-option') {
      if (args[3] === failOption) throw new Error('set-option failed');
      metadata.set(String(args[3]), String(args[4]));
    }
    if (args[0] === 'show-environment') return { stdout: [...environment].map(([key, value]) => `${key}=${value}`).join('\n'), stderr: '' };
    if (args[0] === 'display-message' && args.at(-1) === '#{pane_pid}') return { stdout: '4321\n', stderr: '' };
    if (args[0] === 'display-message' && String(args.at(-1)).includes('@pi-team-runtime-id')) {
      return { stdout: `${metadata.get('@pi-team-runtime-id')}\t${metadata.get('@pi-team-owner-instance')}\t${metadata.get('@pi-team-token-hash')}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const processController: ProcessController = {
    inspect,
    async signal(_identity, signal) { signals.push(signal); onSignal?.(signal); return true; },
    async delay() {},
  };
  const runtime = new ManagedTerminalRuntime({
    team: 'demo', agentDir: root, command: run, processController,
    shutdownTimings: { gracefulMs: 0, termMs: 0, killMs: 0, pollMs: 1 },
    ownerInstanceId: 'owner-instance', ownershipToken: 'owner-token',
    mailbox: {
      teams: async () => ['demo'], create: async () => {}, join: async () => member, leave: async () => {}, heartbeat: async () => {},
      snapshot: async () => snapshot(), send: async () => { throw new Error('unused'); }, receive: async () => undefined,
    },
    worktrees: {
      allocate: async () => ({ alias: 'integration', path: '/integration', branch: 'pi-team/demo/integration', head: 'a'.repeat(40), reused: false }),
      integrate: async () => ({ ok: true as const, head: 'b'.repeat(40), applied: [] }),
      git: async () => ({ stdout: 'a'.repeat(40), stderr: '' }), commit: async () => ({ head: 'a'.repeat(40), changed: false }),
    },
  });
  return { runtime, calls, signals, metadata };
}

test('disposing an owned terminal escalates in order and is idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-terminal-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity: ProcessIdentity = { processPid: 4321, processGroupId: 8765, processStartToken: 'start-a' };
  const alive = { value: true };
  const controlled = controlledTerminal(root, async () => alive.value ? identity : undefined, signal => {
    if (signal === 'SIGKILL') alive.value = false;
  });
  await controlled.runtime.prepare({ ...plan, agents: [agent] });
  await Promise.all([controlled.runtime.dispose(), controlled.runtime.dispose()]);
  assert.deepEqual(controlled.signals, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
  assert.equal(controlled.calls.filter(call => call.args[0] === 'kill-session').length, 1);
  assert.ok(controlled.calls.some(call => call.args[0] === 'set-option' && call.args.includes('@pi-team-runtime-id')));
});

test('a partial tmux metadata write still cleans up the session created by this launch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-terminal-partial-mark-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controlled = controlledTerminal(root, async () => undefined, undefined, '@pi-team-owner-instance');
  await assert.rejects(controlled.runtime.prepare({ ...plan, agents: [agent] }), /set-option failed/);
  await controlled.runtime.dispose();
  assert.deepEqual(controlled.signals, []);
  assert.equal(controlled.calls.filter(call => call.args[0] === 'kill-session').length, 1);
});

test('changed tmux ownership metadata blocks signals and session termination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-terminal-token-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity: ProcessIdentity = { processPid: 4321, processGroupId: 8765, processStartToken: 'start-a' };
  const controlled = controlledTerminal(root, async () => identity);
  await controlled.runtime.prepare({ ...plan, agents: [agent] });
  controlled.metadata.set('@pi-team-token-hash', 'replaced-owner');
  await assert.rejects(controlled.runtime.dispose(), /ownership metadata changed/);
  assert.deepEqual(controlled.signals, []);
  assert.equal(controlled.calls.filter(call => call.args[0] === 'kill-session').length, 0);
});

test('a reused PID is never signalled during terminal shutdown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-terminal-pid-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original: ProcessIdentity = { processPid: 4321, processGroupId: 8765, processStartToken: 'start-a' };
  const replacement: ProcessIdentity = { ...original, processStartToken: 'start-b' };
  const inspections = { count: 0 };
  const controlled = controlledTerminal(root, async () => ++inspections.count === 1 ? original : replacement);
  await controlled.runtime.prepare({ ...plan, agents: [agent] });
  await controlled.runtime.dispose();
  assert.deepEqual(controlled.signals, []);
  assert.equal(controlled.calls.filter(call => call.args[0] === 'kill-session').length, 1,
    'The token-verified tmux session is removed without signalling the reused PID');
});
