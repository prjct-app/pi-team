import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBlueprint, applyWorkBatch, assertBlueprint, assertWorkBatch, createPlanningPlan, managedTeamName, type TeamBlueprint } from '../src/blueprint.ts';
import { assertManagedPlan } from '../src/managed-plan.ts';
import type { ManagedWorktree, RepositoryState } from '../src/worktrees.ts';

const repository: RepositoryState = { root: '/repo', branch: 'develop', head: 'a'.repeat(40), clean: true };
const blueprint: TeamBlueprint = {
  agents: [{ alias: 'backend', role: 'Backend engineer' }, { alias: 'reviewer', role: 'Reviewer' }],
  workItems: [
    { id: 'api', title: 'Build API', detail: 'Implement endpoint', kind: 'implementation', dependsOn: [], assignee: 'backend' },
    { id: 'review', title: 'Review API', detail: 'Review the commit', kind: 'review', dependsOn: ['api'], assignee: 'reviewer', maxAttempts: 3 },
  ],
};
const worktrees: ManagedWorktree[] = [
  { alias: 'backend', path: '/managed/backend', branch: 'pi-team/demo/backend', head: repository.head, reused: false },
  { alias: 'reviewer', path: '/managed/reviewer', branch: 'pi-team/demo/reviewer', head: repository.head, reused: false },
];

test('a normal objective becomes a deterministic durable planning goal', () => {
  assert.match(managedTeamName('session-123', 'Fix production login bug'), /^team-fix-production-login-bug-[a-f0-9]{6}$/);
  assert.equal(managedTeamName('session-123'), managedTeamName('session-123'));
  const plan = createPlanningPlan('team-demo', 'session-123', 'Implement the feature', repository, 10);
  assert.equal(plan.goal.status, 'planning');
  assert.equal(plan.goal.baseBranch, 'develop');
  assert.equal(plan.goal.baseCommit, repository.head);
  assert.equal(plan.workItems.length, 0);
  assert.doesNotThrow(() => assertManagedPlan(plan));
});

test('blueprint validation enforces bounded peers, assignments, references, and a DAG', () => {
  assert.doesNotThrow(() => assertBlueprint(blueprint));
  assert.throws(() => assertBlueprint({ ...blueprint, agents: [blueprint.agents[0], blueprint.agents[0]] }), /aliases must be unique/);
  assert.throws(() => assertBlueprint({ ...blueprint, workItems: [{ ...blueprint.workItems[0], assignee: 'missing' }] }), /declared assignee/);
  assert.throws(() => assertBlueprint({ ...blueprint, workItems: [{ ...blueprint.workItems[0], dependsOn: ['missing'] }] }), /dependencies/);
  assert.throws(() => assertBlueprint({ ...blueprint, workItems: [
    { ...blueprint.workItems[0], dependsOn: ['review'] }, { ...blueprint.workItems[1], dependsOn: ['api'] },
  ] }), /acyclic/);
  assert.throws(() => assertBlueprint({ ...blueprint, workItems: [{ ...blueprint.workItems[0], id: 'integration' }] }), /reserved/);
});

test('an adopted blueprint binds every peer to a worktree and appends integration and verification', () => {
  const planning = createPlanningPlan('team-demo', 'session-123', 'Implement the feature', repository, 10);
  const result = applyBlueprint(planning, blueprint, worktrees, 20);
  assert.equal(result.goal.status, 'active');
  assert.deepEqual(result.agents.map(agent => [agent.alias, agent.worktree]), [['backend', '/managed/backend'], ['reviewer', '/managed/reviewer']]);
  assert.deepEqual(result.workItems.map(item => item.id), ['api', 'review', 'integration', 'verification']);
  assert.deepEqual(result.workItems.find(item => item.id === 'integration')?.dependsOn, ['api', 'review']);
  assert.deepEqual(result.workItems.find(item => item.id === 'verification')?.dependsOn, ['integration']);
  assert.equal(result.workItems.find(item => item.id === 'review')?.maxAttempts, 3);
  assert.doesNotThrow(() => assertManagedPlan(result));
  assert.throws(() => applyBlueprint(planning, blueprint, worktrees.slice(0, 1), 20), /allocated worktree/);
});


test('additional work batches reuse persistent peers and extend the existing DAG', () => {
  const initial = applyBlueprint(createPlanningPlan('team-demo', 'lead', 'Build it', repository, 1), blueprint, worktrees, 2);
  const batch = { workItems: [{ id: 'security', title: 'Audit security', detail: '', kind: 'review' as const, dependsOn: ['verification'], assignee: 'backend' }] };
  assert.doesNotThrow(() => assertWorkBatch(initial, batch));
  const extended = applyWorkBatch({ ...initial, approvals: [{ id: 'publish', kind: 'publish-pr', status: 'required', summary: 'Publish', requestedAt: 3 }] }, batch, 'batch1', 4);
  assert.deepEqual(extended.workItems.slice(-3).map(item => item.id), ['security', 'integration-batch1', 'verification-batch1']);
  assert.equal(extended.agents.length, initial.agents.length);
  assert.deepEqual(extended.approvals, []);
  assert.throws(() => assertWorkBatch(initial, { workItems: [{ ...batch.workItems[0], id: 'api' }] }), /unique across/);
  assert.throws(() => assertWorkBatch(initial, { workItems: [{ ...batch.workItems[0], assignee: 'new-agent' }] }), /existing persistent peer/);
});
