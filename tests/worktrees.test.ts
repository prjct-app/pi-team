import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { childEnv } from '../src/process-env.ts';
import { discoverRepository, runGit, WorktreeManager, type GitRunner } from '../src/worktrees.ts';

const exec = promisify(execFile);

async function repository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-repo-'));
  const store = await mkdtemp(join(tmpdir(), 'pi-team-worktrees-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(store, { recursive: true, force: true })]));
  await exec('git', ['init', '-b', 'develop', root]);
  await exec('git', ['-C', root, 'config', 'user.email', 'tests@example.com']);
  await exec('git', ['-C', root, 'config', 'user.name', 'Pi Team Tests']);
  await exec('git', ['-C', root, 'config', 'core.excludesFile', '']);
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

test('a reused worktree must belong to the requested repository, not merely share its branch name', async (t) => {
  const first = await repository(t);
  const secondRoot = await mkdtemp(join(tmpdir(), 'pi-team-foreign-repo-'));
  t.after(() => rm(secondRoot, { recursive: true, force: true }));
  await exec('git', ['init', '-b', 'develop', secondRoot]);
  await exec('git', ['-C', secondRoot, 'config', 'user.email', 'tests@example.com']);
  await exec('git', ['-C', secondRoot, 'config', 'user.name', 'Pi Team Tests']);
  await writeFile(join(secondRoot, 'README.md'), 'foreign\n');
  await exec('git', ['-C', secondRoot, 'add', 'README.md']);
  await exec('git', ['-C', secondRoot, 'commit', '-m', 'chore: foreign']);
  const manager = new WorktreeManager(first.store);
  await manager.allocate(first.root, 'release', 'backend', 'develop');
  await assert.rejects(manager.allocate(secondRoot, 'release', 'backend', 'develop'), /must belong to/);
});

test('concurrent allocation converges on one reusable worktree', async (t) => {
  const { root, store } = await repository(t);
  const manager = new WorktreeManager(store);
  const results = await Promise.all([
    manager.allocate(root, 'release', 'backend', 'develop'),
    manager.allocate(root, 'release', 'backend', 'develop'),
  ]);
  assert.equal(results.filter(result => result.reused).length, 1);
  assert.equal(new Set(results.map(result => result.path)).size, 1);
});

test('integration rejects non-SHA revision syntax before invoking cherry-pick', async (t) => {
  const { root, store } = await repository(t);
  const manager = new WorktreeManager(store);
  const integration = await manager.allocate(root, 'release', 'integration', 'develop');
  const result = await manager.integrate(integration, ['HEAD~1']);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /full hexadecimal commit ids/);
});

function restoreEnv(names: readonly string[]): () => void {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

test('coordinator git subprocesses omit GIT_DIR, tokens, and NODE_OPTIONS from the child env', async (t) => {
  const { root } = await repository(t);
  const restore = restoreEnv(['GIT_DIR', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY']);
  t.after(restore);
  process.env.GIT_DIR = join(tmpdir(), 'pi-team-missing-git-dir');
  process.env.GITHUB_TOKEN = 'ghs_probe';
  process.env.NODE_OPTIONS = '--throw-deprecation';
  process.env.NPM_TOKEN = 'npm_probe';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws_probe';
  try {
    const env = childEnv({ extra: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '1' }, excludeFromPath: [root] });
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '1');
    const pathDirs = (env.PATH ?? '').split(':');
    assert.equal(pathDirs.includes(''), false);
    assert.equal(pathDirs.includes('.'), false);
    assert.equal(pathDirs.includes(resolve(root)), false);
    assert.equal(pathDirs.includes(resolve(process.cwd())), false);
    const execDir = resolve(dirname(process.execPath));
    if (execDir !== resolve(process.cwd()) && execDir !== resolve(root)) assert.equal(pathDirs.includes(execDir), true);
    const top = await runGit(root, ['rev-parse', '--show-toplevel']);
    assert.equal(resolve(top.stdout), resolve(await realpath(root)));
  } finally {
    restore();
  }
  });

test('worktree allocation does not steal a live lock after the publication stale window', async (t) => {
  const { root, store } = await repository(t);
  let releaseGate = () => {};
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const git: GitRunner = async (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'add') await gate;
    return runGit(cwd, args);
  };
  const pending = new WorktreeManager(store, git).allocate(root, 'release', 'backend', 'develop');
  t.after(async () => { releaseGate(); await pending.catch(() => {}); });
  const lockPath = join(store, '.locks', 'release-worktrees.lock');
  const deadline = Date.now() + 5_000;
  const waitForPid = async (): Promise<string> => {
    const raw = await readFile(lockPath, 'utf8').catch(() => '');
    if (raw.trim() === String(process.pid)) return raw;
    if (Date.now() > deadline) throw new Error('allocation lock did not record a live pid');
    await new Promise(resolve => setTimeout(resolve, 10));
    return waitForPid();
  };
  assert.match(await waitForPid(), new RegExp(`^${process.pid}\\s*$`));
  const aged = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(lockPath, aged, aged);
  const rival = new WorktreeManager(store);
  await assert.rejects(rival.allocate(root, 'release', 'frontend', 'develop'), /busy/);
  assert.equal(await stat(join(store, 'release', 'worktrees', 'frontend')).catch(() => undefined), undefined);
  releaseGate();
  const first = await pending;
  assert.equal(first.reused, false);
  const second = await rival.allocate(root, 'release', 'frontend', 'develop');
  assert.equal(second.reused, false);
});

test('commit refuses a staged .env or id_ed25519 and leaves HEAD unchanged', async (t) => {
  const { root, store } = await repository(t);
  const manager = new WorktreeManager(store);
  const backend = await manager.allocate(root, 'release', 'backend', 'develop');
  const head = (await runGit(backend.path, ['rev-parse', 'HEAD'])).stdout;

  await writeFile(join(backend.path, '.env'), 'SECRET=1\n');
  await assert.rejects(manager.commit(backend, 'feat: add env'), /secret path: \.env/);
  assert.equal((await runGit(backend.path, ['rev-parse', 'HEAD'])).stdout, head);
  assert.equal((await runGit(backend.path, ['diff', '--cached', '--name-only'])).stdout, '');

  await rm(join(backend.path, '.env'));
  await writeFile(join(backend.path, 'id_ed25519'), 'private-key\n');
  await assert.rejects(manager.commit(backend, 'feat: add key'), /secret path: id_ed25519/);
  assert.equal((await runGit(backend.path, ['rev-parse', 'HEAD'])).stdout, head);
  assert.equal((await runGit(backend.path, ['diff', '--cached', '--name-only'])).stdout, '');
});
