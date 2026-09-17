import { randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory, moveAtomic, withStorageLock } from '../storage/atomic.ts';
import { TeamPaths } from '../storage/paths.ts';
import { RuntimeStore } from '../supervisor/runtime-store.ts';
import { TeamStore } from '../storage/team-store.ts';

/** Human-command primitive: permanently remove a fully closed, inactive v2 team. */
export async function purgeClosedTeam(
  paths: TeamPaths,
  teams: TeamStore,
  runtimes: RuntimeStore,
  teamId: string,
): Promise<void> {
  await withStorageLock(paths.teamLock(teamId), async () => {
    const team = await teams.read(teamId);
    if (!team) throw Object.assign(new Error(`Unknown team "${teamId}".`), { code: 'NOT_FOUND' });
    if (team.state !== 'closed') throw new Error('Only a closed Team can be purged.');
    const [members, runtimeRecords] = await Promise.all([
      teams.listMembers(teamId),
      runtimes.list(teamId),
    ]);
    if (members.some(member => member.state !== 'left')) throw new Error('Every member must have left before purge.');
    if (runtimeRecords.some(runtime => runtime.state !== 'terminated')) throw new Error('Every supervised runtime must be terminated before purge.');
    await ensurePrivateDirectory(paths.team(teamId), false);
    for (const child of ['members', 'runtimes', 'inbox', 'receipts', 'leases']) {
      await ensurePrivateDirectory(join(paths.team(teamId), child), false);
    }
    const before = await lstat(paths.team(teamId));
    const tombstone = join(paths.teams(), `.purge-${teamId}-${randomUUID()}`);
    await moveAtomic(paths.team(teamId), tombstone);
    const info = await lstat(tombstone);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== before.dev || info.ino !== before.ino) {
      throw new Error('Purge tombstone identity changed.');
    }
    await rm(tombstone, { recursive: true });
  });
}
