import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { envelope, publish, readRecord, readRecordCached, sha256, writeAtomic } from '../src/store.ts';

const MAX = 1_000_000;

test('publications are atomic, revisioned, and verified by content hash', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  assert.equal(await readRecord(path, envelope, MAX), undefined);
  const first = await publish(path, 0, { count: 1 }, envelope, { maxBytes: MAX });
  assert.equal(first.revision, 1);
  const second = await publish(path, 1, { count: 2 }, envelope, { maxBytes: MAX });
  assert.equal(second.revision, 2);
  const read = await readRecord(path, envelope, MAX);
  assert.equal(read?.revision, 2);
  assert.deepEqual(read?.payload, { count: 2 });
  // Carried, not recomputed: the parser needed it for the content hash anyway.
  assert.equal(read?.payloadJson, JSON.stringify(read?.payload), 'The canonical serialization travels with the record');
  // History revisions share bytes with the record at their publication time.
  assert.deepEqual((await readRecord(join(root, 'revisions', '1.json'), envelope, MAX))?.payload, { count: 1 });
  await assert.rejects(publish(path, 1, { count: 3 }, envelope, { maxBytes: MAX }), /current revision is 2/);
  await assert.rejects(publish(path, 0, { count: 3 }, envelope, { maxBytes: MAX }), /current revision is 2/);
});

test('corrupted records throw and are preserved for manual recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  await publish(path, 0, { count: 1 }, envelope, { maxBytes: MAX });
  const broken = '{"schemaVersion":1,"revision":2,"contentHash":"deadbeef","payload":{"count":9}}';
  await writeFile(path, broken, { mode: 0o600 });
  await assert.rejects(readRecord(path, envelope, MAX), /hash mismatch/);
  assert.equal(await readFile(path, 'utf8'), broken, 'Corrupt records are never deleted');
  await assert.rejects(readRecordCached(path, envelope, MAX), /hash mismatch/);
});

test('the stat-validated cache follows external writes to the same path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  await publish(path, 0, { count: 1 }, envelope, { maxBytes: MAX });
  const a = await readRecordCached(path, envelope, MAX);
  const b = await readRecordCached(path, envelope, MAX);
  assert.equal(a, b, 'Unchanged records are served from cache');
  await publish(path, 1, { count: 2 }, envelope, { maxBytes: MAX });
  assert.equal((await readRecordCached(path, envelope, MAX))?.revision, 2);
  // A writer in another process invalidates the cache via (ino, size, mtime).
  const payload = '{"count":7}';
  await writeAtomic(path, `{"schemaVersion":1,"revision":3,"contentHash":"${sha256(payload)}","payload":${payload}}`, 'light');
  assert.deepEqual((await readRecordCached(path, envelope, MAX))?.payload, { count: 7 });
});

test('a lock abandoned by a crashed writer is broken after going stale', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  await publish(path, 0, { count: 1 }, envelope, { maxBytes: MAX });
  await writeFile(`${path}.lock`, '', { flag: 'wx', mode: 0o600 });
  await assert.rejects(publish(path, 1, { count: 2 }, envelope, { maxBytes: MAX }), /Another writer/);
  const old = new Date(Date.now() - 60_000);
  await utimes(`${path}.lock`, old, old);
  const published = await publish(path, 1, { count: 2 }, envelope, { maxBytes: MAX });
  assert.equal(published.revision, 2);
  assert.equal((await stat(`${path}.lock`).catch(() => undefined)), undefined, 'The lock is released');
});

test('concurrent writers retry through conflicts; exactly one wins each revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.json');
  await publish(path, 0, { log: [] as number[] }, envelope, { maxBytes: MAX });
  const results = await Promise.allSettled(Array.from({ length: 8 }, async (_, i) => {
    for (;;) {
      const current = (await readRecord(path, envelope<{ log: number[] }>, MAX))!;
      try { return await publish(path, current.revision, { log: [...current.payload.log, i] }, envelope, { maxBytes: MAX }); }
      catch (error) {
        if (!['STALE_REVISION', 'RECORD_LOCKED'].includes((error as { code?: string }).code ?? '')) throw error;
      }
    }
  }));
  assert.equal(results.filter(r => r.status === 'rejected').length, 0);
  assert.equal((await readRecord(path, envelope<{ log: number[] }>, MAX))?.payload.log.length, 8);
});

test('a non-durable atomic write still replaces the record whole', async (t) => {
  const { readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-store-none-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'presence', 'pm.json');
  await writeAtomic(path, '{"a":1}', 'none');
  await writeAtomic(path, '{"b":2}', 'none');
  assert.equal(await readFile(path, 'utf8'), '{"b":2}', 'The last write is visible in full');
  const left = (await readdir(join(root, 'presence'))).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(left, [], 'No temporary file survives a successful write');
});

test('a precomputed payload serialization publishes byte-identical records', async (t) => {
  const rootA = await mkdtemp(join(tmpdir(), 'pi-team-json-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'pi-team-json-b-'));
  t.after(() => Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })]));
  const payload = { version: 1, items: [{ id: 'a', body: 'ñ→"\\' }], when: 1.5e3 };
  await publish(join(rootA, 'state.json'), 0, payload, envelope, { maxBytes: MAX });
  await publish(join(rootB, 'state.json'), 0, payload, envelope, { maxBytes: MAX, payloadJson: JSON.stringify(payload) });
  assert.equal(await readFile(join(rootA, 'state.json'), 'utf8'), await readFile(join(rootB, 'state.json'), 'utf8'));
});
