import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ActivityJournal } from '../src/activity.ts';
import { ManagedPlanStore } from '../src/managed-plan.ts';
import type { ManagedPlan } from '../src/managed-schema.ts';
import { ManagedScheduler, scheduleReady, type ExecutionResult, type SchedulerRuntime } from '../src/scheduler.ts';

function plan(root: string): ManagedPlan {
  const now = 1;
  const item = (id: string, kind: ManagedPlan['workItems'][number]['kind'], dependsOn: string[], assignee?: string): ManagedPlan['workItems'][number] => ({
    id, title: id, detail: `Do ${id}`, kind, status: 'queued', dependsOn, assignee,
    attempts: 0, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [],
  });
  return {
    version: 1, team: 'demo', leadSession: 'lead',
    goal: { id: 'goal', objective: 'Build and verify', status: 'planning', repoRoot: root, baseBranch: 'develop', baseCommit: 'a'.repeat(40), createdAt: now, updatedAt: now },
    workItems: [
      item('api', 'implementation', [], 'backend'), item('ui', 'implementation', [], 'frontend'),
      item('review', 'review', ['api', 'ui'], 'backend'), item('integrate', 'integration', ['review']),
      item('verify', 'verification', ['integrate']),
    ],
    blockers: [], approvals: [],
    agents: [
      { alias: 'backend', role: 'Backend', status: 'idle', worktree: '/tmp/backend', branch: 'team/backend', lastSeen: now, restarts: 0, activitySeq: 0 },
      { alias: 'frontend', role: 'Frontend', status: 'idle', worktree: '/tmp/frontend', branch: 'team/frontend', lastSeen: now, restarts: 0, activitySeq: 0 },
    ],
  };
}

async function setup(t: TestContext, runtime: SchedulerRuntime, mutate?: (value: ManagedPlan) => ManagedPlan) {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-scheduler-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ManagedPlanStore(root);
  const value = mutate ? mutate(plan(root)) : plan(root);
  await store.create(value);
  const journal = new ActivityJournal(root);
  const scheduler = new ManagedScheduler('demo', store, journal, runtime);
  return { root, store, journal, scheduler };
}

test('scheduler runs the DAG, uses agents only for peer work, and ends at the publish gate', async (t) => {
  const calls: { item: string; alias?: string }[] = [];
  const active = { count: 0, max: 0 };
  const runtime: SchedulerRuntime = {
    now: (() => { const clock = { value: 10 }; return () => ++clock.value; })(),
    async execute(_plan, item, agent): Promise<ExecutionResult> {
      calls.push({ item: item.id, alias: agent?.alias });
      active.count++;
      active.max = Math.max(active.max, active.count);
      await new Promise(resolve => setTimeout(resolve, 5));
      active.count--;
      return { outcome: 'completed', summary: `${item.id} done`, ...(agent ? { commit: item.id.padEnd(40, 'a') } : {}), ...(item.kind === 'verification' ? { tests: ['npm test'] } : {}) };
    },
  };
  const { store, journal, scheduler } = await setup(t, runtime);
  await scheduler.start();
  await scheduler.idle();
  const result = await store.snapshot('demo', await journal.readTeam('demo', ['backend', 'frontend']));
  assert.ok(result.workItems.every(item => item.status === 'completed'));
  assert.equal(result.goal.status, 'ready');
  assert.equal(result.approvals.length, 1);
  assert.equal(result.approvals[0].kind, 'publish-pr');
  assert.ok(active.max >= 2, 'Independent work starts concurrently');
  assert.deepEqual(calls.filter(call => ['integrate', 'verify'].includes(call.item)).map(call => call.alias), [undefined, undefined]);
  assert.ok((result.activity.backend ?? []).some(event => event.kind === 'assignment'));
  assert.ok((result.activity.frontend ?? []).some(event => event.kind === 'result'));
});

