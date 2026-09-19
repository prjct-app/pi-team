import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamicStore, resolveProject } from '../src/dynamic/store.ts';
import { DynamicTeamService } from '../src/dynamic/service.ts';
import { ProductionExpertRunner, safeReason } from '../src/dynamic/runner.ts';
import { socketName, shortSocketRoot, SOCKET_PATH_MAX } from '../src/supervisor/supervisor.ts';
import { parseWorkerRequest } from '../src/dynamic/worker.ts';
import { TeamRuntime } from '../src/runtime/team-runtime.ts';
import { TeamPaths } from '../src/storage/paths.ts';
import type { SupervisorLaunch } from '../src/supervisor/supervisor.ts';
import type { OwnedRuntime } from '../src/supervisor/runtime-store.ts';

for (const blocked of [false, true]) test(`production adapter correlates durable reply and requires proven stop (blocked=${blocked})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-runner-'));
  const store = new DynamicStore(join(root, 'state')); const project = await resolveProject(root);
  const launches: SupervisorLaunch[] = []; const timers: ReturnType<typeof setInterval>[] = [];
  const clock = { value: Date.now() };
  const runtime = new TeamRuntime(new TeamPaths(join(store.root, 'transport')), () => clock.value);
  const runner = new ProductionExpertRunner(store, { runtime, pollMs: 10, timeoutMs: 5000,
    environment: { OPENAI_API_KEY: 'caller-key' }, supervisor: options => {
    const owner = { ownerSessionId: options.ownerSessionId, ownerInstanceId: options.ownerInstanceId!,
      ownerEpoch: options.ownerEpoch!, ownerProcessNonce: 'a'.repeat(64) };
    return { owner,
    async launch(input) {
      launches.push(input);
      const at = new Date().toISOString();
      const record: OwnedRuntime = { schemaVersion: 2, runtimeId: randomUUID(), teamId: options.teamId, memberId: input.memberId,
        owner,
        processPid: 4242, processStartToken: 'fake', cwd: root, state: 'ready', createdAt: at, updatedAt: at };
      await runner.runtime.runtimes.create(record);
      const busy = { value: false };
      const timer = setInterval(() => {
        if (busy.value) return; busy.value = true;
        void runner.runtime.delivery.deliverNextRequest(input.workerMembership, true, async message => {
          await runner.runtime.requests.reply(input.workerMembership, message.messageId, 'Verified token=private-value');
          clearInterval(timer);
        }).finally(() => { busy.value = false; });
      }, 10); timers.push(timer);
      return record;
    },
    async stop(runtimeId) {
      if (!blocked) {
        await runner.runtime.runtimes.update(options.teamId, runtimeId, owner, current => ({ ...current, state: 'stopping' }));
        await runner.runtime.runtimes.update(options.teamId, runtimeId, owner, current => ({ ...current, state: 'terminated' }));
      }
      return { runtimeId, status: blocked ? 'blocked' : 'terminated', phase: blocked ? 'blocked' : 'terminated' };
    },
    async close() {},
  }; } });
  const service = new DynamicTeamService(store, project, runner, { sessionId: 'owner', identity: { processPid: 4242, processGroupId: 4242, processStartToken: 'fake' } });
  try {
    await service.submit('Verify login'); await service.tick();
    await service.dispatch({ role: 'qa', capabilities: ['testing'], task: 'Test it', instructions: 'Evidence only', policy: { tools: ['read'] } });
    for (const _ of Array.from({ length: 300 })) {
      if ((await service.snapshot())?.assignments[0]?.endedAt) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const state = (await service.snapshot())!;
    assert.equal(state.assignments[0]?.status, blocked ? 'failed' : 'completed');
    assert.equal(state.experts[0]?.status, blocked ? 'blocked' : 'idle');
    assert.ok(!JSON.stringify(state).includes('private-value'));
    assert.ok(launches[0]?.command.includes(store.sessionPath(project.teamId, state.experts[0]!.sessionRef)));
    assert.ok(launches[0]?.command.includes('read,team_reply'));
    assert.ok(launches[0]?.command.includes('--no-context-files'));
    assert.equal(launches[0]?.environment?.OPENAI_API_KEY, 'caller-key');
    assert.equal((await runner.runtime.runtimes.list(project.teamId)).length, blocked ? 1 : 0);
    if (!blocked) {
      const firstExpert = state.experts[0]!;
      await service.finish('First run complete.');
      clock.value += 31_000;
      await service.submit('Verify login again'); await service.tick();
      const reused = await service.dispatch({ role: 'qa', capabilities: ['testing'], task: 'Retest it',
        instructions: 'Evidence only', policy: { tools: ['read'] } });
      assert.equal(reused.expertId, firstExpert.id);
      for (const _ of Array.from({ length: 300 })) {
        if ((await service.snapshot())?.assignments.find(item => item.id === reused.assignmentId)?.endedAt) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal((await service.snapshot())!.assignments.find(item => item.id === reused.assignmentId)?.status, 'completed');
    }
  } finally { timers.forEach(clearInterval); await service.close('test'); await rm(root, { recursive: true, force: true }); }
});

test('worker request parser rejects malformed, oversized, and extra input', () => {
  const valid = { assignmentId: randomUUID(), generation: 1, ownerEpoch: 1, task: 'Inspect the result.' };
  assert.deepEqual(parseWorkerRequest(JSON.stringify(valid)), valid);
  assert.throws(() => parseWorkerRequest('{'), /JSON/);
  assert.throws(() => parseWorkerRequest(JSON.stringify({ ...valid, extra: true })), /Invalid Expert request body/);
  assert.throws(() => parseWorkerRequest(JSON.stringify({ ...valid, task: 'x'.repeat(8193) })), /Invalid Expert request body|byte limit/);
});

test('a deep store keeps the control socket under the Unix path limit', () => {
  const deep = new TeamPaths('/Users/someone-with-a-long-name/.prjct/pi-team/orchestration-v2/transport');
  const path = socketName(deep, `p-${'a'.repeat(40)}`, 'session', 'b'.repeat(64));
  assert.ok(Buffer.byteLength(path) <= SOCKET_PATH_MAX, path);
  assert.ok(path.startsWith(shortSocketRoot()), 'falls back to the short private directory');
  const shallow = new TeamPaths('/s');
  assert.match(socketName(shallow, `p-${'a'.repeat(40)}`, 'session', 'b'.repeat(64)), /^\/s\/control\/supervisor-/);
});

test('why an Expert failed is shown without command arguments or tokens', () => {
  assert.equal(safeReason(new Error('Supervisor Unix socket path is too long.')), 'Supervisor Unix socket path is too long.');
  assert.equal(safeReason(Object.assign(new Error('Command failed: tmux new-session -e TOKEN=abc'), { code: 'ENOENT' })), 'tmux could not start the Expert session (ENOENT)');
  assert.doesNotMatch(safeReason(new Error(`lease ${'f'.repeat(64)} expired`)), /f{32}/);
});
