import { defaultProcessController, sameProcess, type ProcessController, type ProcessIdentity } from '../process-identity.ts';
import type { OwnedRuntime } from './runtime-store.ts';
import type { TmuxAdapter } from './tmux-adapter.ts';

export type ShutdownReason = 'stop' | 'close' | 'reload_failed' | 'owner_lost';
export type ShutdownPhase = 'prepare' | 'graceful' | 'term' | 'kill' | 'tmux' | 'terminated' | 'blocked';

export type ShutdownTimings = {
  readonly gracefulMs: number;
  readonly termMs: number;
  readonly killMs: number;
  readonly pollMs: number;
};

export type RuntimeControl = {
  prepareShutdown(runtimeId: string, reason: ShutdownReason, deadlineAt: string): Promise<boolean>;
};

export type ShutdownResult = {
  readonly runtimeId: string;
  readonly status: 'terminated' | 'blocked';
  readonly phase: ShutdownPhase;
  readonly detail?: string;
};

const DEFAULT_TIMINGS: ShutdownTimings = { gracefulMs: 5_000, termMs: 2_000, killMs: 1_000, pollMs: 50 };

export function shutdownTimings(input: Partial<ShutdownTimings> = {}): ShutdownTimings {
  const value = { ...DEFAULT_TIMINGS, ...input };
  if ([value.gracefulMs, value.termMs, value.killMs].some(duration => !Number.isFinite(duration) || duration < 0) ||
      !Number.isFinite(value.pollMs) || value.pollMs <= 0) {
    throw new Error('Shutdown timings require non-negative durations and a positive poll interval.');
  }
  return value;
}

function identity(runtime: OwnedRuntime): ProcessIdentity {
  return {
    processPid: runtime.processPid,
    processStartToken: runtime.processStartToken,
    processGroupId: runtime.processGroupId ?? runtime.processPid,
  };
}

export class RuntimeShutdown {
  private readonly timings: ShutdownTimings;

  constructor(
    private readonly control: RuntimeControl,
    private readonly tmux: Pick<TmuxAdapter, 'metadataMatches' | 'killSession'>,
    private readonly processes: ProcessController = defaultProcessController,
    options: { readonly timings?: Partial<ShutdownTimings>; readonly phase?: (runtimeId: string, phase: ShutdownPhase) => void } = {},
  ) {
    this.timings = shutdownTimings(options.timings);
    this.phase = options.phase;
  }

  private readonly phase?: (runtimeId: string, phase: ShutdownPhase) => void;

  private emit(runtimeId: string, phase: ShutdownPhase): void { this.phase?.(runtimeId, phase); }

  private async alive(expected: ProcessIdentity): Promise<boolean> {
    return sameProcess(expected, await this.processes.inspect(expected.processPid));
  }

  private async waitForExit(expected: ProcessIdentity, remainingMs: number): Promise<boolean> {
    if (!await this.alive(expected)) return true;
    if (remainingMs <= 0) return false;
    const pause = Math.min(this.timings.pollMs, remainingMs);
    await this.processes.delay(pause);
    return this.waitForExit(expected, remainingMs - pause);
  }

  private async boundedPrepare(runtime: OwnedRuntime, reason: ShutdownReason): Promise<void> {
    const deadlineAt = new Date(Date.now() + this.timings.gracefulMs).toISOString();
    const timeout = this.processes.delay(Math.min(this.timings.pollMs, this.timings.gracefulMs));
    await Promise.race([
      this.control.prepareShutdown(runtime.runtimeId, reason, deadlineAt).catch(() => false),
      timeout,
    ]);
  }

  private async ownershipSafe(runtime: OwnedRuntime, expected: ProcessIdentity): Promise<'owned' | 'exited' | 'blocked'> {
    if (!await this.alive(expected)) return 'exited';
    return await this.tmux.metadataMatches(runtime) ? 'owned' : 'blocked';
  }

  private async cleanTmux(runtime: OwnedRuntime): Promise<void> {
    this.emit(runtime.runtimeId, 'tmux');
    await this.tmux.killSession(runtime).catch(() => false);
  }

  async stop(runtime: OwnedRuntime, reason: ShutdownReason = 'stop'): Promise<ShutdownResult> {
    if (runtime.state === 'terminated') return { runtimeId: runtime.runtimeId, status: 'terminated', phase: 'terminated' };
    const expected = identity(runtime);
    this.emit(runtime.runtimeId, 'prepare');
    await this.boundedPrepare(runtime, reason);
    this.emit(runtime.runtimeId, 'graceful');
    if (await this.waitForExit(expected, this.timings.gracefulMs)) {
      await this.cleanTmux(runtime);
      this.emit(runtime.runtimeId, 'terminated');
      return { runtimeId: runtime.runtimeId, status: 'terminated', phase: 'terminated' };
    }

    const termOwnership = await this.ownershipSafe(runtime, expected);
    if (termOwnership === 'exited') {
      await this.cleanTmux(runtime);
      return { runtimeId: runtime.runtimeId, status: 'terminated', phase: 'terminated' };
    }
    if (termOwnership === 'blocked') {
      this.emit(runtime.runtimeId, 'blocked');
      return { runtimeId: runtime.runtimeId, status: 'blocked', phase: 'blocked', detail: 'Ownership metadata changed before SIGTERM.' };
    }
    this.emit(runtime.runtimeId, 'term');
    await this.processes.signal(expected, 'SIGTERM');
    if (await this.waitForExit(expected, this.timings.termMs)) {
      await this.cleanTmux(runtime);
      this.emit(runtime.runtimeId, 'terminated');
      return { runtimeId: runtime.runtimeId, status: 'terminated', phase: 'terminated' };
    }

    const killOwnership = await this.ownershipSafe(runtime, expected);
    if (killOwnership === 'exited') {
      await this.cleanTmux(runtime);
      return { runtimeId: runtime.runtimeId, status: 'terminated', phase: 'terminated' };
    }
    if (killOwnership === 'blocked') {
      this.emit(runtime.runtimeId, 'blocked');
      return { runtimeId: runtime.runtimeId, status: 'blocked', phase: 'blocked', detail: 'Ownership metadata changed before SIGKILL.' };
    }
    this.emit(runtime.runtimeId, 'kill');
    await this.processes.signal(expected, 'SIGKILL');
    if (!await this.waitForExit(expected, this.timings.killMs)) {
      this.emit(runtime.runtimeId, 'blocked');
      return { runtimeId: runtime.runtimeId, status: 'blocked', phase: 'blocked', detail: 'Verified process survived SIGKILL deadline.' };
    }
    await this.cleanTmux(runtime);
    this.emit(runtime.runtimeId, 'terminated');
    return { runtimeId: runtime.runtimeId, status: 'terminated', phase: 'terminated' };
  }
}
