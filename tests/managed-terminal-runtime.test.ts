import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManagedTerminalRuntime, openTerminalSession, terminalSessionId, terminalSessionName, type TerminalCommand } from '../src/managed-terminal-runtime.ts';
import type { Membership, Message, Snapshot } from '../src/mailbox.ts';
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

test('managed peer work runs through a persistent tmux Pi terminal and durable mailbox', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: { program: string; args: readonly string[] }[] = [];
  const run: TerminalCommand = async (program, args) => {
    calls.push({ program, args });
    if (args[0] === 'has-session') throw new Error('missing');
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
  assert.ok(!calls.some(call => call.args[0] === 'send-keys'));
  assert.ok(!calls.some(call => call.args[0] === 'kill-session'));
  assert.ok(!calls.some(call => call.args[0] === 'new-session'));
});
