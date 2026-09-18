import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { defaultProcessController, type ProcessController, type ProcessIdentity } from '../process-identity.ts';
import type { OwnerIdentity, OwnedRuntime } from './runtime-store.ts';

export const TMUX_RUNTIME_ID = '@pi-team-runtime-id';
export const TMUX_OWNER_INSTANCE = '@pi-team-owner-instance';
export const TMUX_TOKEN_HASH = '@pi-team-token-hash';

const ENV_RUNTIME_ID = 'PI_TEAM_RUNTIME_ID';
const ENV_OWNER_INSTANCE = 'PI_TEAM_OWNER_INSTANCE';
const ENV_OWNER_PROCESS_NONCE = 'PI_TEAM_OWNER_PROCESS_NONCE';
const ENV_TOKEN_HASH = 'PI_TEAM_TOKEN_HASH';
const ENV_TEAM_ID = 'PI_TEAM_TEAM_ID';
const ENV_MEMBER_ID = 'PI_TEAM_MEMBER_ID';
const ENV_MEMBER_ALIAS = 'PI_TEAM_MEMBER_ALIAS';
const ENV_MEMBER_SESSION = 'PI_TEAM_MEMBER_SESSION';
const ENV_MEMBER_GENERATION = 'PI_TEAM_MEMBER_GENERATION';
const ENV_MEMBER_LEASE_TOKEN = 'PI_TEAM_MEMBER_LEASE_TOKEN';
const ENV_MEMBER_LEASE_GENERATION = 'PI_TEAM_MEMBER_LEASE_GENERATION';
const ENV_AUTO_REQUESTS = 'PI_TEAM_AUTO_REQUESTS';
const ENV_CONTROL_SOCKET = 'PI_TEAM_CONTROL_SOCKET';
const ENV_CONTROL_TOKEN = 'PI_TEAM_CONTROL_TOKEN';

export type TmuxCommandResult = { readonly stdout: string; readonly stderr: string };
export type TmuxCommand = (program: string, args: readonly string[], cwd?: string) => Promise<TmuxCommandResult>;

export type LaunchedTmuxRuntime = {
  readonly session: string;
  readonly identity: ProcessIdentity;
  readonly ownershipTokenHash: string;
};

export type TmuxLaunchOptions = {
  readonly runtimeId: string;
  readonly owner: OwnerIdentity;
  readonly cwd: string;
  readonly command: readonly [string, ...string[]];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly controlSocket: string;
  readonly controlToken: string;
  readonly ownershipToken: string;
  readonly workerMembership: {
    readonly teamId: string;
    readonly memberId: string;
    readonly alias: string;
    readonly sessionId: string;
    readonly memberGeneration: number;
    readonly leaseToken: string;
    readonly leaseGeneration: number;
  };
  readonly autoRequests: boolean;
};

const defaultCommand: TmuxCommand = (program, args, cwd) => new Promise((resolvePromise, reject) => {
  execFile(program, [...args], { cwd, env: process.env, timeout: 10_000 }, (error, stdout, stderr) => {
    if (error) { reject(error); return; }
    resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
  });
});

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

function sessionName(runtimeId: string): string {
  return `pi-team-v2-${createHash('sha256').update(runtimeId).digest('hex').slice(0, 24)}`;
}

function parsePid(value: string): number | undefined {
  const processPid = Number(value.trim());
  return Number.isSafeInteger(processPid) && processPid > 1 ? processPid : undefined;
}

