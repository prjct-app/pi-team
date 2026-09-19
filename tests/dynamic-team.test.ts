import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DynamicStore, resolveProject } from '../src/dynamic/store.ts';
import { DynamicTeamService, type ExpertExecution, type ExpertOutcome, type ExpertRunner } from '../src/dynamic/service.ts';
import { LIMITS, assertState, metadata, normalizeTag, type Dispatch } from '../src/dynamic/domain.ts';

class Runner implements ExpertRunner {
  readonly calls: { input: ExpertExecution; signal: AbortSignal; resolve: (result: ExpertOutcome) => void }[] = [];
  run(input: ExpertExecution, signal: AbortSignal): Promise<ExpertOutcome> {
    return new Promise(resolve => this.calls.push({ input, signal, resolve }));
  }
  async close(): Promise<void> {
    for (const call of this.calls) call.resolve({ status: 'cancelled', summary: 'Stopped', stopped: true });
  }
  complete(index: number, summary = 'Verified bounded result'): void {
    assert.ok(this.calls[index]);
    this.calls[index]!.resolve({ status: 'completed', summary, stopped: true });
  }
}
const identity = { processPid: 4242, processGroupId: 4242, processStartToken: 'injected:start' };
const qa: Dispatch = { role: 'QA', capabilities: ['testing'], task: 'Verify the change', instructions: 'Report evidence.', policy: { tools: ['read'] } };
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (const _ of Array.from({ length: 200 })) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for injected execution state');
}
async function fixture(options: { isolatedWriters?: boolean } = {}) {
  const root = await mkdtemp(join(process.cwd(), '.test-dynamic-'));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  await mkdir(join(projectPath, '.git'));
  const project = await resolveProject(projectPath);
  const store = new DynamicStore(join(root, 'state'));
  const runner = new Runner();
  const turns: string[] = [];
  const results: string[] = [];
  const service = new DynamicTeamService(store, project, runner, {
    identity, sessionId: 'session-one', instanceId: 'instance-one', ownerAlive: async () => true,
    now: () => 1_700_000_000_000, onRun: run => { turns.push(run.id); }, onResult: a => { results.push(a.id); },
    ...options,
  });
  const cleanup = async () => { await service.close('test'); await rm(root, { recursive: true, force: true }); };
  return { root, project, store, service, runner, turns, results, cleanup };
}

test('read is inert; explicit objectives lazily persist and queue; tick activates exactly once', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.service.snapshot(), undefined);
    await assert.rejects(lstat(f.store.root), { code: 'ENOENT' });
    const a = await f.service.submit('Ship login validation');
    assert.equal(f.turns.length, 0);
    await f.service.tick();
    await f.service.tick();
    const b = await f.service.submit('Ship password validation');
    await f.service.tick();
    assert.deepEqual(f.turns, [a.id]);
    const state = (await f.service.snapshot())!;
    assert.equal(state.runs.find(r => r.id === b.id)?.status, 'queued');
    assert.equal((await lstat(join(f.store.directory(f.project.teamId), 'state.json'))).mode & 0o777, 0o600);
    await f.service.finish('Login shipped');
    await f.service.tick();
    assert.deepEqual(f.turns, [a.id, b.id]);
  } finally { await f.cleanup(); }
});

test('QA identity, session, instructions and memory persist across Runs with generation fencing', async () => {
  const f = await fixture();
  try {
    await f.service.submit('First'); await f.service.tick();
    const a = await f.service.dispatch(qa);
    assert.equal(a.decision, 'created');
    await until(() => f.runner.calls.length === 1);
    f.runner.complete(0, 'Validated login');
    await until(async () => (await f.service.snapshot())!.assignments[0]!.status === 'completed');
    await f.service.finish('First complete');
    await f.service.submit('Second'); await f.service.tick();
    const b = await f.service.dispatch(qa);
    await until(() => f.runner.calls.length === 2);
    assert.equal(b.decision, 'reused');
    assert.equal(a.expertId, b.expertId);
    assert.equal(a.sessionRef, b.sessionRef);
    assert.equal(f.runner.calls[1]!.input.expert.memory, 'Validated login');
    assert.equal(f.runner.calls[1]!.input.expert.instructions, 'Report evidence.');
    assert.equal(f.runner.calls[1]!.input.expert.generation, 2);
    assert.deepEqual(f.runner.calls[1]!.input.expert.history, [a.assignmentId, b.assignmentId]);
    const rehydrated = await new DynamicStore(f.store.root).read(f.project.teamId);
    assert.equal(rehydrated!.experts.length, 1);
    f.runner.complete(1);
  } finally { await f.cleanup(); }
});

