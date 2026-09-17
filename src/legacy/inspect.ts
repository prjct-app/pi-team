import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TEAM_ID_PATTERN } from '../domain/team.ts';
import { summarizeMailbox, type LegacyMailboxSummary } from './mailbox.ts';

export const LEGACY_LIMITS = {
  maxTeams: 100,
  maxEntries: 2000,
  maxFiles: 1000,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
} as const;

export type LegacyLimits = { readonly [K in keyof typeof LEGACY_LIMITS]: number };
export type LegacyInspectionOptions = {
  /** Overrides only the teams directory; no other legacy roots are discovered. */
  readonly root?: string;
  readonly limits?: Partial<LegacyLimits>;
};
export type LegacyEntry = {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'rejected';
  readonly bytes?: number;
  readonly reason?: string;
};
export type LegacyTeamInspection = {
  readonly name: string;
  readonly status: 'inspected' | 'rejected' | 'limited';
  /** Direct regular files only. Nested trees are deliberately not traversed. */
  readonly bytes: number;
  readonly entries: readonly LegacyEntry[];
  readonly possibleRuntimeMetadata: boolean;
  readonly mailbox?: LegacyMailboxSummary & { readonly sha256: string };
  readonly issues: readonly string[];
};
export type LegacyInspection = {
  readonly root: string;
  readonly present: boolean;
  readonly complete: boolean;
  readonly sizeScope: 'direct-files-only';
  readonly bytes: number;
  readonly teams: readonly LegacyTeamInspection[];
  readonly issues: readonly string[];
};

export function legacyError(message: string, code = 'UNSAFE_LEGACY'): Error {
  return Object.assign(new Error(message), { code });
}

function privateOwner(info: Stats): boolean {
  return (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid());
}

/** Check each existing component without resolving symlinks, including ancestors. */
export async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) await assertNoSymlinkAncestors(parent);
  const info = await lstat(absolute).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw legacyError('Unsafe directory component.');
}

async function privateDirectory(path: string): Promise<Stats> {
  const info = await lstat(path);
  const canonical = await realpath(path);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(path) || !privateOwner(info)) {
    throw legacyError('Expected a private, owned legacy directory.');
  }
  return info;
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** Fixed-size reads also bound files that grow after stat; never readFile(). */
async function readMailbox(path: string, before: Stats, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !privateOwner(info) || !unchanged(before, info)) throw legacyError('Legacy file changed during inspection.');
    if (info.size > maxBytes) throw legacyError('Legacy file exceeds byte limit.', 'LEGACY_LIMIT');
    const buffer = Buffer.alloc(info.size);
    const progress = { offset: 0 };
    while (progress.offset < buffer.length) {
      const read = await handle.read(buffer, progress.offset, buffer.length - progress.offset, progress.offset);
      if (read.bytesRead === 0) throw legacyError('Legacy file changed during inspection.');
      progress.offset += read.bytesRead;
    }
    if (!unchanged(info, await handle.stat())) throw legacyError('Legacy file changed during inspection.');
    return buffer;
  } finally { await handle.close(); }
}

function limitsFor(options: LegacyInspectionOptions): LegacyLimits {
  const limits = { ...LEGACY_LIMITS, ...options.limits };
  for (const key of Object.keys(LEGACY_LIMITS) as (keyof LegacyLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > LEGACY_LIMITS[key]) {
      throw legacyError(`Invalid legacy inspection limit: ${key}.`, 'LEGACY_LIMIT');
    }
  }
  return limits;
}

type Budget = { entries: number; files: number; bytes: number; limited: boolean };
const runtimeName = /(?:pid|runtime|presence|process|session|managed)/i;

