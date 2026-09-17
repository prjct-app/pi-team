import { createConnection, type Socket } from 'node:net';
import {
  CONTROL_PROTOCOL_VERSION, NdjsonFrameDecoder, assertSupervisorFrame, encodeControlFrame,
  type SupervisorFrame, type WorkerFrame, type WorkerFramePayload,
} from './control-protocol.ts';

export type WorkerHooks = {
  readonly abort: (requestId: string) => Promise<void> | void;
  readonly shutdown: (reason: 'stop' | 'close' | 'reload_failed' | 'owner_lost') => Promise<void> | void;
};

export type WorkerClientOptions = {
  readonly socketPath: string;
  readonly runtimeId: string;
  readonly controlToken: string;
  readonly ownerProcessNonce: string;
  readonly hooks: WorkerHooks;
  readonly orphanMs?: number;
  readonly reconnectMs?: number;
  readonly now?: () => number;
};

export class WorkerClient {
  private socket?: Socket;
  private sequence = 0;
  private activeRequestId?: string;
  private authenticated = false;
  private ownerEpoch?: number;
  private stopped = false;
  private orphaned = false;
  private lastContact: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdogTimer?: ReturnType<typeof setTimeout>;
  private startPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (error: Error) => void;
  private readonly orphanMs: number;
  private readonly reconnectMs: number;
  private readonly now: () => number;

  constructor(private readonly options: WorkerClientOptions) {
    this.orphanMs = options.orphanMs ?? 15_000;
    this.reconnectMs = options.reconnectMs ?? 250;
    this.now = options.now ?? Date.now;
    this.lastContact = this.now();
    if (!Number.isFinite(this.orphanMs) || this.orphanMs <= 0 || !Number.isFinite(this.reconnectMs) || this.reconnectMs <= 0) {
      throw new Error('Invalid worker watchdog timing.');
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private send(frame: WorkerFramePayload): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    const value = {
      version: CONTROL_PROTOCOL_VERSION,
      runtimeId: this.options.runtimeId,
      seq: this.nextSequence(),
      ...(frame.type === 'hello' ? {} : { ownerEpoch: this.ownerEpoch }),
      ...frame,
    } as WorkerFrame;
    this.socket.write(encodeControlFrame(value));
    return true;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.reconnectMs);
    timer.unref();
    this.reconnectTimer = timer;
  }

  private scheduleWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    if (this.stopped) return;
    const remaining = Math.max(0, this.orphanMs - (this.now() - this.lastContact));
    const timer = setTimeout(() => { void this.checkWatchdog().catch(() => {}); }, remaining);
    timer.unref();
    this.watchdogTimer = timer;
  }

  private async checkWatchdog(): Promise<void> {
    if (this.stopped || this.now() - this.lastContact < this.orphanMs) {
      this.scheduleWatchdog();
      return;
    }
    if (this.orphaned) return;
    this.orphaned = true;
    const requestId = this.activeRequestId;
    this.activeRequestId = undefined;
    try {
      if (requestId) {
        try { await this.options.hooks.abort(requestId); } catch {}
      }
      await this.options.hooks.shutdown('owner_lost');
    } finally { this.stop(); }
  }

  private accept(frame: SupervisorFrame): void {
    if (frame.runtimeId !== this.options.runtimeId) throw new Error('Supervisor frame targets another runtime.');
    if (frame.type === 'hello_ack') {
      if (frame.owner.ownerProcessNonce !== this.options.ownerProcessNonce) {
        throw Object.assign(new Error('Supervisor process nonce does not match the worker owner.'), { code: 'FENCED' });
      }
      this.authenticated = true;
      this.ownerEpoch = frame.owner.ownerEpoch;
      this.lastContact = this.now();
      this.scheduleWatchdog();
      this.startResolve?.();
      this.startResolve = undefined;
      this.startReject = undefined;
      if (this.activeRequestId) this.send({ type: 'state', state: 'busy', requestId: this.activeRequestId });
      else this.send({ type: 'ready' });
      return;
    }
    if (!this.authenticated) throw new Error('Supervisor sent a frame before authentication.');
    this.lastContact = this.now();
    this.scheduleWatchdog();
    if (frame.type === 'ping') {
      this.send({ type: 'pong', nonce: frame.nonce });
      return;
    }
    if (frame.type === 'cancel_request') {
      if (this.activeRequestId === frame.requestId) void (async () => {
        try { await this.options.hooks.abort(frame.requestId); } catch {}
      })();
      return;
    }
    if (frame.type === 'prepare_shutdown') {
      void this.prepareShutdown(frame.reason).catch(() => {});
    }
  }

  private prepareShutdown(reason: 'stop' | 'close' | 'reload_failed' | 'owner_lost'): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const cleanup = (async () => {
      const requestId = this.activeRequestId;
      this.activeRequestId = undefined;
      if (requestId) {
        try { await this.options.hooks.abort(requestId); } catch {}
      }
      this.send({ type: 'shutdown_ack' });
      await this.options.hooks.shutdown(reason);
    })();
    this.shutdownPromise = cleanup;
    return cleanup;
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearReconnect();
    this.authenticated = false;
    this.ownerEpoch = undefined;
    const decoder = new NdjsonFrameDecoder<SupervisorFrame>(assertSupervisorFrame);
    const socket = createConnection({ path: this.options.socketPath });
    this.socket = socket;
    socket.on('connect', () => {
      this.send({ type: 'hello', token: this.options.controlToken, ownerProcessNonce: this.options.ownerProcessNonce });
    });
    socket.on('data', chunk => {
      try { for (const frame of decoder.push(chunk)) this.accept(frame); }
      catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.authenticated = false;
      this.scheduleReconnect();
      this.scheduleWatchdog();
    });
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolvePromise, reject) => {
      this.startResolve = resolvePromise;
      this.startReject = reject;
    });
    this.scheduleWatchdog();
    this.connect();
    return this.startPromise;
  }

  ready(): void {
    this.activeRequestId = undefined;
    if (this.authenticated) this.send({ type: 'state', state: 'ready' });
  }

  busy(requestId: string): void {
    this.activeRequestId = requestId;
    if (this.authenticated) this.send({ type: 'state', state: 'busy', requestId });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    if (!this.authenticated) this.startReject?.(new Error('Worker control client stopped before authentication.'));
    this.startResolve = undefined;
    this.startReject = undefined;
  }
}

export function workerOptionsFromEnvironment(
  hooks: WorkerHooks,
  environment: NodeJS.ProcessEnv = process.env,
): WorkerClientOptions | undefined {
  const socketPath = environment.PI_TEAM_CONTROL_SOCKET;
  const runtimeId = environment.PI_TEAM_RUNTIME_ID;
  const controlToken = environment.PI_TEAM_CONTROL_TOKEN;
  const ownerProcessNonce = environment.PI_TEAM_OWNER_PROCESS_NONCE;
  if (!socketPath && !runtimeId && !controlToken && !ownerProcessNonce) return undefined;
  if (!socketPath || !runtimeId || !controlToken || !ownerProcessNonce) {
    throw new Error('Incomplete supervised Team worker environment.');
  }
  return { socketPath, runtimeId, controlToken, ownerProcessNonce, hooks };
}
