import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { EntityIdSchema, TeamIdSchema, TimestampSchema } from '../domain/team.ts';
import {
  createAtomicJson, ensurePrivateDirectory, ensurePrivateTree, jsonFileNames, readJson, removeAtomic, replaceAtomicJson,
  withStorageLock,
} from '../storage/atomic.ts';
import { TeamPaths } from '../storage/paths.ts';

export type OwnerIdentity = {
  readonly ownerSessionId: string;
  readonly ownerInstanceId: string;
  readonly ownerProcessNonce: string;
  readonly ownerEpoch: number;
};

export type OwnedRuntimeState = 'starting' | 'ready' | 'busy' | 'stopping' | 'terminated' | 'lost';

export type OwnedRuntime = {
  readonly schemaVersion: 2;
  readonly runtimeId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly owner: OwnerIdentity;
  readonly processPid: number;
  readonly processStartToken: string;
  readonly processGroupId?: number;
  readonly tmuxSession?: string;
  readonly tmuxOwnershipTokenHash?: string;
  readonly cwd: string;
  readonly state: OwnedRuntimeState;
  readonly activeRequestId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const OwnerIdentitySchema = Type.Object({
  ownerSessionId: EntityIdSchema,
  ownerInstanceId: EntityIdSchema,
  ownerProcessNonce: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  ownerEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

export const OwnedRuntimeSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  runtimeId: EntityIdSchema,
  teamId: TeamIdSchema,
  memberId: EntityIdSchema,
  owner: OwnerIdentitySchema,
  processPid: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
  processStartToken: Type.String({ minLength: 1, maxLength: 256 }),
  processGroupId: Type.Optional(Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER })),
  tmuxSession: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  tmuxOwnershipTokenHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  state: Type.Union([
    Type.Literal('starting'), Type.Literal('ready'), Type.Literal('busy'), Type.Literal('stopping'),
    Type.Literal('terminated'), Type.Literal('lost'),
  ]),
  activeRequestId: Type.Optional(EntityIdSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}, { additionalProperties: false });

const transitions: Readonly<Record<OwnedRuntimeState, readonly OwnedRuntimeState[]>> = {
  starting: ['ready', 'busy', 'stopping', 'lost'],
  ready: ['busy', 'stopping', 'lost'],
  busy: ['ready', 'stopping', 'lost'],
  stopping: ['terminated', 'lost'],
  terminated: [],
  lost: ['stopping', 'terminated'],
};

export function assertOwnedRuntime(value: unknown): asserts value is OwnedRuntime {
  if (!Value.Check(OwnedRuntimeSchema, value)) throw new Error('Invalid Team v2 owned runtime record.');
  const runtime = value as OwnedRuntime;
  if (!runtime.cwd.startsWith('/')) throw new Error('Owned runtime cwd must be absolute.');
  if (Date.parse(runtime.updatedAt) < Date.parse(runtime.createdAt)) throw new Error('Owned runtime timestamp moved backwards.');
  if ((runtime.tmuxSession === undefined) !== (runtime.tmuxOwnershipTokenHash === undefined)) {
    throw new Error('Tmux runtime identity is incomplete.');
  }
  if (runtime.state !== 'busy' && runtime.activeRequestId !== undefined) {
    throw new Error('Only a busy runtime may hold an active request.');
  }
}

export function sameOwner(left: OwnerIdentity, right: OwnerIdentity): boolean {
  return left.ownerSessionId === right.ownerSessionId && left.ownerInstanceId === right.ownerInstanceId &&
    left.ownerProcessNonce === right.ownerProcessNonce && left.ownerEpoch === right.ownerEpoch;
}

export function canHandoff(from: OwnerIdentity, to: OwnerIdentity): boolean {
  return from.ownerSessionId === to.ownerSessionId && from.ownerProcessNonce === to.ownerProcessNonce &&
    from.ownerInstanceId !== to.ownerInstanceId && to.ownerEpoch > from.ownerEpoch;
}

