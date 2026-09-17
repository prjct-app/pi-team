import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { inspectLegacy } from '../src/legacy/inspect.ts';
import { migrateLegacyTeam } from '../src/legacy/migrate.ts';
import { TeamPaths } from '../src/storage/paths.ts';
import { TeamStore } from '../src/storage/team-store.ts';

const at = '2026-01-01T00:00:00.000Z';
const state = {
  version: 1,
  members: [{ team: 'alpha', alias: 'worker', session: 'old-session', token: 'secret-token', cwd: '/old/worktree', pid: 99999, seen: 1, status: 'busy' }],
  messages: [{ id: 'old-message', team: 'alpha', from: 'worker', to: 'worker', subject: 'old work', body: 'do not replay', kind: 'request', state: 'processing', created: 1, rootId: 'old-message' }],
};

async function fixture(t: TestContext) {
  // Canonicalize the OS temp directory (macOS may expose it through /var).
  const base = await mkdtemp(join(await realpath(tmpdir()), 'pi-team-legacy-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'legacy');
  const paths = new TeamPaths(join(base, 'v2'));
  await mkdir(join(root, 'alpha'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(` ${JSON.stringify(state)}\n`);
  await writeFile(join(root, 'alpha', 'state.json'), bytes, { mode: 0o600 });
  return { base, root, paths, bytes };
}

test('inspection is shallow, read-only, bounded to the injected teams root and reports runtime evidence', async t => {
  const { base, root, bytes } = await fixture(t);
  await mkdir(join(root, 'alpha', 'worktrees'), { mode: 0o700 });
  await writeFile(join(root, 'alpha', 'worktrees', 'private.txt'), 'untouched', { mode: 0o600 });
  await writeFile(join(root, 'alpha', 'runtime.json'), '{not parsed', { mode: 0o600 });
  await mkdir(join(base, 'managed-teams'), { mode: 0o700 });
  await writeFile(join(base, 'managed-teams', 'unrelated'), 'ignored');
  const report = await inspectLegacy({ root });
  assert.equal(report.complete, true);
  assert.equal(report.sizeScope, 'direct-files-only');
  assert.deepEqual(report.teams.map(team => team.name), ['alpha']);
  assert.equal(report.teams[0].bytes, bytes.length + Buffer.byteLength('{not parsed'));
  assert.equal(report.teams[0].possibleRuntimeMetadata, true);
  assert.equal(report.teams[0].mailbox?.members, 1);
  assert.equal(report.teams[0].mailbox?.messages, 1);
  assert.equal(report.teams[0].entries.find(entry => entry.name === 'worktrees')?.kind, 'directory');
  assert.deepEqual(await readFile(join(root, 'alpha', 'state.json')), bytes);
  assert.equal(JSON.stringify(report).includes('secret-token'), false);
  assert.equal(JSON.stringify(report).includes('do not replay'), false);
  assert.deepEqual(await readdir(root), ['alpha']);
});

test('missing root is not created; unsafe root types, ancestors and permissions are rejected', async t => {
  const { base, root } = await fixture(t);
  const missing = join(base, 'absent');
  assert.equal((await inspectLegacy({ root: missing })).present, false);
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  await symlink(root, join(base, 'link'));
  await assert.rejects(inspectLegacy({ root: join(base, 'link') }), { code: 'UNSAFE_LEGACY' });
  await assert.rejects(inspectLegacy({ root: join(base, 'link', 'alpha') }), { code: 'UNSAFE_LEGACY' });
  await writeFile(join(base, 'file'), 'not a directory', { mode: 0o600 });
  await assert.rejects(inspectLegacy({ root: join(base, 'file') }), { code: 'UNSAFE_LEGACY' });
  await chmod(root, 0o755);
  await assert.rejects(inspectLegacy({ root }), { code: 'UNSAFE_LEGACY' });
});

test('unsafe teams and files are reported without following links or permitting migration', async t => {
  const { base, root, paths } = await fixture(t);
  await mkdir(join(base, 'outside'), { mode: 0o700 });
  await writeFile(join(base, 'outside', 'secret'), 'secret', { mode: 0o600 });
  await symlink(join(base, 'outside'), join(root, 'linked-team'));
  await symlink(join(base, 'outside', 'secret'), join(root, 'alpha', 'linked-file'));
  await writeFile(join(root, 'not-directory'), '', { mode: 0o600 });
  await writeFile(join(root, 'alpha', 'public'), '', { mode: 0o644 });
  const report = await inspectLegacy({ root });
  assert.equal(report.complete, false);
  assert.equal(report.teams.find(team => team.name === 'linked-team')?.status, 'rejected');
  assert.equal(report.teams.find(team => team.name === 'not-directory')?.status, 'rejected');
  assert.equal(report.teams.find(team => team.name === 'alpha')?.entries.find(entry => entry.name === 'linked-file')?.kind, 'rejected');
  assert.equal(JSON.stringify(report).includes('secret'), false);
  await assert.rejects(migrateLegacyTeam({ root, destination: paths, teamName: 'alpha', confirmed: true }), { code: 'LEGACY_NOT_MIGRATABLE' });
  await assert.rejects(lstat(paths.root), { code: 'ENOENT' });
});

test('team, entry, file, per-file byte and total byte limits fail closed', async t => {
  const { root, paths } = await fixture(t);
  await mkdir(join(root, 'beta'), { mode: 0o700 });
  await writeFile(join(root, 'alpha', 'other'), '1234', { mode: 0o600 });
  for (const limits of [{ maxTeams: 1 }, { maxEntries: 1 }, { maxFiles: 1 }, { maxFileBytes: 1 }, { maxBytes: 1 }]) {
    const report = await inspectLegacy({ root, limits });
    assert.equal(report.complete, false);
    assert.match(report.issues.join(' '), /limit/);
    await assert.rejects(migrateLegacyTeam({ root, limits, destination: paths, teamName: 'alpha', confirmed: true }), { code: 'LEGACY_NOT_MIGRATABLE' });
  }
  await assert.rejects(inspectLegacy({ root, limits: { maxTeams: 0 } }), { code: 'LEGACY_LIMIT' });
  await assert.rejects(inspectLegacy({ root, limits: { maxBytes: Infinity } }), { code: 'LEGACY_LIMIT' });
});

test('valid envelopes are accepted; corrupt hashes, malformed states and team mismatches are not', async t => {
  const { root } = await fixture(t);
  const file = join(root, 'alpha', 'state.json');
  const payloadJson = JSON.stringify(state);
  const envelope = { schemaVersion: 1, revision: 1, contentHash: createHash('sha256').update(payloadJson).digest('hex'), payload: state };
  await writeFile(file, JSON.stringify(envelope));
  assert.equal((await inspectLegacy({ root })).teams[0].mailbox?.members, 1);
  for (const raw of ['{', JSON.stringify({ ...envelope, contentHash: 'bad' }), JSON.stringify({ version: 1, members: [], messages: [{}] }), JSON.stringify({ ...state, members: [{ ...state.members[0], team: 'other' }] })]) {
    await writeFile(file, raw);
    const report = await inspectLegacy({ root });
    assert.equal(report.complete, false);
    assert.equal(report.teams[0].mailbox, undefined);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});

test('explicit migration archives only a closed team; source bytes remain intact and retries fail closed', async t => {
  const { root, paths, bytes } = await fixture(t);
  const opaque = Buffer.from([0, 255, 1, 2, 3]);
  for (const name of ['journal.jsonl', 'snapshot.json']) await writeFile(join(root, 'alpha', name), opaque, { mode: 0o600 });
  await mkdir(join(root, 'alpha', 'worktrees'), { mode: 0o700 });
  await writeFile(join(root, 'alpha', 'worktrees', 'tracked'), opaque, { mode: 0o600 });
  const kill = t.mock.method(process, 'kill', () => { throw new Error('No process signal, including zero, is allowed.'); });
  const options = { root, destination: paths, teamName: 'alpha', confirmed: true as const, importedAt: at };
  await assert.rejects(migrateLegacyTeam({ ...options, confirmed: false as unknown as true }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(lstat(paths.root), { code: 'ENOENT' });
  const migrated = await migrateLegacyTeam(options);
  assert.equal(migrated.team.state, 'closed');
  assert.equal(migrated.team.createdAt, at);
  assert.equal(migrated.omitted.members, 1);
  assert.equal(migrated.omitted.messages, 1);
  assert.match(migrated.omitted.reasons.join(' '), /generation/);
  assert.deepEqual(await new TeamStore(paths).read('alpha'), migrated.team);
  for (const dir of ['members', 'runtimes', 'inbox', 'receipts', 'leases']) assert.deepEqual(await readdir(join(paths.team('alpha'), dir)), []);
  assert.deepEqual((await readdir(paths.team('alpha'))).sort(), ['inbox', 'leases', 'members', 'receipts', 'runtimes', 'team.json']);
  await assert.rejects(migrateLegacyTeam(options), { code: 'ALREADY_EXISTS' });
  assert.deepEqual(await readFile(join(root, 'alpha', 'state.json')), bytes);
  for (const name of ['journal.jsonl', 'snapshot.json', 'worktrees/tracked']) assert.deepEqual(await readFile(join(root, 'alpha', name)), opaque);
  assert.equal(kill.mock.callCount(), 0);
});

test('overlapping destination and existing locks fail without process probes or source writes', async t => {
  const { root, paths, bytes } = await fixture(t);
  const kill = t.mock.method(process, 'kill', () => { throw new Error('Unexpected signal'); });
  await assert.rejects(migrateLegacyTeam({ root, destination: new TeamPaths(join(root, 'v2')), teamName: 'alpha', confirmed: true }), { code: 'UNSAFE_LEGACY' });
  await mkdir(paths.control(), { recursive: true, mode: 0o700 });
  const lockBytes = JSON.stringify({ pid: 99999, token: 'legacy', createdAt: '2000-01-01T00:00:00.000Z' });
  await writeFile(paths.teamLock('alpha'), lockBytes, { mode: 0o600 });
  await assert.rejects(migrateLegacyTeam({ root, destination: paths, teamName: 'alpha', confirmed: true }), { code: 'EEXIST' });
  assert.equal(await readFile(paths.teamLock('alpha'), 'utf8'), lockBytes);
  assert.deepEqual(await readFile(join(root, 'alpha', 'state.json')), bytes);
  assert.equal(kill.mock.callCount(), 0);
  await assert.rejects(lstat(paths.team('alpha')), { code: 'ENOENT' });
});
