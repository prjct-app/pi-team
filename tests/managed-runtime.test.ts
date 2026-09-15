import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createIsolatedResourceLoader, ManagedExecutionRuntime, type PeerSession, type PeerSessionOptions } from '../src/managed-runtime.ts';
import type { ManagedAgentState, ManagedPlan, WorkItem } from '../src/managed-schema.ts';
import type { IntegrationResult, ManagedWorktree } from '../src/worktrees.ts';

function fixture(root: string): { plan: ManagedPlan; agent: ManagedAgentState; item: WorkItem } {
  const now = Date.now();
  const agent: ManagedAgentState = { alias: 'backend', role: 'Backend engineer', status: 'active', worktree: root, branch: 'pi-team/demo/backend', workItemId: 'api', lastSeen: now, restarts: 0, activitySeq: 0 };
  const item: WorkItem = { id: 'api', title: 'Build API', detail: 'Implement the endpoint', kind: 'implementation', status: 'active', dependsOn: [], assignee: 'backend', attempts: 1, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] };
  return {
    agent, item,
    plan: { version: 1, team: 'demo', leadSession: 'lead', goal: { id: 'goal', objective: 'Build a secure API', status: 'active', repoRoot: root, baseBranch: 'develop', baseCommit: 'a'.repeat(40), createdAt: now, updatedAt: now }, workItems: [item], blockers: [], approvals: [], agents: [agent] },
  };
}

class FakeSession implements PeerSession {
  sessionFile = '/sessions/backend.jsonl';
  messages: unknown[] = [];
  prompts: { text: string; options: unknown }[] = [];
  names: string[] = [];
  disposed = false;
  listener?: (event: AgentSessionEvent) => void;

  async prompt(text: string, options: { source: 'extension'; expandPromptTemplates: false }): Promise<void> {
    this.prompts.push({ text, options });
    this.listener?.({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'edit', args: { path: 'src/api.ts' } });
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'not exported' }, { type: 'text', text: `Completed turn ${this.prompts.length}` }] });
  }
  async abort(): Promise<void> {}
  subscribe(listener: (event: AgentSessionEvent) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  setSessionName(name: string): void { this.names.push(name); }
  dispose(): void { this.disposed = true; }
}

function worktrees(root: string) {
  const calls = { integrated: [] as string[], commits: 0 };
  const integration: ManagedWorktree = { alias: 'integration', path: root, branch: 'pi-team/demo/integration', head: 'a'.repeat(40), reused: false };
  return {
    calls,
    value: {
      git: async () => ({ stdout: 'a'.repeat(40), stderr: '' }),
      commit: async () => { calls.commits++; return { head: 'b'.repeat(40), changed: true }; },
      allocate: async () => integration,
      integrate: async (_tree: Pick<ManagedWorktree, 'path'>, commits: string[]): Promise<IntegrationResult> => { calls.integrated.push(...commits); return { ok: true, head: 'c'.repeat(40), applied: commits }; },
    },
  };
}

test('managed runtime reuses persistent peer sessions and emits only structured activity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = fixture(root);
  const session = new FakeSession();
  const created: PeerSessionOptions[] = [];
  const activities: { alias: string; summary: string; workItemId?: string }[] = [];
  const sessions: (string | undefined)[] = [];
  const trees = worktrees(root);
  const runtime = new ManagedExecutionRuntime({
    team: 'demo', worktrees: trees.value,
    createSession: async options => { created.push(options); return session; },
    activity: async (alias, event) => { activities.push({ alias, summary: event.summary, workItemId: event.workItemId }); },
    sessionOpened: async (_alias, file) => { sessions.push(file); },
  });
  const first = await runtime.execute(data.plan, data.item, data.agent);
  const secondItem = { ...data.item, id: 'api-tests', title: 'Test API', attempts: 1 };
  const second = await runtime.execute({ ...data.plan, workItems: [data.item, secondItem] }, secondItem, { ...data.agent, workItemId: secondItem.id });
  assert.equal(created.length, 1, 'The same independent Pi session persists across tasks');
  assert.deepEqual(created[0].tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'team_peer_send']);
  assert.deepEqual(session.prompts.map(prompt => (prompt.options as { source: string }).source), ['extension', 'extension']);
  assert.match(session.prompts[0].text, /dedicated worktree/);
  assert.match(session.prompts[0].text, /Do not push, create or merge a pull request/);
  assert.doesNotMatch(first.summary, /not exported/);
  assert.equal(first.commit, 'b'.repeat(40));
  assert.equal(second.outcome, 'completed');
  assert.deepEqual(activities.filter(event => event.summary === 'Using edit').map(event => event.workItemId), ['api', 'api-tests']);
  assert.deepEqual(sessions, ['/sessions/backend.jsonl']);
  runtime.dispose();
  assert.equal(session.disposed, true);
});

