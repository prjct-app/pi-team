import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ManagedCoordinator, shouldManagePrompt } from '../src/managed.ts';
import type { ExecutionResult, SchedulerRuntime } from '../src/scheduler.ts';
import type { ManagedWorktree } from '../src/worktrees.ts';
import { harness, until } from './harness.ts';

const exec = promisify(execFile);

function api() {
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  return {
    tools, entries, messages,
    value: {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
      sendMessage: (message: unknown, options: unknown) => messages.push({ ...(message as object), options }),
    } as unknown as ExtensionAPI,
  };
}

function context(entries: any[] = []) {
  const widgets = new Map<string, unknown>();
  const notices: string[] = [];
  const confirmations: string[] = [];
  return {
    widgets, notices, confirmations,
    value: {
      cwd: '/repo', mode: 'tui', model: { id: 'model' },
      sessionManager: { getSessionId: () => 'lead-session', getBranch: () => entries },
      ui: {
        notify: (message: string) => notices.push(message),
        setWidget: (name: string, value: unknown) => widgets.set(name, value),
        confirm: async (title: string) => { confirmations.push(title); return true; },
        custom: async () => undefined,
      },
    } as unknown as ExtensionContext,
  };
}

function worktrees() {
  return {
    git: async () => ({ stdout: 'a'.repeat(40), stderr: '' }),
    allocate: async (_root: string, team: string, alias: string): Promise<ManagedWorktree> => ({ alias, path: `/managed/${alias}`, branch: `pi-team/${team}/${alias}`, head: 'a'.repeat(40), reused: false }),
    commit: async () => ({ head: 'b'.repeat(40), changed: true }),
    integrate: async () => ({ ok: true as const, head: 'c'.repeat(40), applied: [] }),
  };
}

test('prompt classification starts implementation objectives but leaves questions and commands alone', () => {
  assert.equal(shouldManagePrompt('Implement a secure authentication endpoint'), true);
  assert.equal(shouldManagePrompt('Arregla el flujo de autenticación completo'), true);
  assert.equal(shouldManagePrompt('What does this function do?'), false);
  assert.equal(shouldManagePrompt('/team status'), false);
  assert.equal(shouldManagePrompt('fix'), false);
});

test('one normal prompt creates a plan; blueprint submission advances autonomously to a user-only publish gate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-coordinator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = api();
  const ctx = context(extension.entries);
  const runtime: SchedulerRuntime & { dispose(): void } = {
    now: () => Date.now(), dispose() {},
    async execute(_plan, item): Promise<ExecutionResult> {
      return { outcome: 'completed', summary: `${item.id} complete`, ...(item.kind === 'implementation' || item.kind === 'integration' ? { commit: item.id.padEnd(40, 'a') } : {}), ...(item.kind === 'verification' ? { tests: ['npm run test'] } : {}) };
    },
  };
  const coordinator = new ManagedCoordinator(extension.value, {
    root,
    discover: async () => ({ root: '/repo', branch: 'develop', head: 'a'.repeat(40), clean: true }),
    worktrees: worktrees(), runtimeFactory: () => runtime, refreshMs: 20,
  });
  await coordinator.activate('Implement the complete account settings flow', ctx.value);
  assert.ok(extension.entries.some(entry => entry.customType === 'managed-team'));
  assert.match(coordinator.systemPrompt('BASE'), /sole interface to a managed team/);
  const planning = await coordinator.snapshot();
  assert.equal(planning.goal.status, 'planning');

  const tool = extension.tools.get('team_plan');
  const result = await tool.execute('call', {
    agents: [{ alias: 'builder', role: 'Feature engineer' }],
    workItems: [{ id: 'settings', title: 'Build settings', detail: 'Implement and test it', kind: 'implementation', dependsOn: [], assignee: 'builder' }],
  });
  assert.equal(result.isError, undefined);
  await until(async () => (await coordinator.snapshot()).goal.status === 'ready');
  const ready = await coordinator.snapshot();
  assert.deepEqual(ready.workItems.map(item => item.status), ['completed', 'completed', 'completed']);
  assert.equal(ready.approvals[0].kind, 'publish-pr');
  assert.ok((ready.activity.builder ?? []).some(event => event.kind === 'result'));

  await until(() => extension.messages.some(message => message.customType === 'managed-team-update'));
  assert.equal(extension.messages.filter(message => message.customType === 'managed-team-update').length, 1);
  const gate = extension.tools.get('team_gate_report');
  const unauthorized = await gate.execute('gate', { kind: 'publish-pr', evidence: 'not actually published' });
  assert.equal(unauthorized.isError, true);
  await coordinator.approve('publish-pr', ctx.value);
  const granted = await coordinator.store.read(ready.team);
  assert.equal(granted?.payload.approvals[0].status, 'granted');
  assert.equal(granted?.payload.approvals[0].actor, 'user');
  assert.equal(typeof granted?.payload.approvals[0].decidedAt, 'number');
  assert.deepEqual(ctx.confirmations, ['Approve publish-pr?']);
  assert.ok(extension.messages.some(message => message.customType === 'managed-team-approval'));

  const published = await gate.execute('gate', { kind: 'publish-pr', evidence: 'https://github.com/example/repo/pull/42' });
  assert.equal(published.isError, undefined);
  const shipGate = await coordinator.snapshot();
  assert.deepEqual(shipGate.approvals.map(approval => approval.kind), ['ship']);
  await coordinator.approve('ship', ctx.value);
  const shipped = await gate.execute('gate', { kind: 'ship', evidence: 'Merged PR 42 and deployed release 1.2.3' });
  assert.equal(shipped.isError, undefined);
  assert.equal((await coordinator.snapshot()).goal.status, 'completed');
  assert.deepEqual(ctx.confirmations, ['Approve publish-pr?', 'Approve ship?']);
  const completedTeam = (await coordinator.snapshot()).team;
  await coordinator.activate('Implement a second independent feature', ctx.value);
  assert.notEqual((await coordinator.snapshot()).team, completedTeam);
  assert.equal((await coordinator.snapshot()).goal.status, 'planning');
  coordinator.shutdown();
});

