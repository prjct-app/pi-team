import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { Member } from '../src/domain/member.ts';
import type { Team } from '../src/domain/team.ts';
import type { ProcessController, ProcessIdentity } from '../src/process-identity.ts';
import { TeamSupervisor, type SupervisorLaunch, type SupervisorOptions } from '../src/supervisor/supervisor.ts';
import type { OwnerIdentity, OwnedRuntime } from '../src/supervisor/runtime-store.ts';
import { RuntimeStore } from '../src/supervisor/runtime-store.ts';
import { TmuxAdapter, type TmuxCommand, type TmuxLaunchOptions } from '../src/supervisor/tmux-adapter.ts';
import { WorkerClient } from '../src/supervisor/worker-client.ts';
import { TeamPaths } from '../src/storage/paths.ts';
import { TeamStore } from '../src/storage/team-store.ts';

const BASE = Date.parse('2026-03-01T00:00:00.000Z');

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for supervisor behavior.');
    await new Promise(resolve => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

class FakeProcesses implements ProcessController {
  readonly signals: NodeJS.Signals[] = [];
  identity: ProcessIdentity | undefined = { processPid: 43210, processStartToken: 'start-1', processGroupId: 43210 };
  terminateOn?: NodeJS.Signals;

  inspect = async (): Promise<ProcessIdentity | undefined> => this.identity;

  signal = async (_identity: ProcessIdentity, signal: NodeJS.Signals): Promise<boolean> => {
    this.signals.push(signal);
    if (this.terminateOn === signal) this.identity = undefined;
    return true;
  };

  delay = async (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
}

class FakeTmux {
  launchOptions?: TmuxLaunchOptions;
  metadata = true;
  killed = 0;
  reassignments: OwnerIdentity[] = [];
  identity: ProcessIdentity = { processPid: 43210, processStartToken: 'start-1', processGroupId: 43210 };

  available = async (): Promise<boolean> => true;
  launch = async (options: TmuxLaunchOptions) => {
    this.launchOptions = options;
    return {
      session: `session-${options.runtimeId}`,
      identity: this.identity,
      ownershipTokenHash: randomBytes(32).toString('hex'),
    };
  };
  metadataMatches = async (): Promise<boolean> => this.metadata;
  killSession = async (): Promise<boolean> => { this.killed += 1; return this.metadata; };
  reassign = async (_runtime: OwnedRuntime, owner: OwnerIdentity): Promise<void> => { this.reassignments.push(owner); };
}

type Fixture = {
  readonly paths: TeamPaths;
  readonly teams: TeamStore;
  readonly runtimes: RuntimeStore;
  readonly processes: FakeProcesses;
  readonly tmux: FakeTmux;
  readonly socketPath: string;
  readonly options: SupervisorOptions;
};

async function setup(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-supervisor-'));
  const socketPath = join(tmpdir(), `pts-${randomUUID().slice(0, 12)}.sock`);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(socketPath, { force: true }));
  const paths = new TeamPaths(root);
  const teams = new TeamStore(paths);
  const runtimes = new RuntimeStore(paths);
  const processes = new FakeProcesses();
  const tmux = new FakeTmux();
  const timestamp = new Date(BASE).toISOString();
  const team: Team = { schemaVersion: 2, teamId: 'shop', state: 'open', createdAt: timestamp, updatedAt: timestamp };
  const member: Member = {
    schemaVersion: 2,
    teamId: 'shop',
    memberId: 'backend-1',
    sessionId: 'backend-session',
    alias: 'backend',
    kind: 'supervised',
    generation: 1,
    state: 'active',
    cwd: '/repo/backend',
    joinedAt: timestamp,
    updatedAt: timestamp,
  };
  await teams.create(team);
  await teams.createMember(member);
  return {
    paths,
    teams,
    runtimes,
    processes,
    tmux,
    socketPath,
    options: {
      teamId: 'shop',
      ownerSessionId: 'owner-session',
      ownerProcessNonce: 'a'.repeat(64),
      paths,
      teams,
      runtimes,
      processes,
      tmux: tmux as unknown as TmuxAdapter,
      socketPath,
      shutdownTimings: { gracefulMs: 0, termMs: 0, killMs: 0, pollMs: 1 },
      now: () => BASE,
      heartbeatMs: 25,
    },
  };
}

function launchInput(
  memberId = 'backend-1',
  cwd = '/repo/backend',
  command: readonly [string, ...string[]] = ['pi'],
): SupervisorLaunch {
  return {
    memberId,
    cwd,
    command,
    workerMembership: {
      teamId: 'shop',
      memberId,
      memberGeneration: 1,
      leaseToken: 'a'.repeat(64),
      leaseGeneration: 1,
      alias: memberId === 'external-1' ? 'external' : 'backend',
      sessionId: `${memberId}-session`,
      cwd,
      kind: 'supervised',
    },
    autoRequests: true,
  };
}

function workerFromLaunch(
  launch: TmuxLaunchOptions,
  hooks: { abort(requestId: string): void; shutdown(reason: 'stop' | 'close' | 'reload_failed' | 'owner_lost'): void },
  options: { orphanMs?: number; reconnectMs?: number } = {},
): WorkerClient {
  return new WorkerClient({
    socketPath: launch.controlSocket,
    runtimeId: launch.runtimeId,
    controlToken: launch.controlToken,
    ownerProcessNonce: launch.owner.ownerProcessNonce,
    hooks,
    orphanMs: options.orphanMs ?? 500,
    reconnectMs: options.reconnectMs ?? 10,
  });
}

test('supervisor authenticates a worker, tracks requests, cancels exactly one request, and stops idempotently', async (t) => {
  const fixture = await setup(t);
  const supervisor = new TeamSupervisor({
    ...fixture.options,
    shutdownTimings: { gracefulMs: 100, termMs: 0, killMs: 0, pollMs: 10 },
  });
  t.after(() => supervisor.close());
  const runtime = await supervisor.launch(launchInput('backend-1', '/repo/backend', ['pi', '--no-extensions']));
  const aborted: string[] = [];
  const shutdown: string[] = [];
  const worker = workerFromLaunch(fixture.tmux.launchOptions!, {
    abort(requestId) { aborted.push(requestId); },
    shutdown(reason) { shutdown.push(reason); fixture.processes.identity = undefined; },
  });
  t.after(() => worker.stop());
  await worker.start();
  await until(async () => (await fixture.runtimes.read('shop', runtime.runtimeId))?.state === 'ready');

  worker.busy('request-1');
  await until(async () => (await fixture.runtimes.read('shop', runtime.runtimeId))?.activeRequestId === 'request-1');
  assert.equal(supervisor.cancelRequest(runtime.runtimeId, 'other-request'), false);
  assert.equal(supervisor.cancelRequest(runtime.runtimeId, 'request-1'), true);
  await until(() => aborted.length === 1);
  assert.deepEqual(aborted, ['request-1']);

  const first = await supervisor.stop(runtime.runtimeId);
  const second = await supervisor.stop(runtime.runtimeId);
  assert.equal(first.status, 'terminated');
  assert.equal(second.status, 'terminated');
  assert.deepEqual(shutdown, ['stop']);
  assert.equal(fixture.tmux.killed, 1);
  assert.equal((await fixture.runtimes.read('shop', runtime.runtimeId))?.state, 'terminated');
  await supervisor.close();
});

test('external members are never launched or terminated by the supervisor', async (t) => {
  const fixture = await setup(t);
  const timestamp = new Date(BASE).toISOString();
  await fixture.teams.createMember({
    schemaVersion: 2,
    teamId: 'shop',
    memberId: 'external-1',
    sessionId: 'external-session',
    alias: 'external',
    kind: 'external',
    generation: 1,
    state: 'active',
    cwd: '/repo/external',
    joinedAt: timestamp,
    updatedAt: timestamp,
  });
  const supervisor = new TeamSupervisor(fixture.options);
  await assert.rejects(supervisor.launch(launchInput('external-1', '/repo/external')),
    (error: unknown) => (error as { code?: string }).code === 'FENCED');
  assert.equal(fixture.tmux.launchOptions, undefined);
  assert.deepEqual(fixture.processes.signals, []);
  await supervisor.close();
});

test('shutdown escalates TERM to KILL and refuses signals after tmux ownership changes', async (t) => {
  const fixture = await setup(t);
  fixture.processes.terminateOn = 'SIGKILL';
  const supervisor = new TeamSupervisor(fixture.options);
  const runtime = await supervisor.launch(launchInput());
  const stopped = await supervisor.stop(runtime.runtimeId);
  assert.equal(stopped.status, 'terminated');
  assert.deepEqual(fixture.processes.signals, ['SIGTERM', 'SIGKILL']);
  await supervisor.close();

  const blockedFixture = await setup(t);
  blockedFixture.tmux.metadata = false;
  const blockedSupervisor = new TeamSupervisor(blockedFixture.options);
  const blockedRuntime = await blockedSupervisor.launch(launchInput());
  const blocked = await blockedSupervisor.stop(blockedRuntime.runtimeId);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blockedFixture.processes.signals, []);
  assert.equal((await blockedFixture.runtimes.read('shop', blockedRuntime.runtimeId))?.state, 'lost');
  await assert.rejects(blockedSupervisor.close(), /shutdown blocked/);
});

