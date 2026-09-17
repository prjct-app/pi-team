import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rm, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { assertTeam, assertTeamId, type Team } from '../domain/team.ts';
import { createAtomicJson, ensurePrivateDirectory, ensurePrivateTree, moveAtomic } from '../storage/atomic.ts';
import { TeamPaths } from '../storage/paths.ts';
import { assertNoSymlinkAncestors, inspectLegacy, legacyError, type LegacyInspectionOptions } from './inspect.ts';

export type LegacyMigrationOptions = LegacyInspectionOptions & {
  readonly teamName: string;
  readonly destination: TeamPaths;
  /** Deliberate opt-in, not a startup or constructor option. */
  readonly confirmed: true;
  /** Timestamp of the new archive, not an invented legacy creation time. */
  readonly importedAt?: string;
};
export type LegacyMigrationResult = {
  readonly team: Team;
  readonly sourceSha256: string;
  readonly omitted: {
    readonly members: number;
    readonly messages: number;
    readonly reasons: readonly string[];
  };
};

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep));
}

/**
 * Fail-fast exclusive v2 lock and gate. Unlike normal storage locking, this
 * never reclaims stale locks or probes a PID, even with signal zero.
 * Interrupted locks require manual recovery.
 */
async function withoutProcessProbes<T>(path: string, action: () => Promise<T>): Promise<T> {
  const gatePath = `${path}.gate`;
  const gate = await open(gatePath, 'wx', 0o600);
  try {
    await gate.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }));
    const lock = await open(path, 'wx', 0o600);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }));
      return await action();
    } finally {
      await lock.close();
      await unlink(path);
    }
  } finally {
    await gate.close();
    await unlink(gatePath);
  }
}

/**
 * Import only a closed team name into v2. V1 has no durable membership lifetime,
 * generation or message TTL mapping; importing those records would invent
 * identity or replay work. All source bytes and nested data stay in place.
 * Existing destinations (including interrupted imports) always fail closed.
 */
export async function migrateLegacyTeam(options: LegacyMigrationOptions): Promise<LegacyMigrationResult> {
  if (options.confirmed !== true) throw legacyError('Explicit migration confirmation required.', 'CONFIRMATION_REQUIRED');
  assertTeamId(options.teamName);
  const inspection = await inspectLegacy(options);
  const source = inspection.teams.find(team => team.name === options.teamName);
  if (!inspection.complete || !source || source.status !== 'inspected' || !source.mailbox) {
    throw legacyError('A complete safe inspection and valid mailbox are required.', 'LEGACY_NOT_MIGRATABLE');
  }
  const paths = options.destination;
  await assertNoSymlinkAncestors(paths.root);
  if (contains(inspection.root, paths.root) || contains(paths.root, inspection.root)) {
    throw legacyError('Legacy and v2 storage must not overlap.');
  }
  const importedAt = options.importedAt ?? new Date().toISOString();
  const team: Team = {
    schemaVersion: 2, teamId: options.teamName, state: 'closed', createdAt: importedAt, updatedAt: importedAt,
  };
  assertTeam(team);
  await ensurePrivateTree(paths.root, 'teams');
  await ensurePrivateTree(paths.root, 'control');
  await withoutProcessProbes(paths.teamLock(team.teamId), async () => {
    const exists = await lstat(paths.team(team.teamId)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (exists) throw legacyError('Destination already exists; no merge or overwrite is permitted.', 'ALREADY_EXISTS');
    const temporary = join(paths.teams(), `.${team.teamId}.${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      for (const name of ['members', 'runtimes', 'inbox', 'receipts', 'leases']) {
        await ensurePrivateDirectory(join(temporary, name));
      }
      await createAtomicJson(join(temporary, 'team.json'), team);
      // Reinspect before publication rather than importing a stale preview.
      const current = await inspectLegacy(options);
      const currentTeam = current.teams.find(candidate => candidate.name === team.teamId);
      if (!current.complete || currentTeam?.mailbox?.sha256 !== source.mailbox?.sha256) {
        throw legacyError('Legacy source changed; inspect again.', 'LEGACY_CHANGED');
      }
      await moveAtomic(temporary, paths.team(team.teamId));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  });
  return {
    team, sourceSha256: source.mailbox.sha256,
    omitted: {
      members: source.mailbox.members, messages: source.mailbox.messages,
      reasons: [
        'Members lack durable v2 identity, generation and membership timestamps; no members or runtimes imported.',
        'Messages lack unambiguous v2 recipients, generations and expiry; no messages replayed.',
        'Journals, snapshots, presence, worktrees and all other legacy files remain untouched and are not copied.',
      ],
    },
  };
}