test('the installed extension activates from ordinary input without create, join, wake, or resume', async (t) => {
  const repository = await mkdtemp(join(tmpdir(), 'pi-team-prompt-repo-'));
  const root = await mkdtemp(join(tmpdir(), 'pi-team-prompt-store-'));
  const managedRoot = join(root, 'managed');
  const h = harness(join(root, 'mailbox'), 'lead-session', [], { cwd: repository, managedRoot });
  t.after(async () => { await h.emit('session_shutdown'); await rm(repository, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  await exec('git', ['init', '-b', 'develop', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'tests@example.com']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Pi Team Tests']);
  await writeFile(join(repository, 'README.md'), 'base\n');
  await exec('git', ['-C', repository, 'add', 'README.md']);
  await exec('git', ['-C', repository, 'commit', '-m', 'chore: initial']);
  await h.emit('session_start', { reason: 'startup' });
  await h.emit('input', { source: 'interactive', text: 'Implement a coordinated account settings feature' });
  const [patch] = await h.emit('before_agent_start', { systemPrompt: 'BASE' }) as [{ systemPrompt: string }];
  assert.match(patch.systemPrompt, /call team_plan exactly once/);
  const status = await h.tools.get('team_plan_status').execute('call', {});
  const snapshot = JSON.parse(status.content[0].text);
  assert.equal(snapshot.goal.status, 'planning');
  assert.match(h.notices.at(-1) ?? '', /is planning from develop@/);
  assert.ok(!h.notices.some(notice => /Joined|wake|resume/.test(notice)));
  await h.command('create manual');
  await h.command('join manual lead');
  assert.match(h.notices.at(-1) ?? '', /already leads a managed team/);
});


test('an explicit /team objective starts managed work and forwards the objective as a user turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-command-objective-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(join(root, 'README.md'), '# fixture');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
  const h = harness(join(root, '.mailbox'), 'lead-command', [], { cwd: root, managedRoot: join(root, '.managed') });
  await h.emit('session_start', { reason: 'startup' });
  const objective = 'revisa que mejoras podemos hacer considerando performance eficiencia y seguridad';
  await h.command(objective);
  assert.equal(h.userMessages.length, 1);
  assert.deepEqual(h.userMessages[0], { content: objective, options: { expandPromptTemplates: false } });
  assert.ok(h.entries.some(entry => entry.customType === 'managed-team'));
  await h.command('audita también la accesibilidad del repositorio');
  assert.equal(h.userMessages.length, 1, 'A second explicit objective must not diverge from the durable active goal');
  assert.match(h.notices.at(-1) ?? '', /already active/);
  await h.emit('session_shutdown');
});

test('dirty user checkout state is preserved and excluded rather than blocking autonomous work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-coordinator-dirty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = api();
  const ctx = context(extension.entries);
  const coordinator = new ManagedCoordinator(extension.value, {
    root, discover: async () => ({ root: '/repo', branch: 'feature/user', head: 'a'.repeat(40), clean: false }), worktrees: worktrees(),
  });
  await coordinator.activate('Build a new reporting dashboard', ctx.value);
  assert.equal((await coordinator.snapshot()).goal.baseCommit, 'a'.repeat(40));
  assert.ok(ctx.notices.some(notice => /changes remain untouched and are not included/i.test(notice)));
  coordinator.shutdown();
});
