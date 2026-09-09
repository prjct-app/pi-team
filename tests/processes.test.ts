import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { until } from './harness.ts';

async function worker(root: string, alias: string, saved: unknown[] = []) {
  const child = fork(new URL('./worker.ts', import.meta.url), [root, alias, JSON.stringify(saved)], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let seq = 0;
  const requests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let errors = '';
  child.stderr?.on('data', data => { errors += data; });
  child.on('message', (message: any) => {
    if (message.id) {
      const request = requests.get(message.id); requests.delete(message.id);
      if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.value);
    }
  });
  child.on('exit', () => { for (const request of requests.values()) request.reject(new Error(`Worker exited: ${errors}`)); });
  const [ready] = await once(child, 'message');
  assert.equal(ready.ready, true);
  return {
    child,
    call(op: string, value?: unknown): Promise<any> {
      return new Promise((resolve, reject) => { const id = ++seq; requests.set(id, { resolve, reject }); child.send({ id, op, value }); });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      await this.call('stop'); await exited;
    },
  };
}

test('three terminal processes exchange PM → backend → frontend results and recover from a killed backend', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-processes-'));
  const pm = await worker(root, 'pm'); const be = await worker(root, 'backend'); const fe = await worker(root, 'frontend');
  const workers = [pm, be, fe];
  t.after(async () => { for (const w of workers) await w.stop(); await rm(root, { recursive: true, force: true }); });
  await pm.call('command', 'create shop');
  await Promise.all(workers.map((w, i) => w.call('command', `join shop ${['pm', 'backend', 'frontend'][i]}`)));
  // Concurrent writers must not overwrite each other's mailbox records.
  await Promise.all([be, fe].flatMap((w, sender) => Array.from({ length: 10 }, (_, i) =>
    w.call('send', { to: 'pm', kind: 'note', subject: `Update ${sender}-${i}`, body: 'Independent finding' }))));
  await until(async () => (await pm.call('snapshot')).entries.filter((e: any) => e.customType === 'team-event' && e.data?.kind === 'note').length === 20);
  assert.equal((await pm.call('snapshot')).received.length, 0, 'Notes must not start model turns');
  await pm.call('command', 'send backend Implement authentication');
  await until(async () => (await be.call('snapshot')).received.length === 1);
  await be.call('send', { to: 'frontend', kind: 'request', subject: 'Login contract', body: 'Use POST /login' });
  await until(async () => (await fe.call('snapshot')).received.length === 1);
  await fe.call('finish', 'Frontend wired to POST /login');
  // Backend is still busy: frontend's result must remain queued.
  assert.equal((await be.call('snapshot')).received.length, 1);
  await be.call('finish', 'API ready');
  await until(async () => (await pm.call('snapshot')).received.length === 1);
  await until(async () => (await be.call('snapshot')).received.length === 2);
  assert.match((await be.call('snapshot')).received[1].content, /Frontend wired/);
  await be.call('finish', 'Frontend result reviewed');
  await pm.call('finish', 'API result reviewed');
  await pm.call('command', 'send backend A task that will be interrupted');
  await until(async () => (await be.call('snapshot')).received.length === 3);
  const exited = once(be.child, 'exit'); be.child.kill('SIGKILL'); await exited;
  await pm.call('command', 'send backend Work queued while offline');
  const replacement = await worker(root, 'backend-replacement'); workers.push(replacement);
  await replacement.call('command', 'join shop backend');
  await until(async () => (await replacement.call('snapshot')).received.length === 1);
  assert.match((await replacement.call('snapshot')).received[0].content, /Work queued while offline/);
  await until(async () => (await pm.call('snapshot')).received.length === 2);
  assert.match((await pm.call('snapshot')).received[1].content, /not automatically retried/);
});

test('resuming the same session after SIGKILL waits for explicit resume before pending work', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-resume-'));
  const workers: Awaited<ReturnType<typeof worker>>[] = [];
  t.after(async () => { for (const w of workers) await w.stop(); await rm(root, { recursive: true, force: true }); });
  const pm = await worker(root, 'pm'); workers.push(pm);
  const be = await worker(root, 'backend'); workers.push(be);
  await pm.call('command', 'create shop');
  await pm.call('command', 'join shop pm'); await be.call('command', 'join shop backend');
  await pm.call('command', 'send backend Interrupted task');
  await until(async () => (await be.call('snapshot')).received.length === 1);
  await pm.call('command', 'send backend Pending task');
  // Pi owns the session journal: simulate restoring its durable entries, not the mailbox.
  const saved = (await be.call('snapshot')).entries;
  const exited = once(be.child, 'exit'); be.child.kill('SIGKILL'); await exited;
  const resumed = await worker(root, 'backend', saved); workers.push(resumed);
  await until(async () => (await pm.call('snapshot')).received.length === 1);
  assert.match((await pm.call('snapshot')).received[0].content, /not automatically retried/);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await resumed.call('snapshot')).received.length, 0, 'Restored reception must remain paused');
  await resumed.call('command', 'resume');
  await until(async () => (await resumed.call('snapshot')).received.length === 1);
  assert.match((await resumed.call('snapshot')).received[0].content, /Pending task/);
});
