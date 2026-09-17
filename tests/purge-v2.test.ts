import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Team } from '../src/domain/team.ts';
import { purgeClosedTeam } from '../src/runtime/purge.ts';
import { TeamRuntime } from '../src/runtime/team-runtime.ts';
import { TeamPaths } from '../src/storage/paths.ts';

const at = '2026-01-01T00:00:00.000Z';
const team = (teamId: string, state: Team['state']): Team => ({
  schemaVersion: 2, teamId, state, createdAt: at, updatedAt: at,
});

test('human purge primitive removes only a closed inactive Team tree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-purge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new TeamRuntime(new TeamPaths(root));
  await runtime.teams.create(team('archive', 'closed'));
  await purgeClosedTeam(runtime.paths, runtime.teams, runtime.runtimes, 'archive');
  assert.equal(await runtime.teams.read('archive'), undefined);
  await assert.rejects(lstat(runtime.paths.team('archive')), { code: 'ENOENT' });

  await runtime.teams.create(team('open-team', 'open'));
  await assert.rejects(
    purgeClosedTeam(runtime.paths, runtime.teams, runtime.runtimes, 'open-team'),
    /Only a closed Team/,
  );
  assert.deepEqual(await runtime.teams.read('open-team'), team('open-team', 'open'));
});

test('purge refuses a closed Team while any member is still active', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-purge-member-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new TeamRuntime(new TeamPaths(root));
  await runtime.teams.create(team('busy-team', 'open'));
  await runtime.memberships.join({ teamId: 'busy-team', alias: 'lead', sessionId: 'session', cwd: '/repo', kind: 'external' });
  await runtime.teams.update('busy-team', current => ({ ...current, state: 'closing', updatedAt: at }));
  await runtime.teams.update('busy-team', current => ({ ...current, state: 'closed', updatedAt: at }));
  await assert.rejects(
    purgeClosedTeam(runtime.paths, runtime.teams, runtime.runtimes, 'busy-team'),
    /Every member must have left/,
  );
  assert.notEqual(await runtime.teams.read('busy-team'), undefined);
});
