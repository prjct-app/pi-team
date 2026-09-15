import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identifier } from './mailbox.ts';
import { childEnv } from './process-env.ts';
import { withFileLock } from './store.ts';

export type GitResult = { stdout: string; stderr: string };
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;
export type RepositoryState = { root: string; branch: string; head: string; clean: boolean };
export type ManagedWorktree = { alias: string; path: string; branch: string; head: string; reused: boolean };
const ALLOCATION_ATTEMPTS = 100;
const WORKTREE_LOCK_STALE_MS = 10 * 60 * 1000;

export type IntegrationResult = { ok: true; head: string; applied: string[] } | { ok: false; commit: string; error: string; applied: string[] };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const runGit: GitRunner = (cwd, args) => new Promise((resolvePromise, reject) => {
  execFile('git', ['-C', cwd, ...args], {
    env: childEnv({ extra: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '1' }, excludeFromPath: [cwd] }),
    maxBuffer: 4_000_000,
  }, (error, stdout, stderr) => {
    if (error) {
      reject(Object.assign(new Error(`git ${args[0] ?? ''} failed: ${String(stderr).trim() || error.message}`), { cause: error }));
      return;
    }
    resolvePromise({ stdout: String(stdout).trim(), stderr: String(stderr).trim() });
  });
});

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe worktree parent: ${path}. Expected a private directory owned by this user.`);
  }
}

async function missing(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function succeeds(action: Promise<unknown>): Promise<boolean> {
  try { await action; return true; }
  catch { return false; }
}

function posixBasename(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts[parts.length - 1] ?? path;
}

function secretPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const base = posixBasename(normalized);
  if (base === '.env' || base.startsWith('.env.') || base === '.netrc') return true;
  if (base === 'id_rsa' || base === 'id_ed25519') return true;
  if (base.endsWith('.pem') || base.endsWith('.p12') || base.endsWith('.pfx')) return true;
  if ((base === 'credentials.json' || base === 'auth.json') &&
      normalized.split('/').some(part => part.startsWith('.') && part !== base)) return true;
  return false;
}

export async function discoverRepository(cwd: string, git: GitRunner = runGit): Promise<RepositoryState> {
  const root = resolve(await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).stdout));
  const branch = (await git(root, ['branch', '--show-current'])).stdout;
  if (!branch) throw new Error('Managed teams require a checked-out branch, not detached HEAD');
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout;
  const clean = !(await git(root, ['status', '--porcelain=v1'])).stdout;
  return { root, branch, head, clean };
}

export class WorktreeManager {
  constructor(readonly storeRoot: string, readonly git: GitRunner = runGit) {}

  private teamRoot(team: string): string { return join(this.storeRoot, identifier(team), 'worktrees'); }
  private path(team: string, alias: string): string { return join(this.teamRoot(team), identifier(alias)); }
  private branch(team: string, alias: string): string { return `pi-team/${identifier(team)}/${identifier(alias)}`; }
  private lockPath(team: string): string { return join(this.storeRoot, '.locks', `${identifier(team)}-worktrees.lock`); }

  private async prepare(team: string): Promise<void> {
    await privateDirectory(this.storeRoot);
    await privateDirectory(join(this.storeRoot, '.locks'));
    await privateDirectory(join(this.storeRoot, identifier(team)));
    await privateDirectory(this.teamRoot(team));
  }

  async allocate(repoRoot: string, team: string, alias: string, baseRef: string): Promise<ManagedWorktree> {
    const root = resolve(await realpath(repoRoot));
    await this.prepare(team);
    return this.allocateAttempt(root, team, alias, baseRef, ALLOCATION_ATTEMPTS);
  }

  private async allocateAttempt(root: string, team: string, alias: string, baseRef: string, remaining: number): Promise<ManagedWorktree> {
    if (remaining < 1) throw new Error('Managed worktree allocation is busy; try again.');
    const worktreePath = this.path(team, alias);
    const branch = this.branch(team, alias);
    try { return await withFileLock(this.lockPath(team), async () => {
      if (!await missing(worktreePath)) {
        const info = await lstat(worktreePath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe managed worktree path: ${worktreePath}`);
        const actualRoot = resolve((await this.git(worktreePath, ['rev-parse', '--show-toplevel'])).stdout);
        const actualBranch = (await this.git(worktreePath, ['branch', '--show-current'])).stdout;
        const expectedCommonRaw = (await this.git(root, ['rev-parse', '--git-common-dir'])).stdout;
        const expectedCommon = resolve(await realpath(resolve(root, expectedCommonRaw)));
        const actualCommonRaw = (await this.git(worktreePath, ['rev-parse', '--git-common-dir'])).stdout;
        const actualCommon = resolve(await realpath(resolve(worktreePath, actualCommonRaw)));
        if (resolve(await realpath(actualRoot)) !== resolve(await realpath(worktreePath)) || actualBranch !== branch || actualCommon !== expectedCommon) {
          throw new Error(`Managed worktree mismatch for ${alias}; it must belong to ${root}. Manual recovery required`);
        }
        return { alias, path: worktreePath, branch, head: (await this.git(worktreePath, ['rev-parse', 'HEAD'])).stdout, reused: true };
      }
      await this.git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
      const branchExists = !!(await this.git(root, ['branch', '--list', branch])).stdout;
      await this.git(root, branchExists
        ? ['worktree', 'add', worktreePath, branch]
        : ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
      return { alias, path: worktreePath, branch, head: (await this.git(worktreePath, ['rev-parse', 'HEAD'])).stdout, reused: false };
    }, { staleMs: WORKTREE_LOCK_STALE_MS, livePid: true }); } catch (error) {
      if ((error as { code?: string }).code !== 'RECORD_LOCKED') throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5 + Math.random() * 25));
      return this.allocateAttempt(root, team, alias, baseRef, remaining - 1);
    }
  }

  async dirty(worktree: Pick<ManagedWorktree, 'path'>): Promise<boolean> {
    return !!(await this.git(worktree.path, ['status', '--porcelain=v1'])).stdout;
  }

  async commit(worktree: Pick<ManagedWorktree, 'path'>, message: string): Promise<{ head: string; changed: boolean }> {
    if (!await this.dirty(worktree)) return { head: (await this.git(worktree.path, ['rev-parse', 'HEAD'])).stdout, changed: false };
    const safeMessage = message.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!safeMessage) throw new Error('Commit message is required');
    await this.git(worktree.path, ['add', '-A']);
    const staged = (await this.git(worktree.path, ['diff', '--cached', '--name-only', '-z'])).stdout
      .split('\0')
      .filter(Boolean);
    const secret = staged.find(secretPath);
    if (secret) {
      await this.git(worktree.path, ['reset', '-q', 'HEAD']).catch(() => {});
      throw new Error(`Refusing to commit secret path: ${secret}`);
    }
    await this.git(worktree.path, ['commit', '-m', safeMessage]);
    return { head: (await this.git(worktree.path, ['rev-parse', 'HEAD'])).stdout, changed: true };
  }

  async integrate(worktree: Pick<ManagedWorktree, 'path'>, commits: string[]): Promise<IntegrationResult> {
    const applied: string[] = [];
    for (const commit of [...new Set(commits)]) {
      if (!/^[a-f0-9]{40,64}$/.test(commit)) return { ok: false, commit, error: 'Integration accepts only full hexadecimal commit ids.', applied };
      if (await succeeds(this.git(worktree.path, ['merge-base', '--is-ancestor', commit, 'HEAD']))) continue;
      try {
        await this.git(worktree.path, ['cherry-pick', commit]);
        applied.push(commit);
      } catch (error) {
        await this.git(worktree.path, ['cherry-pick', '--abort']).catch(() => {});
        return { ok: false, commit, error: reason(error), applied };
      }
    }
    return { ok: true, head: (await this.git(worktree.path, ['rev-parse', 'HEAD'])).stdout, applied };
  }
}
