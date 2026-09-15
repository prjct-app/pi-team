import { dirname, resolve } from 'node:path';

/**
 * Coordinator subprocess environment. This is an allowlist, not a sandbox:
 * peers still have bash, and the same OS user can still read secrets.
 */
const ALLOWED = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'CI']);
const BLOCKED = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'LD_PRELOAD',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_ASKPASS',
  'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN',
]);
const SENSITIVE = /KEY|TOKEN|SECRET/;
const TRUSTED_PATH_SUFFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] as const;

function allowed(name: string): boolean {
  if (BLOCKED.has(name) || name.startsWith('DYLD_') || name.startsWith('AWS_') || SENSITIVE.test(name)) return false;
  return ALLOWED.has(name) || name.startsWith('LC_');
}

function commandPath(exclude: readonly string[] = []): string {
  const blocked = new Set([process.cwd(), ...exclude].map(path => resolve(path)));
  return [dirname(process.execPath), ...TRUSTED_PATH_SUFFIX]
    .map(dir => resolve(dir))
    .filter((dir, index, all) => dir.startsWith('/') && !blocked.has(dir) && all.indexOf(dir) === index)
    .join(':');
}

export function childEnv(options: { extra?: Readonly<Record<string, string>>; excludeFromPath?: readonly string[] } = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && name !== 'PATH' && allowed(name))),
    PATH: commandPath(options.excludeFromPath),
    ...options.extra,
  };
}