function environment(output: string): ReadonlyMap<string, string> {
  return new Map(output.split('\n').filter(line => line.includes('=')).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

const ENVIRONMENT_MAX_BYTES = 256 * 1024;
const TMUX_MANAGED_ENVIRONMENT = new Set(['TMUX', 'TMUX_PANE', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'PWD', 'OLDPWD', 'SHLVL', '_']);
function clientEnvironment(source: TmuxLaunchOptions['environment']): readonly string[] {
  const entries = Object.entries(source ?? {}).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && !entry[0].startsWith('PI_TEAM_') &&
    !TMUX_MANAGED_ENVIRONMENT.has(entry[0]))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  if (Buffer.byteLength(entries.join('\0'), 'utf8') > ENVIRONMENT_MAX_BYTES) {
    throw new Error('Supervised runtime environment exceeds its byte limit.');
  }
  return entries.flatMap(value => ['-e', value]);
}

export class TmuxAdapter {
  constructor(
    private readonly run: TmuxCommand = defaultCommand,
    private readonly processes: ProcessController = defaultProcessController,
  ) {}

  async available(): Promise<boolean> {
    return this.run('tmux', ['-V']).then(() => true, () => false);
  }

  async launch(options: TmuxLaunchOptions): Promise<LaunchedTmuxRuntime> {
    if (!isAbsolute(options.cwd)) throw new Error('Supervised runtime cwd must be absolute.');
    if (options.controlToken.length < 64 || options.ownershipToken.length < 64) throw new Error('Runtime control tokens are too short.');
    const session = sessionName(options.runtimeId);
    const tokenHash = hashToken(options.ownershipToken);
    const target = `=${session}`;
    const args = [
      'new-session', '-d', '-s', session, '-c', options.cwd,
      ...clientEnvironment(options.environment),
      '-e', `${ENV_RUNTIME_ID}=${options.runtimeId}`,
      '-e', `${ENV_OWNER_INSTANCE}=${options.owner.ownerInstanceId}`,
      '-e', `${ENV_OWNER_PROCESS_NONCE}=${options.owner.ownerProcessNonce}`,
      '-e', `${ENV_TOKEN_HASH}=${tokenHash}`,
      '-e', `${ENV_TEAM_ID}=${options.workerMembership.teamId}`,
      '-e', `${ENV_MEMBER_ID}=${options.workerMembership.memberId}`,
      '-e', `${ENV_MEMBER_ALIAS}=${options.workerMembership.alias}`,
      '-e', `${ENV_MEMBER_SESSION}=${options.workerMembership.sessionId}`,
      '-e', `${ENV_MEMBER_GENERATION}=${options.workerMembership.memberGeneration}`,
      '-e', `${ENV_MEMBER_LEASE_TOKEN}=${options.workerMembership.leaseToken}`,
      '-e', `${ENV_MEMBER_LEASE_GENERATION}=${options.workerMembership.leaseGeneration}`,
      '-e', `${ENV_AUTO_REQUESTS}=${options.autoRequests ? '1' : '0'}`,
      '-e', `${ENV_CONTROL_SOCKET}=${options.controlSocket}`,
      '-e', `${ENV_CONTROL_TOKEN}=${options.controlToken}`,
      '--', ...options.command,
    ];
    await this.run('tmux', args, options.cwd);
    try {
      await this.run('tmux', ['set-option', '-t', target, TMUX_RUNTIME_ID, options.runtimeId]);
      await this.run('tmux', ['set-option', '-t', target, TMUX_OWNER_INSTANCE, options.owner.ownerInstanceId]);
      await this.run('tmux', ['set-option', '-t', target, TMUX_TOKEN_HASH, tokenHash]);
      const pane = await this.run('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}']);
      const processPid = parsePid(pane.stdout);
      const identity = processPid ? await this.processes.inspect(processPid) : undefined;
      if (!identity) throw new Error('Could not verify the supervised runtime process identity.');
      return { session, identity, ownershipTokenHash: tokenHash };
    } catch (error) {
      if (await this.environmentMatches(session, options.runtimeId, options.owner, tokenHash)) {
        await this.run('tmux', ['kill-session', '-t', target]).catch(() => ({ stdout: '', stderr: '' }));
      }
      throw error;
    }
  }

  async metadataMatches(runtime: OwnedRuntime): Promise<boolean> {
    if (!runtime.tmuxSession || !runtime.tmuxOwnershipTokenHash) return false;
    const format = `#{${TMUX_RUNTIME_ID}}\t#{${TMUX_OWNER_INSTANCE}}\t#{${TMUX_TOKEN_HASH}}`;
    const output = await this.run('tmux', ['display-message', '-p', '-t', `=${runtime.tmuxSession}`, format])
      .then(result => result.stdout.trim(), () => '');
    return output === `${runtime.runtimeId}\t${runtime.owner.ownerInstanceId}\t${runtime.tmuxOwnershipTokenHash}`;
  }

  async environmentMatches(
    session: string,
    runtimeId: string,
    owner: OwnerIdentity,
    tokenHash: string,
  ): Promise<boolean> {
    const values = await this.run('tmux', ['show-environment', '-t', `=${session}`])
      .then(result => environment(result.stdout), () => new Map<string, string>());
    return values.get(ENV_RUNTIME_ID) === runtimeId && values.get(ENV_OWNER_INSTANCE) === owner.ownerInstanceId &&
      values.get(ENV_OWNER_PROCESS_NONCE) === owner.ownerProcessNonce && values.get(ENV_TOKEN_HASH) === tokenHash;
  }

  async reassign(runtime: OwnedRuntime, owner: OwnerIdentity): Promise<void> {
    if (!await this.metadataMatches(runtime) || !runtime.tmuxSession) {
      throw Object.assign(new Error('Tmux ownership metadata does not permit handoff.'), { code: 'FENCED' });
    }
    await this.run('tmux', ['set-option', '-t', `=${runtime.tmuxSession}`, TMUX_OWNER_INSTANCE, owner.ownerInstanceId]);
  }

  async killSession(runtime: OwnedRuntime): Promise<boolean> {
    if (!runtime.tmuxSession || !await this.metadataMatches(runtime)) return false;
    await this.run('tmux', ['kill-session', '-t', `=${runtime.tmuxSession}`]);
    return true;
  }

  async sessionExists(session: string): Promise<boolean> {
    return this.run('tmux', ['has-session', '-t', `=${session}`]).then(() => true, () => false);
  }
}
