import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  CONTROL_PROTOCOL_VERSION, NdjsonFrameDecoder, assertWorkerFrame, controlTokenMatches, encodeControlFrame,
  type SupervisorFrame, type SupervisorFramePayload, type WorkerFrame,
} from './control-protocol.ts';
import { defaultProcessController, sameProcess, type ProcessController } from '../process-identity.ts';
import { ensurePrivateTree } from '../storage/atomic.ts';
import { TeamPaths } from '../storage/paths.ts';
import { TeamStore } from '../storage/team-store.ts';
import { RuntimeShutdown, type ShutdownReason, type ShutdownResult, type ShutdownTimings } from './shutdown.ts';
import {
  RuntimeStore, sameOwner, type OwnerIdentity, type OwnedRuntime,
} from './runtime-store.ts';
import { TmuxAdapter, type TmuxLaunchOptions } from './tmux-adapter.ts';
import type { Membership } from '../runtime/membership.ts';

const PROCESS_NONCE = Symbol.for('prjct.pi-team.owner-process-nonce');

type ProcessGlobal = typeof globalThis & { [PROCESS_NONCE]?: string };

export function ownerProcessNonce(): string {
  const shared = globalThis as ProcessGlobal;
  if (!shared[PROCESS_NONCE]) shared[PROCESS_NONCE] = randomBytes(32).toString('hex');
  return shared[PROCESS_NONCE]!;
}

export type SupervisorOptions = {
  readonly teamId: string;
  readonly ownerSessionId: string;
  readonly paths?: TeamPaths;
  readonly teams?: TeamStore;
  readonly runtimes?: RuntimeStore;
  readonly tmux?: TmuxAdapter;
  readonly processes?: ProcessController;
  readonly ownerProcessNonce?: string;
  readonly ownerInstanceId?: string;
  readonly ownerEpoch?: number;
  readonly socketPath?: string;
  readonly heartbeatMs?: number;
  readonly shutdownTimings?: Partial<ShutdownTimings>;
  readonly now?: () => number;
};

export type SupervisorLaunch = {
  readonly memberId: string;
  readonly cwd: string;
  readonly command: readonly [string, ...string[]];
  readonly workerMembership: Membership;
  readonly autoRequests: boolean;
};

export type SupervisorHandoff = {
  readonly teamId: string;
  readonly from: OwnerIdentity;
  readonly to: OwnerIdentity;
  readonly socketPath: string;
  readonly runtimes: readonly {
    readonly record: OwnedRuntime;
    readonly controlToken: string;
    readonly ownershipToken: string;
  }[];
};

export type ReconcileResult = {
  readonly runtimeId: string;
  readonly status: 'owned' | 'lost' | 'foreign' | 'terminated';
};

type SecretSnapshot = SupervisorHandoff['runtimes'][number];

type ControlState = {
  record?: OwnedRuntime;
  readonly runtimeId: string;
  readonly controlToken: string;
  readonly ownershipToken: string;
  socket?: Socket;
  authenticated: boolean;
  lastWorkerSeq: number;
  supervisorSeq: number;
  lastPong: number;
  pendingState?: { readonly state: 'ready' | 'busy'; readonly requestId?: string };
  observedState?: 'ready' | 'busy';
  observedRequestId?: string;
  update: Promise<void>;
};

class ControlHub {
  private server?: Server;
  private inode?: { readonly dev: number; readonly ino: number };
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly states = new Map<string, ControlState>();
  private readonly sockets = new Set<Socket>();
  private started = false;