test('PID reuse is treated as original-process exit and is never signalled', async (t) => {
  const fixture = await setup(t);
  const supervisor = new TeamSupervisor(fixture.options);
  const runtime = await supervisor.launch(launchInput());
  fixture.processes.identity = { processPid: runtime.processPid, processStartToken: 'reused', processGroupId: runtime.processGroupId! };
  const stopped = await supervisor.stop(runtime.runtimeId);
  assert.equal(stopped.status, 'terminated');
  assert.deepEqual(fixture.processes.signals, []);
  await supervisor.close();
});

test('reconciliation keeps verified owned runtimes and blocks cleanup after metadata changes', async (t) => {
  const fixture = await setup(t);
  const supervisor = new TeamSupervisor(fixture.options);
  const runtime = await supervisor.launch(launchInput());
  assert.deepEqual(await supervisor.reconcile(), [{ runtimeId: runtime.runtimeId, status: 'owned' }]);
  assert.equal((await fixture.runtimes.read('shop', runtime.runtimeId))?.owner.ownerEpoch, supervisor.owner.ownerEpoch);
  fixture.tmux.metadata = false;
  assert.deepEqual(await supervisor.reconcile(), [{ runtimeId: runtime.runtimeId, status: 'lost' }]);
  assert.deepEqual(fixture.processes.signals, []);
  await assert.rejects(supervisor.close(), /shutdown blocked/);
});

