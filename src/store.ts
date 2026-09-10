import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Single-record file storage with optimistic concurrency.
 *
 * Readers never take a lock: every publication renames a new inode into place,
 * so a concurrent read either sees the whole previous record or the whole next
 * one. Writers compare-and-swap on a monotonically increasing revision guarded
 * by a short-lived sibling lock file; conflicts fail fast with STALE_REVISION
 * or RECORD_LOCKED and callers retry against a fresh read. Each publication
 * hard-links its envelope into a bounded revisions/ history, which doubles as
 * recovery evidence for interrupted writes.
 */
export type Record<T> = { revision: number; payload: T };
/** Parse raw file bytes into a record, throwing on corruption. Never deletes. */
export type Normalize<T> = (raw: string) => Record<T>;
/** 'full' fsyncs file and directory; 'light' fsyncs the file only (presence). */
export type Durability = 'full' | 'light';

const STALE_LOCK_MS = 10_000;
const KEEP_REVISIONS = 32;

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Diagnostics for the polling loop. `reads` counts full record parses, which
 * happen once per attempted mutation and on a cache miss, never on a cache hit.
 * A joined but idle session should leave both of these flat.
 */
export const counters = { reads: 0, publishes: 0 };

/** Standard envelope parser: schema marker, revision, and content hash. */
export function envelope<T>(raw: string): Record<T> {
  const parsed = JSON.parse(raw) as { schemaVersion?: unknown; revision?: unknown; contentHash?: unknown; payload?: unknown };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1) {
    throw Object.assign(new Error('Unsupported record envelope.'), { code: 'UNSUPPORTED_SCHEMA' });
  }
  if (typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1) {
    throw Object.assign(new Error('Invalid record revision.'), { code: 'CORRUPT_RECORD' });
  }
  if (parsed.contentHash !== sha256(JSON.stringify(parsed.payload))) {
    throw Object.assign(new Error('Record hash mismatch; preserved for manual recovery.'), { code: 'CORRUPT_RECORD' });
  }
  return { revision: parsed.revision, payload: parsed.payload as T };
}

function assertSafeFile(path: string, info: { isFile(): boolean; size: number; mode: number; uid: number }, maxBytes: number): void {
  if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe record file: ${path}. Expected a private file owned by this user.`);
  }
}

/** Resolve to `undefined` when the target is absent; other errors propagate. */
async function absentAsUndefined<T>(work: Promise<T>): Promise<T | undefined> {
  try { return await work; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Lock-free read. Missing records stay missing; corrupt records throw. */
export async function readRecord<T>(path: string, normalize: Normalize<T>, maxBytes: number): Promise<Record<T> | undefined> {
  const handle = await absentAsUndefined(open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  if (!handle) return undefined;
  try {
    assertSafeFile(path, await handle.stat(), maxBytes);
    counters.reads++;
    return normalize(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

// Stat-validated read cache for hot polling. Every publication renames a new
// inode into place, so (ino, size, mtime) changes on each write, including
// writes by other processes sharing the store.
const cache = new Map<string, { ino: number; size: number; mtimeMs: number; record: Record<unknown> | undefined }>();

export async function readRecordCached<T>(path: string, normalize: Normalize<T>, maxBytes: number): Promise<Record<T> | undefined> {
  const info = await absentAsUndefined(stat(path));
  if (!info) { cache.delete(path); return undefined; }
  const hit = cache.get(path);
  if (hit && hit.ino === info.ino && hit.size === info.size && hit.mtimeMs === info.mtimeMs) {
    return hit.record as Record<T> | undefined;
  }
  const record = await readRecord(path, normalize, maxBytes);
  cache.set(path, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, record: record as Record<unknown> | undefined });
  return record;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Atomic last-writer-wins write for records without revision history (presence). */
export async function writeAtomic(path: string, text: string, durability: Durability = 'full'): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await rename(tmp, path);
    if (durability === 'full') await syncDirectory(path);
  } finally { await unlink(tmp).catch(() => {}); }
}

const locked = () => Object.assign(new Error('Another writer holds this record.'), { code: 'RECORD_LOCKED' });

/** Resolve to `undefined` when the lock is already held; other errors propagate. */
async function tryLock(lockPath: string) {
  try { return await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
}

async function acquireLock(lockPath: string) {
  const held = await tryLock(lockPath);
  if (held) return held;
  // A crashed writer can leave its lock behind; publication takes
  // microseconds, so a lock older than STALE_LOCK_MS is safe to break.
  const info = await stat(lockPath).catch(() => undefined);
  if (!info || Date.now() - info.mtimeMs <= STALE_LOCK_MS) throw locked();
  await unlink(lockPath).catch(() => {});
  return await tryLock(lockPath) ?? (() => { throw locked(); })();
}

async function pruneRevisions(dir: string, latest: number): Promise<void> {
  const revisionsDir = join(dir, 'revisions');
  const names = await readdir(revisionsDir).catch(() => [] as string[]);
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match && Number(match[1]) <= latest - KEEP_REVISIONS) {
      await unlink(join(revisionsDir, name)).catch(() => {});
    }
  }
}

/**
 * Compare-and-swap publication. Fails fast with STALE_REVISION when the record
 * moved since the caller's read, or RECORD_LOCKED while another writer holds
 * the lock; callers retry against a fresh read.
 */
export async function publish<T>(
  path: string, expectedRevision: number, payload: T, normalize: Normalize<T>,
  options: { maxBytes: number; durability?: Durability },
): Promise<Record<T>> {
  const durability = options.durability ?? 'full';
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lock = await acquireLock(lockPath);
  try {
    const current = await readRecord(path, normalize, options.maxBytes);
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision) {
      throw Object.assign(new Error(`Record changed before the write; current revision is ${revision}.`), { code: 'STALE_REVISION' });
    }
    const next = revision + 1;
    const payloadJson = JSON.stringify(payload);
    const text = `{"schemaVersion":1,"revision":${next},"contentHash":"${sha256(payloadJson)}","payload":${payloadJson}}`;
    if (Buffer.byteLength(text) > options.maxBytes) throw new Error('Record size limit exceeded.');
    const historyPath = join(dirname(path), 'revisions', `${next}.json`);
    const previous = await readRecord(historyPath, (raw: string) => envelope<T>(raw), options.maxBytes);
    if (previous && (previous.revision !== next || sha256(JSON.stringify(previous.payload)) !== sha256(payloadJson))) {
      throw new Error('An interrupted publication owns this revision; explicit recovery is required.');
    }
    if (!previous) await writeAtomic(historyPath, text, durability);
    // Point `path` at the inode already holding the history copy: one write
    // per publication, and the current record shares bytes with its revision.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await link(historyPath, tmp);
    try {
      await rename(tmp, path);
      if (durability === 'full') await syncDirectory(path);
    } finally { await unlink(tmp).catch(() => {}); }
    cache.delete(path);
    counters.publishes++;
    await pruneRevisions(dirname(path), next).catch(() => {});
    return { revision: next, payload };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