  constructor(
    readonly socketPath: string,
    private readonly owner: () => OwnerIdentity,
    private readonly now: () => number,
    private readonly heartbeatMs: number,
    private readonly onState: (runtimeId: string, state: 'ready' | 'busy', requestId?: string) => Promise<void>,
    private readonly onLost: (runtimeId: string) => Promise<void>,
  ) {
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) throw new Error('Invalid supervisor heartbeat interval.');
    if (Buffer.byteLength(socketPath, 'utf8') > 100) throw new Error('Supervisor Unix socket path is too long.');
  }

  register(runtimeId: string, controlToken: string, ownershipToken: string, record?: OwnedRuntime): void {
    const existing = this.states.get(runtimeId);
    if (existing) {
      if (controlTokenMatches(existing.controlToken, controlToken) && existing.ownershipToken === ownershipToken) {
        if (record) existing.record = record;
        return;
      }
      throw Object.assign(new Error(`Runtime "${runtimeId}" is already registered.`), { code: 'ALREADY_EXISTS' });
    }
    this.states.set(runtimeId, {
      runtimeId, controlToken, ownershipToken, ...(record ? { record } : {}), authenticated: false,
      lastWorkerSeq: 0, supervisorSeq: 0, lastPong: this.now(), update: Promise.resolve(),
    });
  }

  unregister(runtimeId: string): void {
    const state = this.states.get(runtimeId);
    state?.socket?.destroy();
    this.states.delete(runtimeId);
  }

  setRecord(record: OwnedRuntime): void {
    const state = this.states.get(record.runtimeId);
    if (!state) throw new Error(`Runtime "${record.runtimeId}" is not registered.`);
    state.record = record;
    if (state.pendingState) this.queueState(state, state.pendingState.state, state.pendingState.requestId);
  }

  record(runtimeId: string): OwnedRuntime | undefined { return this.states.get(runtimeId)?.record; }
  has(runtimeId: string): boolean { return this.states.has(runtimeId); }

  updateRecord(record: OwnedRuntime): void {
    const state = this.states.get(record.runtimeId);
    if (state) state.record = record;
  }

  requestMatches(runtimeId: string, requestId: string): boolean {
    const state = this.states.get(runtimeId);
    return !!state && (state.observedState
      ? state.observedRequestId === requestId
      : state.record?.activeRequestId === requestId);
  }

  snapshots(): readonly SecretSnapshot[] {
    return [...this.states.values()].flatMap(state => state.record && state.record.state !== 'terminated' ? [{
      record: state.record,
      controlToken: state.controlToken,
      ownershipToken: state.ownershipToken,
    }] : []);
  }

  private send(state: ControlState, frame: SupervisorFramePayload): boolean {
    if (!state.socket || state.socket.destroyed || !state.authenticated) return false;
    state.supervisorSeq += 1;
    const value = {
      version: CONTROL_PROTOCOL_VERSION,
      runtimeId: state.runtimeId,
      seq: state.supervisorSeq,
      ...frame,
    } as SupervisorFrame;
    state.socket.write(encodeControlFrame(value));
    return true;
  }

  private queueState(state: ControlState, value: 'ready' | 'busy', requestId?: string): void {
    state.observedState = value;
    state.observedRequestId = value === 'busy' ? requestId : undefined;
    state.pendingState = { state: value, ...(requestId ? { requestId } : {}) };
    state.update = state.update.then(async () => {
      if (!state.record || !state.pendingState) return;
      const pending = state.pendingState;
      state.pendingState = undefined;
      await this.onState(state.runtimeId, pending.state, pending.requestId);
    }).catch(() => { state.socket?.destroy(); });
  }

  private accept(state: ControlState, socket: Socket, frame: WorkerFrame): void {
    if (frame.runtimeId !== state.runtimeId || frame.seq <= state.lastWorkerSeq) {
      throw Object.assign(new Error('Worker frame is stale or targets another runtime.'), { code: 'FENCED' });
    }
    state.lastWorkerSeq = frame.seq;
    state.lastPong = this.now();
    if (frame.type === 'hello') return;
    if (!state.authenticated || state.socket !== socket) throw new Error('Unauthenticated worker control frame.');
    if (frame.ownerEpoch !== this.owner().ownerEpoch) {
      throw Object.assign(new Error('Worker frame owner epoch has been fenced.'), { code: 'FENCED' });
    }
    if (frame.type === 'ready') this.queueState(state, 'ready');
    else if (frame.type === 'state') this.queueState(state, frame.state, frame.requestId);
  }

  private connection(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new NdjsonFrameDecoder<WorkerFrame>(assertWorkerFrame);
    const binding: { state?: ControlState } = {};
    socket.on('data', chunk => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (!binding.state) {
            if (frame.type !== 'hello') throw new Error('First worker frame must authenticate.');
            const state = this.states.get(frame.runtimeId);
            if (!state || !controlTokenMatches(state.controlToken, frame.token) ||
                frame.ownerProcessNonce !== this.owner().ownerProcessNonce) {
              throw Object.assign(new Error('Worker control authentication failed.'), { code: 'FENCED' });
            }
            if (state.authenticated && frame.seq <= state.lastWorkerSeq) {
              throw Object.assign(new Error('Worker hello sequence is stale.'), { code: 'FENCED' });
            }
            if (!state.authenticated) state.lastWorkerSeq = 0;
            state.socket?.destroy();
            state.socket = socket;
            state.authenticated = true;
            binding.state = state;
            this.accept(state, socket, frame);
            this.send(state, { type: 'hello_ack', owner: this.owner() });
          } else this.accept(binding.state, socket, frame);
        }
      } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      const state = binding.state;
      if (state?.socket === socket) {
        state.socket = undefined;
        state.authenticated = false;
      }
    });
  }

  private tick(): void {
    const timestamp = this.now();
    for (const state of this.states.values()) {
      if (!state.authenticated) continue;
      if (timestamp - state.lastPong > this.heartbeatMs * 3) {
        state.socket?.destroy();
        void this.onLost(state.runtimeId).catch(() => {});
        continue;
      }
      this.send(state, { type: 'ping', nonce: randomUUID() });
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    const existing = await lstat(this.socketPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw Object.assign(new Error(`Supervisor socket already exists: ${this.socketPath}`), { code: 'ALREADY_EXISTS' });
    const server = createServer(socket => this.connection(socket));
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
    const verifySocket = async (): Promise<{ readonly dev: number; readonly ino: number }> => {
      const opened = await lstat(this.socketPath);
      try {
        if (!opened.isSocket() || opened.isSymbolicLink() || (process.getuid && opened.uid !== process.getuid())) {
          throw Object.assign(new Error('Unsafe supervisor socket.'), { code: 'UNSAFE_STORAGE' });
        }
        await chmod(this.socketPath, 0o600);
        const secured = await lstat(this.socketPath);
        if (!secured.isSocket() || secured.dev !== opened.dev || secured.ino !== opened.ino ||
            (secured.mode & 0o077) !== 0 || (process.getuid && secured.uid !== process.getuid())) {
          throw Object.assign(new Error('Unsafe supervisor socket.'), { code: 'UNSAFE_STORAGE' });
        }
        return { dev: secured.dev, ino: secured.ino };
      } catch (error) {
        const current = await lstat(this.socketPath).catch(() => undefined);
        if (current?.isSocket() && current.dev === opened.dev && current.ino === opened.ino) {
          await unlink(this.socketPath).catch(() => {});
        }
        throw error;
      }
    };
    const inode = await verifySocket().catch(async error => {
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
      throw error;
    });
    this.inode = inode;
    this.server = server;
    this.started = true;
    const timer = setInterval(() => this.tick(), this.heartbeatMs);
    timer.unref();
    this.heartbeat = timer;
  }

  cancel(runtimeId: string, requestId: string): boolean {
    const state = this.states.get(runtimeId);
    return state ? this.send(state, { type: 'cancel_request', requestId }) : false;
  }

  prepareShutdown(runtimeId: string, reason: ShutdownReason, deadlineAt: string): Promise<boolean> {
    const state = this.states.get(runtimeId);
    return Promise.resolve(state ? this.send(state, { type: 'prepare_shutdown', reason, deadlineAt }) : false);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const state of this.states.values()) {
      state.socket = undefined;
      state.authenticated = false;
    }
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    const info = await lstat(this.socketPath).catch(() => undefined);
    if (info && this.inode && info.dev === this.inode.dev && info.ino === this.inode.ino && info.isSocket()) {
      await unlink(this.socketPath);
    }
    this.inode = undefined;
  }
}

