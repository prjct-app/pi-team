import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ManagedCoordinator, shouldManagePrompt } from '../src/managed.ts';
import { ManagedPlanStore } from '../src/managed-plan.ts';
import type { ManagedPlan } from '../src/managed-schema.ts';
import type { ExecutionResult, SchedulerRuntime } from '../src/scheduler.ts';
import type { ManagedWorktree } from '../src/worktrees.ts';
import { harness, until } from './harness.ts';

const exec = promisify(execFile);

function api() {
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  const userMessages: { content: unknown; options: unknown }[] = [];
  return {
    tools, entries, messages, userMessages,
    value: {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
      sendMessage: (message: unknown, options: unknown) => messages.push({ ...(message as object), options }),
      sendUserMessage: (content: unknown, options: unknown) => userMessages.push({ content, options }),
    } as unknown as ExtensionAPI,
  };
}

function context(entries: any[] = [], session = 'lead-session') {
  const widgets = new Map<string, unknown>();
  const placements: unknown[] = [];
  const statuses = new Map<string, unknown>();
  const customOptions: unknown[] = [];
  const notices: string[] = [];
  const confirmations: string[] = [];
  const selections: { title: string; options: string[] }[] = [];
  const answers: string[] = [];
  return {
    widgets, placements, statuses, customOptions, notices, confirmations, selections, answers,
    value: {
      cwd: '/repo', mode: 'tui', model: { id: 'model' }, isIdle: () => true,
      sessionManager: { getSessionId: () => session, getBranch: () => entries },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: (message: string) => notices.push(message),
        setWidget: (name: string, value: unknown, options: unknown) => { widgets.set(name, value); placements.push(options); },
        setStatus: (name: string, value: unknown) => statuses.set(name, value),
        confirm: async (title: string) => { confirmations.push(title); return true; },
        select: async (title: string, options: string[]) => { selections.push({ title, options }); return answers.shift() ?? options[0]; },
        custom: async (_factory: unknown, options: unknown) => { customOptions.push(options); return undefined; },
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
  const runtime: SchedulerRuntime & { dispose(): Promise<void> } = {
    now: () => Date.now(), async dispose() {},
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
  assert.match(coordinator.systemPrompt('BASE'), /sole interface to a managed software factory/);
  const planning = await coordinator.snapshot();
  assert.equal(planning.goal.status, 'planning');
  assert.deepEqual(ctx.placements.at(-1), { placement: 'belowEditor' });
  assert.match(String(ctx.statuses.get('managed-team')), /planning/);
  assert.match(await coordinator.guardLeadTool('read') ?? '', /only orchestrates/);
  assert.equal(await coordinator.guardLeadTool('team_plan'), undefined);
  await coordinator.open(ctx.value);
  assert.equal(ctx.customOptions.at(-1), undefined, 'The detailed view replaces the editor instead of floating as an overlay');

  const tool = extension.tools.get('team_plan');
  const result = await tool.execute('call', {
    agents: [{ alias: 'builder', role: 'Feature engineer' }],
    workItems: [{ id: 'settings', title: 'Build settings', detail: 'Implement and test it', kind: 'implementation', dependsOn: [], assignee: 'builder' }],
  });
  assert.equal(result.isError, undefined);
  await until(async () => (await coordinator.snapshot()).goal.status === 'ready');
  const firstReady = await coordinator.snapshot();
  assert.deepEqual(firstReady.workItems.map(item => item.status), ['completed', 'completed', 'completed']);
  assert.equal(firstReady.approvals[0].kind, 'publish-pr');
  assert.ok((firstReady.activity.builder ?? []).some(event => event.kind === 'result'));
  await coordinator.appendObjective('Audit the completed settings flow for security');
  const addTool = extension.tools.get('team_plan_add');
  const added = await addTool.execute('add', {
    workItems: [{ id: 'security-audit', title: 'Audit settings security', detail: 'Review the integrated behavior', kind: 'review', dependsOn: ['verification'], assignee: 'builder' }],
  });
  assert.equal(added.isError, undefined);
  await until(async () => (await coordinator.snapshot()).goal.status === 'ready');
  const ready = await coordinator.snapshot();
  assert.equal(ready.workItems.length, 6);
  assert.ok(ready.workItems.every(item => item.status === 'completed'));
  assert.equal(ready.approvals[0].kind, 'publish-pr');

  await until(() => extension.messages.filter(message => message.customType === 'managed-team-update').length === 2);
  assert.equal(extension.messages.filter(message => message.customType === 'managed-team-update').length, 2, 'Each completed work batch reports independently');
  const gate = extension.tools.get('team_gate_report');
  const unauthorized = await gate.execute('gate', { kind: 'publish-pr', evidence: 'not actually published' });
  assert.equal(unauthorized.isError, true);
  await coordinator.approve('publish-pr', ctx.value);
  const granted = await coordinator.store.read(ready.team);
  assert.equal(granted?.payload.approvals[0].status, 'granted');
  assert.equal(granted?.payload.approvals[0].actor, 'user');
  assert.equal(typeof granted?.payload.approvals[0].decidedAt, 'number');
  assert.equal(await coordinator.guardLeadTool('bash'), undefined, 'An explicit publication grant permits the lead to execute the gate');
  assert.match(await coordinator.guardLeadTool('edit') ?? '', /only orchestrates/);
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
  await coordinator.shutdown();
});

test('coordinator shutdown is idempotent and awaits runtime disposal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-coordinator-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = api();
  const ctx = context(extension.entries);
  const gate: { resolve?: () => void } = {};
  const disposed = { count: 0 };
  const runtime: SchedulerRuntime & { dispose(): Promise<void> } = {
    now: () => Date.now(),
    execute: async () => new Promise<ExecutionResult>(() => {}),
    dispose() {
      disposed.count++;
      return new Promise<void>(resolve => { gate.resolve = resolve; });
    },
  };
  const coordinator = new ManagedCoordinator(extension.value, {
    root,
    discover: async () => ({ root: '/repo', branch: 'develop', head: 'a'.repeat(40), clean: true }),
    worktrees: worktrees(), runtimeFactory: () => runtime,
  });
  await coordinator.activate('Implement an owned runtime shutdown test', ctx.value);
  await coordinator.submit({
    agents: [{ alias: 'builder', role: 'Feature engineer' }],
    workItems: [{ id: 'owned-work', title: 'Owned work', detail: 'Stay active until shutdown', kind: 'implementation', dependsOn: [], assignee: 'builder' }],
  });
  const first = coordinator.shutdown();
  const second = coordinator.shutdown();
  assert.equal(first, second);
  assert.equal(disposed.count, 1);
  const settled = { value: false };
  void first.then(() => { settled.value = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled.value, false);
  gate.resolve?.();
  await first;
  assert.equal(settled.value, true);
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
  await h.emit('input', { source: 'interactive', text: 'Add a focused security audit to the team work' });
  const extendedStatus = await h.tools.get('team_plan_status').execute('call', {});
  const extendedObjective = JSON.parse(extendedStatus.content[0].text).goal.objective;
  assert.match(extendedObjective, /Additional work:.*security audit/s);
  await h.emit('input', { source: 'interactive', text: 'How is the team doing?' });
  const chatStatus = await h.tools.get('team_plan_status').execute('call', {});
  assert.equal(JSON.parse(chatStatus.content[0].text).goal.objective, extendedObjective, 'Normal chat does not create work');
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
  assert.deepEqual(h.commands.get('team').getArgumentCompletions('').map((item: { label: string }) => item.label), ['plan', 'terminal', 'control', 'approve']);
  const objective = 'revisa que mejoras podemos hacer considerando performance eficiencia y seguridad';
  await h.command(objective);
  assert.equal(h.userMessages.length, 1);
  assert.deepEqual(h.userMessages[0], { content: objective, options: { expandPromptTemplates: false } });
  assert.ok(h.entries.some(entry => entry.customType === 'managed-team'));
  const additional = 'audita también la accesibilidad del repositorio';
  await h.command(additional);
  assert.equal(h.userMessages.length, 2, 'Additional work stays conversational while the factory remains active');
  assert.deepEqual(h.userMessages[1], { content: additional, options: { deliverAs: 'followUp', expandPromptTemplates: false } });
  const status = await h.tools.get('team_plan_status').execute('call', {});
  assert.match(JSON.parse(status.content[0].text).goal.objective, /Additional work:.*accesibilidad/s);
  await h.emit('session_shutdown');
});

test('repository teams are discovered before creation, can receive queued work, and remain monitorable across lead sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-repository-routing-'));
  const ownerApi = api();
  const ownerContext = context(ownerApi.entries, 'owner-session');
  const owner = new ManagedCoordinator(ownerApi.value, {
    root, discover: async () => ({ root: '/repo', branch: 'develop', head: 'a'.repeat(40), clean: true }),
    worktrees: worktrees(), refreshMs: 10,
  });
  await owner.activate('Implement the account login flow', ownerContext.value, true);

  const requesterApi = api();
  const requesterContext = context(requesterApi.entries, 'requester-session');
  const requester = new ManagedCoordinator(requesterApi.value, {
    root, discover: async () => ({ root: '/repo', branch: 'develop', head: 'a'.repeat(40), clean: true }),
    worktrees: worktrees(), refreshMs: 10,
  });
  const routed = await requester.routeObjective('Fix the production login bug', requesterContext.value, true);
  assert.equal(routed, 'handled');
  assert.match(requesterContext.selections[0]?.title ?? '', /Which existing team/);
  assert.match(requesterContext.selections[0]?.options[0] ?? '', /account login flow/);
  await until(() => ownerApi.userMessages.some(message => String(message.content).includes('production login bug')));
  const ownerPlan = await owner.snapshot();
  assert.equal(ownerPlan.requests?.[0]?.status, 'dispatched');
  assert.match(ownerPlan.goal.objective, /Additional work:.*production login bug/s);

  await requester.open(requesterContext.value);
  assert.equal(requesterContext.customOptions.length, 1, 'A different lead can monitor the repository plan without taking ownership');
  await Promise.all([owner.shutdown(), requester.shutdown()]);
  await new Promise(resolve => setTimeout(resolve, 30));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test('user control can unblock and retry exhausted work with a durable audit record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const blocked: ManagedPlan = {
    version: 1, team: 'team-login', leadSession: 'other-session',
    goal: { id: 'goal', objective: 'Fix production login', status: 'blocked', repoRoot: '/repo', baseBranch: 'develop', baseCommit: 'a'.repeat(40), createdAt: now, updatedAt: now },
    workItems: [{ id: 'login-fix', title: 'Repair login', detail: '', kind: 'implementation', status: 'failed', dependsOn: [], assignee: 'backend', attempts: 2, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] }],
    blockers: [{ id: 'blocker', workItemId: 'login-fix', kind: 'unknown', summary: 'Peer exhausted retries', detail: '', status: 'open', owner: 'backend', createdAt: now }],
    approvals: [], agents: [{ alias: 'backend', role: 'Backend engineer', status: 'failed', worktree: '/managed/backend', branch: 'pi-team/team-login/backend', lastSeen: now, restarts: 0, activitySeq: 0 }],
  };
  const store = new ManagedPlanStore(root);
  await store.create(blocked);
  const extension = api();
  const ctx = context(extension.entries);
  ctx.answers.push('Retry blocked work', 'login-fix · failed · Repair login · backend');
  const coordinator = new ManagedCoordinator(extension.value, {
    root, store, discover: async () => ({ root: '/repo', branch: 'develop', head: 'a'.repeat(40), clean: true }), worktrees: worktrees(), refreshMs: 20,
  });
  await coordinator.control(ctx.value);
  const updated = await store.read('team-login');
  assert.equal(updated?.payload.workItems[0]?.status, 'ready');
  assert.equal(updated?.payload.workItems[0]?.maxAttempts, 3);
  assert.equal(updated?.payload.blockers[0]?.status, 'resolved');
  assert.equal(updated?.payload.controls?.at(-1)?.action, 'retry-work');
  await coordinator.shutdown();
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
  await coordinator.shutdown();
});