test('one assignment per Expert; different Experts run concurrently within global bound', async () => {
  const f = await fixture();
  try {
    await f.service.submit('Concurrent'); await f.service.tick();
    const first = await f.service.dispatch(qa);
    const second = await f.service.dispatch(qa);
    for (const role of ['developer', 'security', 'writer']) {
      await f.service.dispatch({ ...qa, role, capabilities: [role] });
    }
    await until(() => f.runner.calls.length === LIMITS.concurrent);
    const state = (await f.service.snapshot())!;
    assert.equal(state.experts.length, 4);
    assert.equal(state.assignments.find(a => a.id === second.assignmentId)?.status, 'queued');
    assert.equal(state.assignments.filter(a => a.status === 'running').length, 3);
    assert.equal(first.expertId, second.expertId);
    await assert.rejects(f.service.finish('Too early'), /outstanding/);
    f.runner.complete(0);
    await until(async () => (await f.service.snapshot())!.assignments.find(a => a.id === first.assignmentId)?.status === 'completed');
    await f.service.tick();
    await until(() => f.runner.calls.length === 4);
    assert.equal(f.runner.calls[3]!.input.assignment.id, second.assignmentId);
  } finally { await f.cleanup(); }
});

test('write-capable Experts serialize while read-only Experts may run concurrently', async () => {
  const f = await fixture();
  try {
    await f.service.submit('Change and review'); await f.service.tick();
    const firstWriter = await f.service.dispatch({ ...qa, role: 'builder', capabilities: ['implementation'], policy: { tools: ['write'] } });
    const secondWriter = await f.service.dispatch({ ...qa, role: 'migration', capabilities: ['migration'], policy: { tools: ['bash'] } });
    await f.service.dispatch({ ...qa, role: 'reviewer', capabilities: ['review'] });
    await until(() => f.runner.calls.length === 2);
    const state = (await f.service.snapshot())!;
    assert.equal(state.assignments.find(a => a.id === firstWriter.assignmentId)?.status, 'running');
    assert.equal(state.assignments.find(a => a.id === secondWriter.assignmentId)?.status, 'queued');
    f.runner.complete(0);
    await until(() => f.runner.calls.length === 3);
    assert.equal(f.runner.calls[2]!.input.assignment.id, secondWriter.assignmentId);
  } finally { await f.cleanup(); }
});

test('busy matching role does not create duplicates and implicit capability/policy escalation fails', async () => {
  const f = await fixture();
  try {
    await f.service.submit('Review'); await f.service.tick(); await f.service.dispatch(qa);
    await assert.rejects(f.service.dispatch({ ...qa, capabilities: ['security'] }), /duplicate-role/);
    await assert.rejects(f.service.dispatch({ ...qa, policy: { tools: ['bash'] } }), /policy/);
    assert.equal((await f.service.snapshot())!.experts.length, 1);
  } finally { await f.cleanup(); }
});

test('live foreign owner can receive durable objectives but cannot be taken over', async () => {
  const f = await fixture();
  const runner = new Runner();
  const other = new DynamicTeamService(f.store, f.project, runner, {
    identity, sessionId: 'session-two', instanceId: 'instance-two', ownerAlive: async () => true,
  });
  try {
    await f.service.submit('First'); await f.service.tick();
    const second = await other.submit('Second session objective');
    await other.tick();
    assert.equal(other.isOwner, false);
    assert.equal((await other.snapshot())!.runs.find(r => r.id === second.id)?.status, 'queued');
    await assert.rejects(other.dispatch(qa), /fenced/);
    assert.equal((await other.snapshot())!.owner!.instanceId, 'instance-one');
  } finally { await other.close('test'); await f.cleanup(); }
});

test('cancel after exposure persists cancelled_waiting; late reply never completes it', async () => {
  const f = await fixture();
  try {
    await f.service.submit('Cancel'); await f.service.tick();
    const a = await f.service.dispatch(qa);
    await until(() => f.runner.calls.length === 1);
    await f.service.cancelAssignment(a.assignmentId);
    assert.equal((await f.service.snapshot())!.assignments[0]!.status, 'cancelled_waiting');
    assert.equal(f.runner.calls[0]!.signal.aborted, true);
    f.runner.complete(0, 'LATE SECRET RESULT');
    await until(async () => (await f.service.snapshot())!.assignments[0]!.status === 'cancelled');
    const state = (await f.service.snapshot())!;
    assert.equal(state.assignments[0]!.result, '');
    assert.equal(state.experts[0]!.memory, '');
    assert.deepEqual(f.results, []);
  } finally { await f.cleanup(); }
});

