import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ensurePrivateDirectory, ensurePrivateTree, readJson, replaceAtomicJson, withStorageLock } from '../storage/atomic.ts';
import { defaultStorageRoot } from '../storage/paths.ts';
import { assertState, LIMITS, type TeamState } from './domain.ts';

export type Project = { readonly teamId: string; readonly path: string };
export async function resolveProject(cwd: string): Promise<Project> {
  const canonical = await realpath(cwd);
  const repository = async (path: string): Promise<string | undefined> => {
    const marker = await lstat(join(path, '.git')).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (marker && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return path;
    return dirname(path) === path ? undefined : repository(dirname(path));
  };
  const path = await repository(canonical) ?? canonical;
  return { teamId: `p-${createHash('sha256').update(path).digest('hex').slice(0, 40)}`, path };
}

export class DynamicStore {
  readonly root: string;
  constructor(root = join(defaultStorageRoot(), 'orchestration-v2')) { this.root = resolve(root); }
  directory(teamId: string): string {
    if (!/^p-[a-f0-9]{40}$/.test(teamId)) throw new Error('Invalid project Team identity.');
    return join(this.root, 'projects', teamId);
  }
  sessionPath(teamId: string, sessionRef: string): string {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionRef)) throw new Error('Invalid Expert session reference.');
    return join(this.directory(teamId), 'sessions', `${sessionRef}.jsonl`);
  }
  async read(teamId: string): Promise<TeamState | undefined> {
    const directory = this.directory(teamId);
    for (const path of [this.root, join(this.root, 'projects'), directory]) {
      const present = await ensurePrivateDirectory(path, false).then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      });
      if (!present) return undefined;
    }
    return readJson(join(directory, 'state.json'), assertState, LIMITS.recordBytes);
  }
  async update<T>(project: Project, action: (current: TeamState | undefined) => Promise<{ state: TeamState; result: T }> | { state: TeamState; result: T }): Promise<T> {
    const directory = this.directory(project.teamId);
    await ensurePrivateTree(this.root, 'projects', project.teamId);
    return withStorageLock(join(directory, 'state.lock'), async () => {
      const current = await this.read(project.teamId);
      if (current && current.projectPath !== project.path) throw new Error('Project binding mismatch.');
      const { state, result } = await action(current);
      assertState(state);
      await replaceAtomicJson(join(directory, 'state.json'), state, { maxBytes: LIMITS.recordBytes });
      return result;
    });
  }
}