test('scheduler retries recoverable work without human wake or resume', async (t) => {
  const attempts = { count: 0 };
  const runtime: SchedulerRuntime = {
    now: () => Date.now(),
    async execute(_plan, item): Promise<ExecutionResult> {
      if (item.id === 'api' && attempts.count++ === 0) return { outcome: 'failed', summary: 'Transient failure' };
      return { outcome: 'completed', summary: 'Recovered' };
    },
  };
  const { store, scheduler } = await setup(t, runtime, value => ({ ...value, workItems: value.workItems.filter(item => item.id === 'api') }));
  await scheduler.start();
  await scheduler.idle();
  const snapshot = await store.snapshot('demo');
  assert.equal(snapshot.workItems[0].status, 'completed');
  assert.equal(snapshot.workItems[0].attempts, 2);
  assert.equal(attempts.count, 2);
  assert.equal(snapshot.blockers.length, 0);
});

test('exhausted work creates a blocker and blocks its dependents', async (t) => {
  const runtime: SchedulerRuntime = { now: () => Date.now(), execute: async () => ({ outcome: 'failed', summary: 'Compiler remains broken' }) };
  const { store, scheduler } = await setup(t, runtime, value => ({
    ...value,
    workItems: value.workItems.filter(item => ['api', 'review'].includes(item.id)).map(item => item.id === 'api' ? { ...item, maxAttempts: 1 } : { ...item, dependsOn: ['api'] }),
  }));
  await scheduler.start();
  await scheduler.idle();
  const snapshot = await store.snapshot('demo');
  assert.equal(snapshot.goal.status, 'blocked');
  assert.equal(snapshot.workItems.find(item => item.id === 'api')?.status, 'failed');
  assert.equal(snapshot.workItems.find(item => item.id === 'review')?.status, 'blocked');
  assert.match(snapshot.blockers[0]?.summary ?? '', /Compiler remains broken/);
  assert.equal(snapshot.approvals.length, 0);
});

test('startup recovers an interrupted active assignment and re-runs it', async (t) => {
  const runtime: SchedulerRuntime = { now: () => Date.now(), execute: async () => ({ outcome: 'completed', summary: 'Recovered task' }) };
  const { store, scheduler } = await setup(t, runtime, value => ({
    ...value,
    workItems: value.workItems.filter(item => item.id === 'api').map(item => ({ ...item, status: 'active', attempts: 1 })),
    agents: value.agents.filter(agent => agent.alias === 'backend').map(agent => ({ ...agent, status: 'active', workItemId: 'api' })),
  }));
  await scheduler.start();
  await scheduler.idle();
  const snapshot = await store.snapshot('demo');
  assert.equal(snapshot.workItems[0].status, 'completed');
  assert.equal(snapshot.workItems[0].attempts, 1, 'An interrupted attempt is retried without exceeding the budget');
  assert.equal(snapshot.agents[0].restarts, 1);
});


test('a retry is reassigned to an idle healthy peer while partial work remains isolated', async (t) => {
  const calls: (string | undefined)[] = [];
  const runtime: SchedulerRuntime = {
    now: () => Date.now(),
    async execute(_plan, _item, agent) {
      calls.push(agent?.alias);
      return calls.length === 1 ? { outcome: 'failed', summary: 'Backend session failed' } : { outcome: 'completed', summary: 'Frontend recovered the task' };
    },
  };
  const { store, scheduler } = await setup(t, runtime, value => ({ ...value, workItems: value.workItems.filter(item => item.id === 'api') }));
  await scheduler.start();
  await scheduler.idle();
  const snapshot = await store.snapshot('demo');
  assert.deepEqual(calls, ['backend', 'frontend']);
  assert.equal(snapshot.workItems[0].status, 'completed');
  assert.equal(snapshot.workItems[0].assignee, 'frontend');
  assert.equal(snapshot.agents.find(agent => agent.alias === 'backend')?.restarts, 1);
});

