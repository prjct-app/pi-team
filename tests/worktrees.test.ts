import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { discoverRepository, runGit, WorktreeManager } from '../src/worktrees.ts';

const exec = promisify(execFile);

async function repository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-repo-'));
  const store = await mkdtemp(join(tmpdir(), 'pi-team-worktrees-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(store, { recursive: true, force: true })]));
  await exec('git', ['init', '-b', 'develop', root]);
  await exec('git', ['-C', root, 'config', 'user.email', 'tests@example.com']);
  await exec('git', ['-C', root, 'config', 'user.name', 'Pi Team Tests']);
  await writeFile(join(root, 'README.md'), 'base\n');
  await exec('git', ['-C', root, 'add', 'README.md']);
  await exec('git', ['-C', root, 'commit', '-m', 'chore: initial']);
  return { root, store };
}

test('repository discovery returns branch, head, root, and cleanliness', async (t) => {
  const { root } = await repository(t);
  const state = await discoverRepository(root);
  assert.equal(state.root, await realpath(root));
  assert.equal(state.branch, 'develop');
  assert.equal(state.clean, true);
  assert.match(state.head, /^[a-f0-9]{40}$/);
  await writeFile(join(root, 'dirty.txt'), 'dirty');
  assert.equal((await discoverRepository(root)).clean, false);
});

test('every managed alias receives a dedicated reusable branch and worktree', async (t) => {
  const { root, store } = await repository(t);
  const manager = new WorktreeManager(store);
  const backend = await manager.allocate(root, 'release', 'backend', 'develop');
  const frontend = await manager.allocate(root, 'release', 'frontend', 'develop');
  assert.notEqual(backend.path, frontend.path);
  assert.equal(backend.branch, 'pi-team/release/backend');
  assert.equal((await runGit(backend.path, ['branch', '--show-current'])).stdout, backend.branch);
  assert.equal((await manager.allocate(root, 'release', 'backend', 'develop')).reused, true);
});

test('local commits integrate in a dedicated worktree without pushing', async (t) => {
  const { root, store } = await repository(t);
  const manager = new WorktreeManager(store);
  const backend = await manager.allocate(root, 'release', 'backend', 'develop');
  const frontend = await manager.allocate(root, 'release', 'frontend', 'develop');
  await writeFile(join(backend.path, 'api.txt'), 'api\n');
  await writeFile(join(frontend.path, 'ui.txt'), 'ui\n');
  const api = await manager.commit(backend, 'feat: add api');
  const ui = await manager.commit(frontend, 'feat: add ui');
  assert.equal(api.changed, true);
  assert.equal(ui.changed, true);
  const integration = await manager.allocate(root, 'release', 'integration', 'develop');
  const result = await manager.integrate(integration, [api.head, ui.head]);
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(integration.path, 'api.txt'), 'utf8'), 'api\n');
  assert.equal(await readFile(join(integration.path, 'ui.txt'), 'utf8'), 'ui\n');
  assert.equal((await runGit(root, ['remote'])).stdout, '', 'The fixture has no remote and integration did not require one');
});

test('an existing symlink is never accepted as a managed worktree', async (t) => {
  const { root, store } = await repository(t);
  const target = join(store, 'release', 'worktrees');
  await (await import('node:fs/promises')).mkdir(target, { recursive: true, mode: 0o700 });
  await symlink(root, join(target, 'backend'));
  const manager = new WorktreeManager(store);
  await assert.rejects(manager.allocate(root, 'release', 'backend', 'develop'), /Unsafe managed worktree path/);
});
