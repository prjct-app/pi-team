import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildTeamView, ManagedPlanStore, assertManagedPlan } from '../src/managed-plan.ts';
import type { ManagedPlan } from '../src/managed-schema.ts';

function plan(root: string): ManagedPlan {
  const now = Date.now();
  return {
    version: 1,
    team: 'managed-demo',
    leadSession: 'lead-session',
    goal: {
      id: 'goal-1', objective: 'Implement the release safely', status: 'active',
      repoRoot: root, baseBranch: 'develop', baseCommit: 'a'.repeat(40), createdAt: now, updatedAt: now,
    },
    workItems: [
      { id: 'design', title: 'Design', detail: '', kind: 'plan', status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 2, createdAt: now, updatedAt: now, completedAt: now, tests: [] },
      { id: 'api', title: 'Build API', detail: '', kind: 'implementation', status: 'active', dependsOn: ['design'], assignee: 'backend', attempts: 1, maxAttempts: 2, createdAt: now, updatedAt: now, startedAt: now, tests: [] },
      { id: 'ui', title: 'Build UI', detail: '', kind: 'implementation', status: 'waiting', dependsOn: ['api'], assignee: 'frontend', attempts: 0, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] },
      { id: 'verify', title: 'Verify', detail: '', kind: 'verification', status: 'queued', dependsOn: ['ui'], attempts: 0, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] },
    ],
    blockers: [],
    approvals: [{ id: 'publish', kind: 'publish-pr', status: 'required', summary: 'Publish branch and open PR', requestedAt: now }],
    agents: [
      { alias: 'backend', role: 'Backend engineer', status: 'active', worktree: join(root, 'backend'), branch: 'team/backend', workItemId: 'api', lastSeen: now, restarts: 0, activitySeq: 2 },
      { alias: 'frontend', role: 'Frontend engineer', status: 'waiting', worktree: join(root, 'frontend'), branch: 'team/frontend', lastSeen: now, restarts: 0, activitySeq: 0 },
    ],
  };
}

test('managed plan validates references, acyclicity, assignments, and user-only approvals', () => {
  const value = plan('/repo');
  assert.doesNotThrow(() => assertManagedPlan(value));
  assert.throws(() => assertManagedPlan({ ...value, workItems: value.workItems.map(item =>
    item.id === 'api' ? { ...item, dependsOn: ['missing'] } : item) }), /dependencies/);
  assert.throws(() => assertManagedPlan({ ...value, workItems: value.workItems.map(item =>
    item.id === 'design' ? { ...item, dependsOn: ['verify'] } : item) }), /acyclic/);
  assert.throws(() => assertManagedPlan({ ...value, approvals: [{ ...value.approvals[0], status: 'granted' }] }), /only be decided by the user/);
  assert.throws(() => assertManagedPlan({ ...value, workItems: value.workItems.map(item => item.id === 'api' ? { ...item, attempts: 3 } : item) }), /cannot exceed/);
  assert.throws(() => assertManagedPlan({ ...value, approvals: [value.approvals[0], value.approvals[0]] }), /approval ids/);
  const control = { id: 'control', action: 'cancel-work' as const, actor: 'user' as const, target: 'api', at: 1 };
  assert.throws(() => assertManagedPlan({ ...value, controls: [control, control] }), /control ids/);
  assert.throws(() => assertManagedPlan({ ...value, controls: [{ ...control, target: 'missing' }] }), /control targets/);
  assert.throws(() => assertManagedPlan({ ...value, communications: [{ id: 'message', from: 'backend', to: 'missing', message: 'Review API', workItemId: 'api', at: 1 }] }), /communication/);
  assert.throws(() => assertManagedPlan({ ...value, unexpected: true }), /Invalid managed team plan/);
});

test('team view derives progress, dependencies, blockers, approvals, and the remaining critical path', () => {
  const value = plan('/repo');
  const view = buildTeamView(7, value, { backend: [{ seq: 1, at: 1, alias: 'backend', kind: 'progress', summary: 'Working' }] });
  assert.deepEqual(view.progress, { completed: 1, total: 4, percent: 25 });
  assert.deepEqual(view.criticalPath, ['api', 'ui', 'verify']);
  assert.deepEqual(view.dependencies.map(edge => [edge.from, edge.to, edge.status]), [
    ['design', 'api', 'satisfied'], ['api', 'ui', 'waiting'], ['ui', 'verify', 'waiting'],
  ]);
  assert.equal(view.approvals[0].kind, 'publish-pr');
  assert.equal(view.activity.backend[0].summary, 'Working');
  view.workItems[0].title = 'Mutated view';
  assert.equal(value.workItems[0].title, 'Design', 'The view cannot mutate durable state');
});

test('managed plan store persists atomic revisions and retries concurrent writers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-managed-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ManagedPlanStore(root);
  const created = await store.create(plan(root));
  assert.equal(created.revision, 1);
  await Promise.all(['first', 'second'].map(summary => store.update('managed-demo', current => ({
    ...current,
    blockers: [...current.blockers, {
      id: summary, workItemId: 'api', kind: 'unknown' as const, summary, detail: '', status: 'open' as const, createdAt: Date.now(),
    }],
  }))));
  const snapshot = await store.snapshot('managed-demo');
  assert.equal(snapshot.revision, 3);
  assert.deepEqual(snapshot.blockers.map(blocker => blocker.id).sort(), ['first', 'second']);
});


test('concurrent managed team creation has one winner and one stable already-exists error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-managed-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ManagedPlanStore(root);
  const outcomes = await Promise.allSettled([store.create(plan(root)), store.create(plan(root))]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected');
  assert.match(rejected?.status === 'rejected' ? String(rejected.reason) : '', /already exists/);
});