async function inspectTeam(root: string, name: string, limits: LegacyLimits, budget: Budget): Promise<LegacyTeamInspection> {
  const path = join(root, name);
  const entries: LegacyEntry[] = [];
  const issues: string[] = [];
  const result: { bytes: number; runtime: boolean; mailbox?: LegacyTeamInspection['mailbox'] } = { bytes: 0, runtime: false };
  try {
    const before = await privateDirectory(path);
    const directory = await opendir(path, { bufferSize: 1 });
    if (!unchanged(before, await privateDirectory(path))) {
      await directory.close();
      throw legacyError('Legacy directory changed before traversal.');
    }
    for await (const entry of directory) {
      budget.entries++;
      if (budget.entries > limits.maxEntries) { budget.limited = true; break; }
      const file = join(path, entry.name);
      const info = await lstat(file);
      result.runtime ||= runtimeName.test(entry.name);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || !privateOwner(info)) {
        entries.push({ name: entry.name, kind: 'rejected', reason: 'Unsafe type, owner, or permissions.' });
        issues.push('Unsafe entry; no contents read.');
        continue;
      }
      if (info.isDirectory()) {
        entries.push({ name: entry.name, kind: 'directory', reason: 'Nested data is not traversed or migrated.' });
        continue;
      }
      budget.files++;
      if (budget.files > limits.maxFiles || info.size > limits.maxFileBytes || info.size > limits.maxBytes - budget.bytes) {
        budget.limited = true;
        break;
      }
      budget.bytes += info.size;
      result.bytes += info.size;
      entries.push({ name: entry.name, kind: 'file', bytes: info.size });
      // Only the mailbox is decoded. Journals, snapshots, runtimes and arbitrary files remain opaque.
      if (entry.name === 'state.json') {
        try {
          const bytes = await readMailbox(file, info, limits.maxFileBytes);
          const summary = summarizeMailbox(bytes, name);
          result.mailbox = { ...summary, sha256: createHash('sha256').update(bytes).digest('hex') };
          result.runtime ||= summary.possibleRuntimeMetadata;
        } catch {
          issues.push('Mailbox is unsafe, changed, corrupt, or unsupported; preserved for manual recovery.');
        }
      }
    }
    if (!unchanged(before, await privateDirectory(path))) throw legacyError('Legacy directory changed during inspection.');
  } catch {
    budget.bytes -= result.bytes;
    entries.splice(0);
    result.bytes = 0;
    result.runtime = false;
    result.mailbox = undefined;
    issues.push('Unsafe, unreadable, or changed team directory; no observations retained.');
  }
  if (budget.limited) issues.push('Inspection limit reached.');
  return {
    name, status: budget.limited ? 'limited' : issues.length ? 'rejected' : 'inspected',
    bytes: result.bytes, entries, possibleRuntimeMetadata: result.runtime,
    ...(result.mailbox ? { mailbox: result.mailbox } : {}), issues,
  };
}

/** Explicit, read-only, shallow inventory. Importing this module does no I/O. */
export async function inspectLegacy(options: LegacyInspectionOptions = {}): Promise<LegacyInspection> {
  const root = resolve(options.root ?? join(homedir(), '.pi', 'agent', 'teams'));
  const limits = limitsFor(options);
  await assertNoSymlinkAncestors(root);
  const info = await lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  const teams: LegacyTeamInspection[] = [];
  const issues: string[] = [];
  const budget: Budget = { entries: 0, files: 0, bytes: 0, limited: false };
  if (info) {
    const before = await privateDirectory(root);
    const directory = await opendir(root, { bufferSize: 1 });
    if (!unchanged(before, await privateDirectory(root))) {
      await directory.close();
      throw legacyError('Legacy root changed before traversal.');
    }
    for await (const entry of directory) {
      budget.entries++;
      if (budget.entries > limits.maxEntries) { budget.limited = true; break; }
      if (!TEAM_ID_PATTERN.test(entry.name)) continue;
      if (teams.length >= limits.maxTeams) { budget.limited = true; break; }
      teams.push(await inspectTeam(root, entry.name, limits, budget));
      if (budget.limited) break;
    }
    if (!unchanged(before, await privateDirectory(root))) throw legacyError('Legacy root changed during inspection.');
  }
  if (budget.limited) issues.push('Inspection limit reached; inventory and sizes are partial.');
  return {
    root, present: info !== undefined,
    complete: !budget.limited && teams.every(team => team.status === 'inspected'),
    sizeScope: 'direct-files-only', bytes: budget.bytes,
    teams: teams.sort((a, b) => a.name.localeCompare(b.name)), issues,
  };
}