test('reload handoff works only inside the same owner process and does not stop workers', async (t) => {
  const fixture = await setup(t);
  const original = new TeamSupervisor(fixture.options);
  const runtime = await original.launch(launchInput());
  const shutdown: string[] = [];
  const worker = workerFromLaunch(fixture.tmux.launchOptions!, {
    abort() {},
    shutdown(reason) { shutdown.push(reason); fixture.processes.identity = undefined; },
  }, { orphanMs: 1_000 });
  t.after(() => worker.stop());
  await worker.start();
  const handoff = await original.prepareHandoff();
  const replacement = new TeamSupervisor({
    ...fixture.options,
    ownerInstanceId: handoff.to.ownerInstanceId,
    ownerEpoch: handoff.to.ownerEpoch,
  });
  await replacement.adopt(handoff);
  await until(async () => (await fixture.runtimes.read('shop', runtime.runtimeId))?.owner.ownerInstanceId === handoff.to.ownerInstanceId);
  assert.equal(shutdown.length, 0);
  assert.equal(fixture.tmux.reassignments.length, 1);
  worker.busy('handoff-request');
  await until(async () => (await fixture.runtimes.read('shop', runtime.runtimeId))?.activeRequestId === 'handoff-request');
  worker.ready();
  await until(async () => (await fixture.runtimes.read('shop', runtime.runtimeId))?.state === 'ready');

  const foreign = new TeamSupervisor({
    ...fixture.options,
    ownerProcessNonce: 'b'.repeat(64),
    ownerInstanceId: handoff.to.ownerInstanceId,
    ownerEpoch: handoff.to.ownerEpoch,
    socketPath: join(tmpdir(), `pts-${randomUUID().slice(0, 12)}.sock`),
  });
  await assert.rejects(foreign.adopt(handoff), (error: unknown) => (error as { code?: string }).code === 'FENCED');
  await foreign.close();

  fixture.processes.terminateOn = 'SIGTERM';
  await replacement.close();
  assert.deepEqual(shutdown, ['close']);
  await original.close();
});