test('a failed integrated verification schedules bounded corrective work and re-verifies automatically', async (t) => {
  const calls: string[] = [];
  const runtime: SchedulerRuntime = {
    now: () => Date.now(),
    async execute(_plan, item) {
      calls.push(item.id);
      if (item.id === 'verification') return { outcome: 'failed', summary: 'Tests failed: expected 200, received 500', tests: ['npm run test (failed)'] };
      return { outcome: 'completed', summary: `${item.id} done`, ...(!['verification-1'].includes(item.id) ? { commit: item.id.padEnd(40, 'c') } : {}), ...(item.id === 'verification-1' ? { tests: ['npm run test'] } : {}) };
    },
  };
  const { store, scheduler } = await setup(t, runtime, value => ({
    ...value,
    workItems: value.workItems.filter(item => ['api', 'integrate', 'verify'].includes(item.id)).map(item =>
      item.id === 'integrate' ? { ...item, dependsOn: ['api'] }
        : item.id === 'verify' ? { ...item, id: 'verification', dependsOn: ['integrate'], maxAttempts: 1 } : item),
  }));
  await scheduler.start();
  await scheduler.idle();
  const snapshot = await store.snapshot('demo');
  assert.deepEqual(calls, ['api', 'integrate', 'verification', 'corrective-1', 'integration-1', 'verification-1']);
  assert.equal(snapshot.workItems.find(item => item.id === 'verification')?.status, 'cancelled');
  assert.equal(snapshot.workItems.find(item => item.id === 'corrective-1')?.kind, 'corrective');
  assert.equal(snapshot.workItems.find(item => item.id === 'verification-1')?.status, 'completed');
  assert.equal(snapshot.goal.status, 'ready');
  assert.equal(snapshot.approvals[0]?.kind, 'publish-pr');
});


test('recovery at maxAttempts is idempotent and never exceeds the schema budget', async (t) => {
  const gate: { resolve?: () => void } = {};
  const runtime: SchedulerRuntime = {
    now: () => Date.now(),
    execute: async () => { await new Promise<void>(resolve => { gate.resolve = resolve; }); return { outcome: 'completed', summary: 'Recovered' }; },
  };
  const { store, scheduler } = await setup(t, runtime, value => ({
    ...value,
    workItems: value.workItems.filter(item => item.id === 'api').map(item => ({ ...item, status: 'active', attempts: 2, maxAttempts: 2 })),
    agents: value.agents.filter(agent => agent.alias === 'backend').map(agent => ({ ...agent, status: 'active', workItemId: 'api' })),
  }));
  await Promise.all([scheduler.start(), scheduler.start()]);
  const active = await store.snapshot('demo');
  assert.equal(active.workItems[0].attempts, 2);
  assert.equal(active.agents[0].restarts, 1);
  gate.resolve?.();
  await scheduler.idle();
  assert.equal((await store.snapshot('demo')).workItems[0].status, 'completed');
});

test('unrelated launches cannot clear an existing blocked goal', () => {
  const value = plan('/repo');
  value.goal.status = 'blocked';
  value.blockers.push({ id: 'open', workItemId: 'api', kind: 'environment', summary: 'Missing service', detail: '', status: 'open', createdAt: 1 });
  const scheduled = scheduleReady(value, 20);
  assert.ok(scheduled.launches.length > 0);
  assert.equal(scheduled.plan.goal.status, 'blocked');
});

test('an active local integration serializes later batch integrations without blocking peer work', () => {
  const value = plan('/repo');
  const completed = new Set(['api', 'ui', 'review']);
  value.workItems = [
    ...value.workItems.map(item => completed.has(item.id) ? { ...item, status: 'completed' as const, completedAt: 2 } : item.id === 'integrate' ? { ...item, status: 'active' as const, attempts: 1 } : item),
    { id: 'integration-batch', title: 'Integrate batch', detail: '', kind: 'integration', status: 'queued', dependsOn: ['review'], attempts: 0, maxAttempts: 1, createdAt: 2, updatedAt: 2, tests: [] },
  ];
  const scheduled = scheduleReady(value, 3);
  assert.equal(scheduled.plan.workItems.find(item => item.id === 'integration-batch')?.status, 'ready');
  assert.ok(!scheduled.launches.some(launch => launch.item.id === 'integration-batch'));
});


test('a paused plan launches nothing and resumes from the same durable DAG', () => {
  const value = plan('/repo');
  value.goal.status = 'paused';
  const paused = scheduleReady(value, 2);
  assert.deepEqual(paused.launches, []);
  assert.deepEqual(paused.plan, value);
  const resumed = scheduleReady({ ...paused.plan, goal: { ...paused.plan.goal, status: 'active' } }, 3);
  assert.deepEqual(new Set(resumed.launches.map(launch => launch.item.id)), new Set(['api', 'ui']));
});
