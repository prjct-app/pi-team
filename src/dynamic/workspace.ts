import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateTree } from '../storage/atomic.ts';

export type Git = (cwd: string, args: readonly string[]) => Promise<string>;

const defaultGit: Git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', [...args], { cwd, env: process.env, timeout: 60_000 }, (error, stdout) => {
    if (error) { reject(new Error(`git ${args[0]} failed`)); return; }
    resolve(String(stdout).trim());
  });
});

/** Whether Experts can work in parallel here: only inside a Git checkout, where each gets a worktree. */
export async function isGitCheckout(projectPath: string, git: Git = defaultGit): Promise<boolean> {
  return git(projectPath, ['rev-parse', '--show-toplevel']).then(() => true, () => false);
}

/**
 * A write-capable Expert's own Git worktree, created once and kept across its
 * assignments. Parallel Experts then never share a checkout: each makes its
 * own branch and pull request without moving another Expert's files or HEAD.
 * It starts detached at the project's current HEAD; the Expert branches from
 * there (or from origin) as its task says.
 */
export async function expertWorkspace(input: {
  readonly root: string; readonly teamId: string; readonly expertId: string; readonly projectPath: string;
}, git: Git = defaultGit): Promise<string> {
  const path = join(input.root, 'projects', input.teamId, 'worktrees', input.expertId);
  const existing = await lstat(path).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Unsafe Expert workspace.');
    // Still a registered worktree of this project: reuse it as-is.
    if (await git(path, ['rev-parse', '--is-inside-work-tree']).then(value => value === 'true', () => false)) return path;
    throw new Error('Expert workspace exists but is not a Git worktree; remove it or run git worktree prune.');
  }
  await ensurePrivateTree(input.root, 'projects', input.teamId, 'worktrees');
  const top = await git(input.projectPath, ['rev-parse', '--show-toplevel']);
  await git(top, ['worktree', 'prune']);
  await git(top, ['worktree', 'add', '--detach', path, 'HEAD']);
  return path;
}
