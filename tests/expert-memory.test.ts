import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamicStore, resolveProject } from '../src/dynamic/store.ts';
import { DynamicTeamService } from '../src/dynamic/service.ts';
import { ProductionExpertRunner } from '../src/dynamic/runner.ts';
import { expertMemory, expertStance } from '../src/dynamic/memory.ts';
import { parseWorkerRequest } from '../src/dynamic/worker.ts';
import { TeamRuntime } from '../src/runtime/team-runtime.ts';
import { TeamPaths } from '../src/storage/paths.ts';
import type { OwnedRuntime } from '../src/supervisor/runtime-store.ts';

test('an Expert\'s stance comes from what it may do, and unsure is a reader', () => {
  assert.equal(expertStance('backend', ['read', 'edit']), 'worker');
  assert.equal(expertStance('qa', ['read', 'bash']), 'worker', 'bash can change the tree');
  assert.equal(expertStance('security-review', ['read', 'grep']), 'reviewer');
  assert.equal(expertStance('qa', ['read']), 'reviewer');
  assert.equal(expertStance('mapper', ['read', 'find']), 'explorer');
});

test('memory comes from the view pi-memory publishes, and is empty when absent, failing, or oversized', async () => {
  const key = Symbol.for('prjct.memory');
  const space = globalThis as unknown as Record<symbol, unknown>;
  const previous = space[key];
  try {
    delete space[key];
    assert.equal(await expertMemory('explorer', 'map it'), '');
    const seen: unknown[] = [];
    space[key] = { childView: async (request: unknown) => { seen.push(request); return { text: 'remembered' }; } };
    assert.equal(await expertMemory('reviewer', 'check login'), 'remembered');
    assert.deepEqual(seen, [{ role: 'reviewer', query: 'check login' }]);
    space[key] = { childView: async () => { throw new Error('locked'); } };
    assert.equal(await expertMemory('worker', 'x'), '');
    space[key] = { childView: async () => ({ text: 'x'.repeat(5000) }) };
    assert.equal(await expertMemory('worker', 'x'), '', 'never more than the request can carry');
  } finally {
    space[key] = previous;
  }
});

test('the worker request carries memory only within its bound', () => {
  const valid = { assignmentId: randomUUID(), generation: 1, ownerEpoch: 1, task: 'Do it' };
  assert.deepEqual(parseWorkerRequest(JSON.stringify({ ...valid, memory: '<project_memory for="worker">\n</project_memory>' })).memory,
    '<project_memory for="worker">\n</project_memory>');
  assert.equal(parseWorkerRequest(JSON.stringify(valid)).memory, undefined);
  assert.throws(() => parseWorkerRequest(JSON.stringify({ ...valid, memory: 'x'.repeat(4097) })), /Invalid Expert request body|exceeds/);
});

test('the orchestrator sends each Expert the memory for its stance and task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-memory-'));
  const store = new DynamicStore(join(root, 'state')); const project = await resolveProject(root);
  const bodies: string[] = []; const asked: { stance: string; query: string }[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const runtime = new TeamRuntime(new TeamPaths(join(store.root, 'transport')));
  const runner = new ProductionExpertRunner(store, { runtime, pollMs: 10, timeoutMs: 5000,
    memory: async (stance, query) => { asked.push({ stance, query }); return `<project_memory for="${stance}">\n</project_memory>`; },
    supervisor: options => {
      const owner = { ownerSessionId: options.ownerSessionId, ownerInstanceId: options.ownerInstanceId!,
        ownerEpoch: options.ownerEpoch!, ownerProcessNonce: 'a'.repeat(64) };
      return { owner,
        async launch(input) {
          const at = new Date().toISOString();
          const record: OwnedRuntime = { schemaVersion: 2, runtimeId: randomUUID(), teamId: options.teamId, memberId: input.memberId,
            owner, processPid: 4242, processStartToken: 'fake', cwd: root, state: 'ready', createdAt: at, updatedAt: at };
          await runner.runtime.runtimes.create(record);
          const busy = { value: false };
          const timer = setInterval(() => {
            if (busy.value) return; busy.value = true;
            void runner.runtime.delivery.deliverNextRequest(input.workerMembership, true, async message => {
              bodies.push(message.body);
              await runner.runtime.requests.reply(input.workerMembership, message.messageId, 'Done');
              clearInterval(timer);
            }).finally(() => { busy.value = false; });
          }, 10); timers.push(timer);
          return record;
        },
        async stop(runtimeId) {
          await runner.runtime.runtimes.update(options.teamId, runtimeId, owner, current => ({ ...current, state: 'stopping' }));
          await runner.runtime.runtimes.update(options.teamId, runtimeId, owner, current => ({ ...current, state: 'terminated' }));
          return { runtimeId, status: 'terminated', phase: 'terminated' };
        },
        async close() {},
      }; } });
  const service = new DynamicTeamService(store, project, runner, { sessionId: 'owner', identity: { processPid: 4242, processGroupId: 4242, processStartToken: 'fake' } });
  try {
    await service.submit('Verify login'); await service.tick();
    await service.dispatch({ role: 'qa', capabilities: ['testing'], task: 'Test the login flow', instructions: 'Evidence only', policy: { tools: ['read'] } });
    for (const _ of Array.from({ length: 300 })) {
      if ((await service.snapshot())?.assignments[0]?.endedAt) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(asked, [{ stance: 'reviewer', query: 'Test the login flow' }]);
    const body = parseWorkerRequest(bodies[0]!);
    assert.equal(body.task, 'Test the login flow', 'the task itself is untouched: the worker fences on it');
    assert.equal(body.memory, '<project_memory for="reviewer">\n</project_memory>');
  } finally { timers.forEach(clearInterval); await service.close('test'); await rm(root, { recursive: true, force: true }); }
});