const RUNTIME_MAX_BYTES = 32 * 1024;

export class RuntimeStore {
  constructor(readonly paths: TeamPaths, private readonly maxRuntimes = 32) {
    if (!Number.isSafeInteger(maxRuntimes) || maxRuntimes < 1) throw new Error('Invalid runtime quota.');
  }

  private lockPath(teamId: string, runtimeId: string): string {
    const hash = createHash('sha256').update(`${teamId}\0${runtimeId}`).digest('hex');
    return this.paths.lock(`runtime-${hash}`);
  }

  private rosterLockPath(teamId: string): string {
    return this.paths.lock(`runtimes-${createHash('sha256').update(teamId).digest('hex')}`);
  }

  private async prepare(teamId: string): Promise<void> {
    await ensurePrivateTree(this.paths.root, 'teams');
    await ensurePrivateTree(this.paths.root, 'control');
    await ensurePrivateDirectory(this.paths.team(teamId), false);
    await ensurePrivateDirectory(this.paths.runtimes(teamId), false);
  }

  async create(runtime: OwnedRuntime): Promise<void> {
    assertOwnedRuntime(runtime);
    await this.prepare(runtime.teamId);
    await withStorageLock(this.rosterLockPath(runtime.teamId), async () => {
      const ids = await jsonFileNames(this.paths.runtimes(runtime.teamId), false);
      if (ids.length >= this.maxRuntimes) throw Object.assign(new Error('Team runtime quota reached.'), { code: 'QUOTA_EXCEEDED' });
      const records = await Promise.all(ids.map(id => this.read(runtime.teamId, id)));
      if (records.some(existing => existing?.memberId === runtime.memberId && existing.state !== 'terminated')) {
        throw Object.assign(new Error('Supervised member already has a live runtime.'), { code: 'ALREADY_EXISTS' });
      }
      await createAtomicJson(this.paths.runtime(runtime.teamId, runtime.runtimeId), runtime, RUNTIME_MAX_BYTES);
    });
  }

  async read(teamId: string, runtimeId: string): Promise<OwnedRuntime | undefined> {
    await this.prepare(teamId);
    const runtime = await readJson(this.paths.runtime(teamId, runtimeId), assertOwnedRuntime, RUNTIME_MAX_BYTES);
    if (runtime && (runtime.teamId !== teamId || runtime.runtimeId !== runtimeId)) {
      throw Object.assign(new Error('Runtime identity does not match its storage path.'), { code: 'CORRUPT_RECORD' });
    }
    return runtime;
  }

  async list(teamId: string): Promise<readonly OwnedRuntime[]> {
    await this.prepare(teamId);
    const ids = await jsonFileNames(this.paths.runtimes(teamId), false);
    const records = await Promise.all(ids.map(id => this.read(teamId, id)));
    return records.filter((runtime): runtime is OwnedRuntime => runtime !== undefined);
  }