test('a supervised worker extension can reconnect with a fresh frame sequence after reload', async (t) => {
  const fixture = await setup(t);
  const supervisor = new TeamSupervisor(fixture.options);
  const runtime = await supervisor.launch(launchInput());
  const hooks = { abort() {}, shutdown() {} };
  const first = workerFromLaunch(fixture.tmux.launchOptions!, hooks);
  await first.start();
  await until(async () => (await fixture.runtimes.read('shop', runtime.runtimeId))?.state === 'ready');
  first.stop();
  const replacement = workerFromLaunch(fixture.tmux.launchOptions!, hooks);
  t.after(() => replacement.stop());
  await replacement.start();
  replacement.busy('reload-request');
  await until(async () => (await fixture.runtimes.read('shop', runtime.runtimeId))?.activeRequestId === 'reload-request');
  fixture.processes.identity = undefined;
  await supervisor.close();
});

test('a worker watchdog shuts down after reload handoff is abandoned even when request abort fails', async (t) => {
  const fixture = await setup(t);
  const supervisor = new TeamSupervisor(fixture.options);
  await supervisor.launch(launchInput());
  const shutdown: string[] = [];
  const worker = workerFromLaunch(fixture.tmux.launchOptions!, {
    abort() { throw new Error('abort failed'); },
    shutdown(reason) { shutdown.push(reason); },
  }, { orphanMs: 60, reconnectMs: 5 });
  t.after(() => worker.stop());
  await worker.start();
  worker.busy('orphaned-request');
  await supervisor.prepareHandoff();
  await until(() => shutdown.length === 1);
  assert.deepEqual(shutdown, ['owner_lost']);
  await supervisor.close();
});

test('transport reconnects without authentication cannot postpone the worker orphan deadline', async (t) => {
  const socketPath = join(tmpdir(), `pts-hostile-${randomUUID().slice(0, 12)}.sock`);
  t.after(() => rm(socketPath, { force: true }));
  const server = createServer(socket => setTimeout(() => socket.destroy(), 2));
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolvePromise);
  });
  t.after(() => new Promise<void>(resolvePromise => server.close(() => resolvePromise())));
  const shutdown: string[] = [];
  const worker = new WorkerClient({
    socketPath,
    runtimeId: 'runtime-hostile',
    controlToken: 'a'.repeat(64),
    ownerProcessNonce: 'b'.repeat(64),
    hooks: { abort() {}, shutdown(reason) { shutdown.push(reason); } },
    orphanMs: 60,
    reconnectMs: 5,
  });
  t.after(() => worker.stop());
  await assert.rejects(worker.start(), /before authentication/);
  assert.deepEqual(shutdown, ['owner_lost']);
});

test('unauthenticated control sockets cannot block supervisor close', async (t) => {
  const fixture = await setup(t);
  const supervisor = new TeamSupervisor(fixture.options);
  await supervisor.start();
  const idle = createConnection({ path: fixture.socketPath });
  t.after(() => idle.destroy());
  await new Promise<void>((resolvePromise, reject) => {
    idle.once('connect', resolvePromise);
    idle.once('error', reject);
  });
  await Promise.race([
    supervisor.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('close hung on unauthenticated socket')), 500)),
  ]);
});