for (const reason of ['reload', 'new', 'fork']) test(`${reason} interrupts active work, retains queue/identity, and never auto-activates`, async () => {
  const f = await fixture();
  try {
    const active = await f.service.submit('Active'); await f.service.tick();
    const dispatch = await f.service.dispatch(qa);
    const queued = await f.service.submit('Queued');
    await f.service.close(reason);
    const state = (await f.service.snapshot())!;
    assert.equal(state.owner, undefined);
    assert.equal(state.runs.find(r => r.id === active.id)?.status, 'cancelled');
    assert.match(state.runs.find(r => r.id === active.id)!.summary, new RegExp(reason));
    assert.equal(state.runs.find(r => r.id === queued.id)?.status, 'queued');
    assert.equal(state.experts[0]!.sessionRef, dispatch.sessionRef);
    assert.deepEqual(f.turns, [active.id]);
    await assert.rejects(f.service.dispatch(qa), /fenced/);
  } finally { await f.cleanup(); }
});

test('dead owner recovery fences old replies without adopting its runtime or retrying exposure', async () => {
  const f = await fixture();
  const runner = new Runner();
  const other = new DynamicTeamService(f.store, f.project, runner, {
    identity: { ...identity, processPid: 4343 }, sessionId: 'session-two', instanceId: 'instance-two', ownerAlive: async () => false,
  });
  try {
    await f.service.submit('Old'); await f.service.tick(); await f.service.dispatch(qa);
    await until(() => f.runner.calls.length === 1);
    await other.submit('New'); await other.tick();
    f.runner.complete(0, 'Old owner late result');
    await new Promise(resolve => setTimeout(resolve, 30));
    const state = (await other.snapshot())!;
    assert.equal(state.runs[0]!.status, 'interrupted');
    assert.equal(state.assignments[0]!.status, 'cancelled_waiting');
    assert.equal(state.experts[0]!.status, 'blocked');
    assert.equal(state.experts[0]!.memory, '');
    assert.equal(runner.calls.length, 0);
    await assert.rejects(other.dispatch(qa), /unresolved/);
  } finally { await other.close('test'); await f.cleanup(); }
});

test('deterministic canonical project binding shares subdirectories but deliberately changes on move', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.project.path, 'sub'));
    const a = await resolveProject(f.project.path);
    assert.deepEqual(await resolveProject(join(f.project.path, 'sub')), a);
    const alias = join(f.root, 'alias'); await symlink(f.project.path, alias);
    assert.deepEqual(await resolveProject(alias), a);
    const moved = join(f.root, 'moved'); await rename(f.project.path, moved);
    assert.notEqual((await resolveProject(moved)).teamId, a.teamId);
  } finally { await f.cleanup(); }
});

test('schemas, UTF-8 bounds, redaction and symlink-safe reads reject unsafe records', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.submit('😀'.repeat(3000)), /UTF-8/);
    await f.service.submit('Valid'); await f.service.tick();
    await assert.rejects(f.service.dispatch({ ...qa, task: '😀'.repeat(3000) }), /UTF-8/);
    const state = (await f.service.snapshot())!;
    assert.throws(() => assertState({ ...state, extra: true }), /Invalid/);
    assert.equal(normalizeTag('Quality_Assurance'), 'quality-assurance');
    const redacted = metadata('token=abc password=xyz Bearer abcdefghijk sk-123456789secret ' + 'a'.repeat(64));
    assert.ok(!redacted.includes('abcdefghijk'));
    assert.ok(!redacted.includes('123456789secret'));
    const alias = join(f.root, 'unsafe'); await symlink(f.store.root, alias);
    await assert.rejects(new DynamicStore(alias).read(f.project.teamId), /Unsafe/);
  } finally { await f.cleanup(); }
});

test('different roles with the same capabilities are different Experts and, isolated, write in parallel', async () => {
  const f = await fixture({ isolatedWriters: true });
  try {
    await f.service.submit('Ship three tickets'); await f.service.tick();
    const work = { capabilities: ['implement', 'test', 'pr'], instructions: 'One ticket.', policy: { tools: ['read', 'edit'] } };
    const a = await f.service.dispatch({ ...work, role: 'fty-4', task: 'FTY-4' });
    const b = await f.service.dispatch({ ...work, role: 'fty-74', task: 'FTY-74' });
    const c = await f.service.dispatch({ ...work, role: 'fty-26', task: 'FTY-26' });
    assert.deepEqual([a.decision, b.decision, c.decision], ['created', 'created', 'created']);
    assert.equal(new Set([a.expertId, b.expertId, c.expertId]).size, 3);
    await until(() => f.runner.calls.length === 3);
    assert.equal(f.runner.calls.length, 3, 'all three start at once, up to the parallel limit');
    for (const index of [0, 1, 2]) f.runner.complete(index);
  } finally { await f.cleanup(); }
});