  async update(
    teamId: string,
    runtimeId: string,
    owner: OwnerIdentity,
    change: (runtime: OwnedRuntime) => OwnedRuntime,
  ): Promise<OwnedRuntime> {
    await this.prepare(teamId);
    return withStorageLock(this.lockPath(teamId, runtimeId), async () => {
      const path = this.paths.runtime(teamId, runtimeId);
      const current = await readJson(path, assertOwnedRuntime, RUNTIME_MAX_BYTES);
      if (!current) throw Object.assign(new Error(`Unknown runtime "${runtimeId}".`), { code: 'NOT_FOUND' });
      if (!sameOwner(current.owner, owner)) throw Object.assign(new Error('Runtime ownership has been fenced.'), { code: 'FENCED' });
      const next = change(current);
      assertOwnedRuntime(next);
      if (next.runtimeId !== current.runtimeId || next.teamId !== current.teamId || next.memberId !== current.memberId ||
          next.processPid !== current.processPid || next.processStartToken !== current.processStartToken ||
          next.processGroupId !== current.processGroupId || next.tmuxSession !== current.tmuxSession ||
          next.tmuxOwnershipTokenHash !== current.tmuxOwnershipTokenHash || next.cwd !== current.cwd ||
          next.createdAt !== current.createdAt || !sameOwner(next.owner, current.owner)) {
        throw new Error('Owned runtime identity is immutable outside handoff.');
      }
      if (next.state !== current.state && !transitions[current.state].includes(next.state)) {
        throw Object.assign(new Error(`Invalid runtime transition: ${current.state} → ${next.state}.`), { code: 'INVALID_TRANSITION' });
      }
      if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) throw new Error('Runtime updatedAt moved backwards.');
      await replaceAtomicJson(path, next, { maxBytes: RUNTIME_MAX_BYTES, previous: true });
      return next;
    });
  }

  async removeTerminated(teamId: string, runtimeId: string, owner: OwnerIdentity): Promise<boolean> {
    await this.prepare(teamId);
    return withStorageLock(this.rosterLockPath(teamId), async () =>
      withStorageLock(this.lockPath(teamId, runtimeId), async () => {
        const path = this.paths.runtime(teamId, runtimeId);
        const current = await readJson(path, assertOwnedRuntime, RUNTIME_MAX_BYTES);
        if (!current) return false;
        if (!sameOwner(current.owner, owner)) {
          throw Object.assign(new Error('Runtime ownership has been fenced.'), { code: 'FENCED' });
        }
        if (current.state !== 'terminated') {
          throw Object.assign(new Error('Only a terminated runtime can be removed.'), { code: 'INVALID_STATE' });
        }
        return removeAtomic(path);
      }));
  }

  async advanceOwner(teamId: string, runtimeId: string, from: OwnerIdentity, to: OwnerIdentity, at: string): Promise<OwnedRuntime> {
    await this.prepare(teamId);
    return withStorageLock(this.lockPath(teamId, runtimeId), async () => {
      const path = this.paths.runtime(teamId, runtimeId);
      const current = await readJson(path, assertOwnedRuntime, RUNTIME_MAX_BYTES);
      if (!current) throw Object.assign(new Error(`Unknown runtime "${runtimeId}".`), { code: 'NOT_FOUND' });
      const sameIdentity = from.ownerSessionId === to.ownerSessionId && from.ownerInstanceId === to.ownerInstanceId &&
        from.ownerProcessNonce === to.ownerProcessNonce && to.ownerEpoch > from.ownerEpoch;
      if (!sameOwner(current.owner, from) || !sameIdentity) {
        throw Object.assign(new Error('Runtime epoch advancement does not match ownership.'), { code: 'FENCED' });
      }
      const next = { ...current, owner: to, updatedAt: at };
      assertOwnedRuntime(next);
      await replaceAtomicJson(path, next, { maxBytes: RUNTIME_MAX_BYTES, previous: true });
      return next;
    });
  }

  async handoff(teamId: string, runtimeId: string, from: OwnerIdentity, to: OwnerIdentity, at: string): Promise<OwnedRuntime> {
    await this.prepare(teamId);
    return withStorageLock(this.lockPath(teamId, runtimeId), async () => {
      const path = this.paths.runtime(teamId, runtimeId);
      const current = await readJson(path, assertOwnedRuntime, RUNTIME_MAX_BYTES);
      if (!current) throw Object.assign(new Error(`Unknown runtime "${runtimeId}".`), { code: 'NOT_FOUND' });
      if (!sameOwner(current.owner, from) || !canHandoff(from, to)) {
        throw Object.assign(new Error('Runtime handoff ownership does not match.'), { code: 'FENCED' });
      }
      const next = { ...current, owner: to, updatedAt: at };
      assertOwnedRuntime(next);
      await replaceAtomicJson(path, next, { maxBytes: RUNTIME_MAX_BYTES, previous: true });
      return next;
    });
  }
}