function socketName(paths: TeamPaths, teamId: string, ownerSessionId: string, processNonce: string): string {
  const hash = createHash('sha256').update(`${teamId}\0${ownerSessionId}\0${processNonce}`).digest('hex').slice(0, 32);
  return join(paths.control(), `supervisor-${hash}.sock`);
}

export class TeamSupervisor {
  readonly paths: TeamPaths;
  readonly teams: TeamStore;
  readonly runtimes: RuntimeStore;
  readonly tmux: TmuxAdapter;
  private readonly processes: ProcessController;
  private readonly now: () => number;
  private ownerValue: OwnerIdentity;
  private readonly hub: ControlHub;
  private readonly shutdown: RuntimeShutdown;
  private readonly stops = new Map<string, Promise<ShutdownResult>>();
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;
  private handedOff = false;

  constructor(readonly options: SupervisorOptions) {
    this.paths = options.paths ?? new TeamPaths();
    this.teams = options.teams ?? new TeamStore(this.paths);
    this.runtimes = options.runtimes ?? new RuntimeStore(this.paths);
    this.processes = options.processes ?? defaultProcessController;
    this.tmux = options.tmux ?? new TmuxAdapter(undefined, this.processes);
    this.now = options.now ?? Date.now;
    this.ownerValue = {
      ownerSessionId: options.ownerSessionId,
      ownerInstanceId: options.ownerInstanceId ?? randomUUID(),
      ownerProcessNonce: options.ownerProcessNonce ?? ownerProcessNonce(),
      ownerEpoch: options.ownerEpoch ?? 1,
    };
    const controlSocket = options.socketPath ?? socketName(this.paths, options.teamId, options.ownerSessionId, this.ownerValue.ownerProcessNonce);
    this.hub = new ControlHub(
      controlSocket,
      () => this.ownerValue,
      this.now,
      options.heartbeatMs ?? 5_000,
      (runtimeId, state, requestId) => this.acceptState(runtimeId, state, requestId),
      runtimeId => this.handleHeartbeatLoss(runtimeId),
    );
    this.shutdown = new RuntimeShutdown(this.hub, this.tmux, this.processes, { timings: options.shutdownTimings });
  }