test('integration and verification are local coordinator operations, not peer prompts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-runtime-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { check: 'tsc', test: 'node --test' } }));
  const data = fixture(root);
  data.item.status = 'completed';
  data.item.commit = 'd'.repeat(40);
  const trees = worktrees(root);
  const scripts: string[] = [];
  const runtime = new ManagedExecutionRuntime({
    team: 'demo', worktrees: trees.value,
    createSession: async () => { throw new Error('Local operations must not create a model session'); },
    verify: async (_cwd, script) => { scripts.push(script); },
  });
  const integration: WorkItem = { ...data.item, id: 'integration', title: 'Integrate', kind: 'integration', status: 'active', assignee: undefined, dependsOn: ['api'], commit: undefined };
  const integrated = await runtime.execute({ ...data.plan, workItems: [data.item, integration] }, integration);
  assert.equal(integrated.outcome, 'completed');
  assert.deepEqual(trees.calls.integrated, ['d'.repeat(40)]);
  const verification: WorkItem = { ...integration, id: 'verification', title: 'Verify', kind: 'verification', status: 'verifying', dependsOn: ['integration'] };
  const verified = await runtime.execute({ ...data.plan, workItems: [data.item, { ...integration, status: 'completed', commit: 'c'.repeat(40) }, verification] }, verification);
  assert.deepEqual(scripts, ['check', 'test']);
  assert.deepEqual(verified.tests, ['npm run check', 'npm run test']);
});

test('corrective peers receive completed peer commits without replaying integration commits', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-runtime-corrective-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = fixture(root);
  const session = new FakeSession();
  const trees = worktrees(root);
  const completedApi = { ...data.item, status: 'completed' as const, commit: 'd'.repeat(40) };
  const completedReview: WorkItem = { ...completedApi, id: 'review', title: 'Review', kind: 'review', commit: 'e'.repeat(40) };
  const completedIntegration: WorkItem = { ...completedApi, id: 'integration', title: 'Integrate', kind: 'integration', commit: 'f'.repeat(40) };
  const corrective: WorkItem = { ...data.item, id: 'corrective-1', title: 'Correct tests', kind: 'corrective', dependsOn: ['integration'], status: 'active', attempts: 1 };
  const runtime = new ManagedExecutionRuntime({ team: 'demo', worktrees: trees.value, createSession: async () => session });
  const result = await runtime.execute({ ...data.plan, workItems: [completedApi, completedReview, completedIntegration, corrective] }, corrective, { ...data.agent, workItemId: corrective.id });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(trees.calls.integrated, ['d'.repeat(40), 'e'.repeat(40)]);
  runtime.dispose();
});


test('hung peer turns are aborted and surfaced for scheduler recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-runtime-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = fixture(root);
  const aborted = { value: false };
  const hanging: PeerSession = {
    sessionFile: '/sessions/hanging.jsonl', messages: [], setSessionName() {}, subscribe: () => () => {}, dispose() {},
    prompt: async () => new Promise<void>(() => {}),
    abort: async () => { aborted.value = true; },
  };
  const runtime = new ManagedExecutionRuntime({ team: 'demo', worktrees: worktrees(root).value, createSession: async () => hanging, runTimeoutMs: 10 });
  await assert.rejects(runtime.execute(data.plan, data.item, data.agent), /execution limit/);
  assert.equal(aborted.value, true);
  runtime.dispose();
});

test('managed peer resource loading disables ambient extensions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-runtime-extensions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'repo');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(agentDir, 'extensions', 'recursive.ts'), 'export default () => { throw new Error("ambient extension loaded"); };');
  await writeFile(join(cwd, '.pi', 'extensions', 'project.ts'), 'export default () => { throw new Error("project extension loaded"); };');
  const loader = await createIsolatedResourceLoader(cwd, agentDir);
  assert.deepEqual(loader.getExtensions().extensions, []);
});