test('close always removes the control socket after a runtime-store failure', async (t) => {
  const fixture = await setup(t);
  const supervisor = new TeamSupervisor(fixture.options);
  await supervisor.start();
  fixture.runtimes.list = async () => { throw new Error('storage failed'); };
  await assert.rejects(supervisor.close(), /storage failed/);
  await assert.rejects(lstat(fixture.socketPath), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('terminated runtimes are excluded from reload handoff', async (t) => {
  const fixture = await setup(t);
  fixture.processes.terminateOn = 'SIGTERM';
  const supervisor = new TeamSupervisor(fixture.options);
  const runtime = await supervisor.launch(launchInput());
  assert.equal((await supervisor.stop(runtime.runtimeId)).status, 'terminated');
  const handoff = await supervisor.prepareHandoff();
  assert.deepEqual(handoff.runtimes, []);
  const replacement = new TeamSupervisor({
    ...fixture.options,
    ownerInstanceId: handoff.to.ownerInstanceId,
    ownerEpoch: handoff.to.ownerEpoch,
  });
  await replacement.adopt(handoff);
  await replacement.close();
  await supervisor.close();
});

test('tmux adapter marks ownership and refuses to kill after metadata tampering', async () => {
  const metadata = new Map<string, string>();
  const recorded: string[][] = [];
  const identity: ProcessIdentity = { processPid: 7000, processStartToken: 'tmux-start', processGroupId: 7000 };
  const processes: ProcessController = {
    inspect: async () => identity,
    signal: async () => true,
    delay: async () => {},
  };
  const run: TmuxCommand = async (_program, args) => {
    recorded.push([...args]);
    if (args[0] === 'set-option') { metadata.set(args[3]!, args[4]!); return { stdout: '', stderr: '' }; }
    if (args.includes('#{pane_pid}')) return { stdout: '7000\n', stderr: '' };
    if (args[0] === 'display-message') {
      return {
        stdout: `${metadata.get('@pi-team-runtime-id') ?? ''}\t${metadata.get('@pi-team-owner-instance') ?? ''}\t${metadata.get('@pi-team-token-hash') ?? ''}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'show-environment') return { stdout: '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const adapter = new TmuxAdapter(run, processes);
  const owner: OwnerIdentity = {
    ownerSessionId: 'owner-session', ownerInstanceId: 'owner-instance', ownerProcessNonce: 'f'.repeat(64), ownerEpoch: 1,
  };
  const launched = await adapter.launch({
    runtimeId: 'runtime-tmux', owner, cwd: '/repo/backend', command: ['pi'], controlSocket: '/tmp/control.sock',
    controlToken: 'a'.repeat(64), ownershipToken: 'b'.repeat(64),
    workerMembership: launchInput().workerMembership, autoRequests: true,
  });
  const runtime: OwnedRuntime = {
    schemaVersion: 2, runtimeId: 'runtime-tmux', teamId: 'shop', memberId: 'backend-1', owner,
    processPid: identity.processPid, processStartToken: identity.processStartToken, processGroupId: identity.processGroupId,
    tmuxSession: launched.session, tmuxOwnershipTokenHash: launched.ownershipTokenHash, cwd: '/repo/backend', state: 'ready',
    createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString(),
  };
  assert.equal(await adapter.metadataMatches(runtime), true);
  metadata.set('@pi-team-owner-instance', 'tampered');
  assert.equal(await adapter.killSession(runtime), false);
  assert.equal(recorded.some(args => args[0] === 'kill-session'), false);
});

test('tmux launch cleans a partially marked session only with matching environment evidence', async () => {
  const calls: string[][] = [];
  const owner: OwnerIdentity = {
    ownerSessionId: 'owner-session', ownerInstanceId: 'owner-instance', ownerProcessNonce: 'f'.repeat(64), ownerEpoch: 1,
  };
  const tokenHash = createHash('sha256').update('b'.repeat(64)).digest('hex');
  const run: TmuxCommand = async (_program, args) => {
    calls.push([...args]);
    if (args[0] === 'set-option' && args[3] === '@pi-team-owner-instance') throw new Error('metadata write failed');
    if (args[0] === 'show-environment') return {
      stdout: `PI_TEAM_RUNTIME_ID=runtime-partial\nPI_TEAM_OWNER_INSTANCE=${owner.ownerInstanceId}\nPI_TEAM_OWNER_PROCESS_NONCE=${owner.ownerProcessNonce}\nPI_TEAM_TOKEN_HASH=${tokenHash}\n`,
      stderr: '',
    };
    return { stdout: '', stderr: '' };
  };
  const adapter = new TmuxAdapter(run, new FakeProcesses());
  await assert.rejects(adapter.launch({
    runtimeId: 'runtime-partial', owner, cwd: '/repo/backend', command: ['pi'], controlSocket: '/tmp/control.sock',
    controlToken: 'a'.repeat(64), ownershipToken: 'b'.repeat(64),
    workerMembership: launchInput().workerMembership, autoRequests: true,
  }), /metadata write failed/);
  assert.equal(calls.some(args => args[0] === 'kill-session'), true);
});

test('runtime storage preserves corruption and rejects symlinked records', async (t) => {
  const fixture = await setup(t);
  await mkdir(fixture.paths.runtimes('shop'), { recursive: true, mode: 0o700 });
  const corruptPath = fixture.paths.runtime('shop', 'corrupt-runtime');
  await writeFile(corruptPath, '{not-json', { mode: 0o600 });
  await assert.rejects(fixture.runtimes.read('shop', 'corrupt-runtime'));
  assert.equal(await readFile(corruptPath, 'utf8'), '{not-json');

  const target = join(fixture.paths.root, 'runtime-target.json');
  await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, fixture.paths.runtime('shop', 'linked-runtime'));
  await assert.rejects(fixture.runtimes.read('shop', 'linked-runtime'), (error: unknown) =>
    ['ELOOP', 'UNSAFE_STORAGE'].includes((error as { code?: string }).code ?? ''));
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('runtime records fence owners and permit only same-process handoff', async (t) => {
  const fixture = await setup(t);
  const owner: OwnerIdentity = {
    ownerSessionId: 'owner-session', ownerInstanceId: 'instance-1', ownerProcessNonce: 'c'.repeat(64), ownerEpoch: 1,
  };
  const runtime: OwnedRuntime = {
    schemaVersion: 2,
    runtimeId: 'runtime-1',
    teamId: 'shop',
    memberId: 'backend-1',
    owner,
    processPid: 5000,
    processStartToken: 'start',
    processGroupId: 5000,
    tmuxSession: 'tmux-runtime-1',
    tmuxOwnershipTokenHash: 'd'.repeat(64),
    cwd: '/repo/backend',
    state: 'starting',
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
  };
  await fixture.runtimes.create(runtime);
  await assert.rejects(fixture.runtimes.update('shop', 'runtime-1', { ...owner, ownerEpoch: 2 }, current => current),
    (error: unknown) => (error as { code?: string }).code === 'FENCED');
  const next = { ...owner, ownerInstanceId: 'instance-2', ownerEpoch: 2 };
  const handed = await fixture.runtimes.handoff('shop', 'runtime-1', owner, next, new Date(BASE + 1).toISOString());
  assert.deepEqual(handed.owner, next);
  await assert.rejects(fixture.runtimes.handoff(
    'shop', 'runtime-1', next, { ...next, ownerInstanceId: 'instance-3', ownerProcessNonce: 'e'.repeat(64), ownerEpoch: 3 },
    new Date(BASE + 2).toISOString(),
  ), (error: unknown) => (error as { code?: string }).code === 'FENCED');
});
