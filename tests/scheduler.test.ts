import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ActivityJournal } from '../src/activity.ts';
import { ManagedPlanStore } from '../src/managed-plan.ts';
import type { ManagedPlan } from '../src/managed-schema.ts';
import { ManagedScheduler, type ExecutionResult, type SchedulerRuntime } from '../src/scheduler.ts';

function plan(root: string): ManagedPlan {
  const now = 1;
  const item = (id: string, kind: ManagedPlan['workItems'][number]['kind'], dependsOn: string[], assignee?: string): ManagedPlan['workItems'][number] => ({
    id, title: id, detail: `Do ${id}`, kind, status: 'queued', dependsOn, assignee,
    attempts: 0, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [],
  });
  return {
    version: 1, team: 'demo', leadSession: 'lead',
    goal: { id: 'goal', objective: 'Build and verify', status: 'planning', repoRoot: root, baseBranch: 'develop', createdAt: now, updatedAt: now },
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
  assert.equal(snapshot.workItems[0].attempts, 2);
  assert.equal(snapshot.agents[0].restarts, 1);
});