  get owner(): OwnerIdentity { return this.ownerValue; }
  get socketPath(): string { return this.hub.socketPath; }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await ensurePrivateTree(this.paths.root, 'teams');
      await ensurePrivateTree(this.paths.root, 'control');
      await this.hub.start();
    })();
    return this.startPromise;
  }

  private current(runtime: OwnedRuntime): boolean {
    return !this.closed && sameOwner(runtime.owner, this.ownerValue);
  }

  private async acceptState(runtimeId: string, state: 'ready' | 'busy', requestId?: string): Promise<void> {
    const record = this.hub.record(runtimeId);
    if (!record || !this.current(record) || ['stopping', 'terminated', 'lost'].includes(record.state)) return;
    const timestamp = new Date(this.now()).toISOString();
    const next = await this.runtimes.update(record.teamId, runtimeId, this.ownerValue, current => {
      const { activeRequestId: _activeRequestId, ...idle } = current;
      return {
        ...idle,
        state,
        ...(state === 'busy' && requestId ? { activeRequestId: requestId } : {}),
        updatedAt: timestamp,
      };
    });
    this.hub.updateRecord(next);
  }

  private async handleHeartbeatLoss(runtimeId: string): Promise<void> {
    await this.markLost(runtimeId);
    await this.stop(runtimeId, 'owner_lost').catch(() => undefined);
  }

  private async markLost(runtimeId: string): Promise<void> {
    const record = this.hub.record(runtimeId);
    if (!record || !this.current(record) || ['stopping', 'terminated', 'lost'].includes(record.state)) return;
    const next = await this.runtimes.update(record.teamId, runtimeId, this.ownerValue, current => {
      const { activeRequestId: _activeRequestId, ...idle } = current;
      return { ...idle, state: 'lost', updatedAt: new Date(this.now()).toISOString() };
    });
    this.hub.updateRecord(next);
  }

  async launch(input: SupervisorLaunch): Promise<OwnedRuntime> {
    await this.start();
    if (this.closed || this.handedOff) throw Object.assign(new Error('Supervisor does not accept launches.'), { code: 'SUPERVISOR_CLOSED' });
    const [team, member] = await Promise.all([
      this.teams.read(this.options.teamId),
      this.teams.readMember(this.options.teamId, input.memberId),
    ]);
    if (!team || team.state !== 'open') throw Object.assign(new Error('Team is not open for supervised launches.'), { code: 'TEAM_CLOSED' });
    if (!member || member.state !== 'active' || member.kind !== 'supervised') {
      throw Object.assign(new Error('Only an active supervised member may be launched.'), { code: 'FENCED' });
    }
    if (!await this.tmux.available()) throw new Error('Supervised peers require tmux.');
    const runtimeId = randomUUID();
    const controlToken = randomBytes(32).toString('hex');
    const ownershipToken = randomBytes(32).toString('hex');
    this.hub.register(runtimeId, controlToken, ownershipToken);
    const launch: TmuxLaunchOptions = {
      runtimeId,
      owner: this.ownerValue,
      cwd: input.cwd,
      command: input.command,
      controlSocket: this.socketPath,
      controlToken,
      ownershipToken,
      workerMembership: input.workerMembership,
      autoRequests: input.autoRequests,
    };
    const process = await this.tmux.launch(launch).catch(error => {
      this.hub.unregister(runtimeId);
      throw error;
    });
    const timestamp = new Date(this.now()).toISOString();
    const runtime: OwnedRuntime = {
      schemaVersion: 2,
      runtimeId,
      teamId: this.options.teamId,
      memberId: input.memberId,
      owner: this.ownerValue,
      processPid: process.identity.processPid,
      processStartToken: process.identity.processStartToken,
      processGroupId: process.identity.processGroupId,
      tmuxSession: process.session,
      tmuxOwnershipTokenHash: process.ownershipTokenHash,
      cwd: input.cwd,
      state: 'starting',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await this.runtimes.create(runtime);
      this.hub.setRecord(runtime);
      return runtime;
    } catch (error) {
      this.hub.setRecord(runtime);
      const stopped = await this.shutdown.stop(runtime, 'stop').catch(() => ({
        runtimeId,
        status: 'blocked' as const,
        phase: 'blocked' as const,
      }));
      if (stopped.status === 'terminated') this.hub.unregister(runtimeId);
      if (stopped.status === 'blocked') {
        throw Object.assign(new Error(`Runtime launch storage failed and cleanup was blocked: ${(error as Error).message}`), {
          code: 'CLEANUP_BLOCKED', cause: error,
        });
      }
      throw error;
    }
  }

  cancelRequest(runtimeId: string, requestId: string): boolean {
    const record = this.hub.record(runtimeId);
    return !!record && this.current(record) && !['stopping', 'lost', 'terminated'].includes(record.state) &&
      this.hub.requestMatches(runtimeId, requestId) && this.hub.cancel(runtimeId, requestId);
  }

  stop(runtimeId: string, reason: ShutdownReason = 'stop'): Promise<ShutdownResult> {
    const existing = this.stops.get(runtimeId);
    if (existing) return existing;
    const operation = this.stopInner(runtimeId, reason).finally(() => { this.stops.delete(runtimeId); });
    this.stops.set(runtimeId, operation);
    return operation;
  }

  private async stopInner(runtimeId: string, reason: ShutdownReason): Promise<ShutdownResult> {
    const stored = await this.runtimes.read(this.options.teamId, runtimeId);
    if (!stored) throw Object.assign(new Error(`Unknown owned runtime "${runtimeId}".`), { code: 'NOT_FOUND' });
    if (!sameOwner(stored.owner, this.ownerValue)) throw Object.assign(new Error('Runtime belongs to another owner.'), { code: 'FENCED' });
    if (stored.state === 'terminated') return { runtimeId, status: 'terminated', phase: 'terminated' };
    if (stored.activeRequestId) this.hub.cancel(runtimeId, stored.activeRequestId);
    const stopping = stored.state === 'stopping' ? stored : await this.runtimes.update(stored.teamId, runtimeId, this.ownerValue, current => {
      const { activeRequestId: _activeRequestId, ...idle } = current;
      return { ...idle, state: 'stopping', updatedAt: new Date(this.now()).toISOString() };
    });
    this.hub.updateRecord(stopping);
    const result = await this.shutdown.stop(stopping, reason);
    const final = await this.runtimes.update(stopping.teamId, runtimeId, this.ownerValue, current => {
      const { activeRequestId: _activeRequestId, ...idle } = current;
      return {
        ...idle,
        state: result.status === 'terminated' ? 'terminated' : 'lost',
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
    this.hub.updateRecord(final);
    return result;
  }

  async stopAll(reason: ShutdownReason = 'close'): Promise<readonly ShutdownResult[]> {
    const records = (await this.runtimes.list(this.options.teamId))
      .filter(runtime => sameOwner(runtime.owner, this.ownerValue) && runtime.state !== 'terminated');
    const settled = await Promise.allSettled(records.map(runtime => this.stop(runtime.runtimeId, reason)));
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'One or more supervised runtimes failed to stop.');
    return settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  }

  async reconcile(): Promise<readonly ReconcileResult[]> {
    await this.start();
    const records = await this.runtimes.list(this.options.teamId);
    const outcomes = await Promise.all(records.map(async runtime => {
      const current = runtime;
      if (current.state === 'terminated') return { runtimeId: runtime.runtimeId, status: 'terminated' as const };
      if (!sameOwner(current.owner, this.ownerValue)) return { runtimeId: runtime.runtimeId, status: 'foreign' as const };
      const expected = {
        processPid: current.processPid,
        processStartToken: current.processStartToken,
        processGroupId: current.processGroupId ?? current.processPid,
      };
      const alive = sameProcess(expected, await this.processes.inspect(expected.processPid));
      const metadata = alive ? await this.tmux.metadataMatches(current) : false;
      if (alive && metadata && this.hub.has(runtime.runtimeId)) {
        return { runtimeId: runtime.runtimeId, status: 'owned' as const };
      }
      await this.markLost(runtime.runtimeId);
      const stopped = await this.stop(runtime.runtimeId, 'owner_lost');
      return { runtimeId: runtime.runtimeId, status: stopped.status === 'terminated' ? 'terminated' as const : 'lost' as const };
    }));
    return outcomes;
  }

  async prepareHandoff(): Promise<SupervisorHandoff> {
    await this.start();
    if (this.closed || this.handedOff) throw new Error('Supervisor cannot hand off twice.');
    const to: OwnerIdentity = {
      ...this.ownerValue,
      ownerInstanceId: randomUUID(),
      ownerEpoch: this.ownerValue.ownerEpoch + 1,
    };
    const handoff: SupervisorHandoff = {
      teamId: this.options.teamId,
      from: this.ownerValue,
      to,
      socketPath: this.socketPath,
      runtimes: this.hub.snapshots(),
    };
    await this.hub.stop();
    this.handedOff = true;
    this.closed = true;
    return handoff;
  }

  async adopt(handoff: SupervisorHandoff): Promise<void> {
    if (handoff.teamId !== this.options.teamId || !sameOwner(handoff.to, this.ownerValue) ||
        handoff.from.ownerSessionId !== this.ownerValue.ownerSessionId ||
        handoff.from.ownerProcessNonce !== this.ownerValue.ownerProcessNonce || handoff.socketPath !== this.socketPath) {
      throw Object.assign(new Error('Supervisor handoff does not match this owner process and session.'), { code: 'FENCED' });
    }
    for (const item of handoff.runtimes) {
      const stored = await this.runtimes.read(item.record.teamId, item.record.runtimeId);
      if (!stored) throw Object.assign(new Error(`Missing handoff runtime "${item.record.runtimeId}".`), { code: 'NOT_FOUND' });
      const targetRecord = { ...stored, owner: handoff.to };
      const record = sameOwner(stored.owner, handoff.to) ? stored : await (async () => {
        if (!sameOwner(stored.owner, handoff.from)) {
          throw Object.assign(new Error('Stored runtime owner changed during handoff.'), { code: 'FENCED' });
        }
        if (await this.tmux.metadataMatches(stored)) await this.tmux.reassign(stored, handoff.to);
        else if (!await this.tmux.metadataMatches(targetRecord)) {
          throw Object.assign(new Error('Tmux metadata changed during handoff.'), { code: 'FENCED' });
        }
        return this.runtimes.handoff(
          item.record.teamId, item.record.runtimeId, handoff.from, handoff.to, new Date(this.now()).toISOString(),
        );
      })();
      if (!await this.tmux.metadataMatches(record)) {
        throw Object.assign(new Error('Adopted tmux metadata does not match the new owner.'), { code: 'FENCED' });
      }
      this.hub.register(record.runtimeId, item.controlToken, item.ownershipToken, record);
    }
    await this.start();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const cleanup = (async () => {
      try {
        if (!this.handedOff) {
          const outcomes = await this.stopAll('close');
          const blocked = outcomes.filter(outcome => outcome.status === 'blocked');
          if (blocked.length > 0) {
            throw new Error(`Supervisor shutdown blocked for ${blocked.length} runtime(s).`);
          }
        }
      } finally { await this.hub.stop(); }
    })();
    this.closePromise = cleanup.catch(error => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
}
