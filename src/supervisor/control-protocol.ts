import { timingSafeEqual } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { EntityIdSchema } from '../domain/team.ts';
import type { OwnerIdentity } from './runtime-store.ts';

export const CONTROL_PROTOCOL_VERSION = 1;
export const MAX_CONTROL_FRAME_BYTES = 4 * 1024;
export const MAX_CONTROL_BUFFER_BYTES = 8 * 1024;

const BaseSchema = {
  version: Type.Literal(CONTROL_PROTOCOL_VERSION),
  runtimeId: EntityIdSchema,
  seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};

const OwnedWorkerSchema = {
  ...BaseSchema,
  ownerEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};

const OwnerSchema = Type.Object({
  ownerSessionId: EntityIdSchema,
  ownerInstanceId: EntityIdSchema,
  ownerProcessNonce: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  ownerEpoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

export const WorkerFrameSchema = Type.Union([
  Type.Object({ ...BaseSchema, type: Type.Literal('hello'), token: Type.String({ minLength: 64, maxLength: 128 }), ownerProcessNonce: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false }),
  Type.Object({ ...OwnedWorkerSchema, type: Type.Literal('ready') }, { additionalProperties: false }),
  Type.Object({ ...OwnedWorkerSchema, type: Type.Literal('state'), state: Type.Union([Type.Literal('ready'), Type.Literal('busy')]), requestId: Type.Optional(EntityIdSchema) }, { additionalProperties: false }),
  Type.Object({ ...OwnedWorkerSchema, type: Type.Literal('pong'), nonce: EntityIdSchema }, { additionalProperties: false }),
  Type.Object({ ...OwnedWorkerSchema, type: Type.Literal('shutdown_ack') }, { additionalProperties: false }),
]);

export const SupervisorFrameSchema = Type.Union([
  Type.Object({ ...BaseSchema, type: Type.Literal('hello_ack'), owner: OwnerSchema }, { additionalProperties: false }),
  Type.Object({ ...BaseSchema, type: Type.Literal('ping'), nonce: EntityIdSchema }, { additionalProperties: false }),
  Type.Object({ ...BaseSchema, type: Type.Literal('cancel_request'), requestId: EntityIdSchema }, { additionalProperties: false }),
  Type.Object({ ...BaseSchema, type: Type.Literal('prepare_shutdown'), reason: Type.Union([Type.Literal('stop'), Type.Literal('close'), Type.Literal('reload_failed'), Type.Literal('owner_lost')]), deadlineAt: Type.String({ format: 'date-time' }) }, { additionalProperties: false }),
]);

export type WorkerFrame =
  | { readonly version: 1; readonly type: 'hello'; readonly runtimeId: string; readonly seq: number; readonly token: string; readonly ownerProcessNonce: string }
  | { readonly version: 1; readonly type: 'ready'; readonly runtimeId: string; readonly seq: number; readonly ownerEpoch: number }
  | { readonly version: 1; readonly type: 'state'; readonly runtimeId: string; readonly seq: number; readonly ownerEpoch: number; readonly state: 'ready' | 'busy'; readonly requestId?: string }
  | { readonly version: 1; readonly type: 'pong'; readonly runtimeId: string; readonly seq: number; readonly ownerEpoch: number; readonly nonce: string }
  | { readonly version: 1; readonly type: 'shutdown_ack'; readonly runtimeId: string; readonly seq: number; readonly ownerEpoch: number };

export type SupervisorFrame =
  | { readonly version: 1; readonly type: 'hello_ack'; readonly runtimeId: string; readonly seq: number; readonly owner: OwnerIdentity }
  | { readonly version: 1; readonly type: 'ping'; readonly runtimeId: string; readonly seq: number; readonly nonce: string }
  | { readonly version: 1; readonly type: 'cancel_request'; readonly runtimeId: string; readonly seq: number; readonly requestId: string }
  | { readonly version: 1; readonly type: 'prepare_shutdown'; readonly runtimeId: string; readonly seq: number; readonly reason: 'stop' | 'close' | 'reload_failed' | 'owner_lost'; readonly deadlineAt: string };

export type WorkerFramePayload = WorkerFrame extends infer Frame
  ? Frame extends WorkerFrame ? Omit<Frame, 'version' | 'runtimeId' | 'seq' | 'ownerEpoch'> : never
  : never;
export type SupervisorFramePayload = SupervisorFrame extends infer Frame
  ? Frame extends SupervisorFrame ? Omit<Frame, 'version' | 'runtimeId' | 'seq'> : never
  : never;

export function assertWorkerFrame(value: unknown): asserts value is WorkerFrame {
  if (!Value.Check(WorkerFrameSchema, value)) throw Object.assign(new Error('Invalid worker control frame.'), { code: 'INVALID_FRAME' });
  const frame = value as WorkerFrame;
  if (frame.type === 'state' && (frame.state === 'busy') !== (frame.requestId !== undefined)) {
    throw Object.assign(new Error('Busy worker state requires exactly one request ID.'), { code: 'INVALID_FRAME' });
  }
}

export function assertSupervisorFrame(value: unknown): asserts value is SupervisorFrame {
  if (!Value.Check(SupervisorFrameSchema, value)) throw Object.assign(new Error('Invalid supervisor control frame.'), { code: 'INVALID_FRAME' });
}

export function controlTokenMatches(expected: string, received: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(received, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encodeControlFrame(frame: WorkerFrame | SupervisorFrame): Buffer {
  if (frame.type === 'hello' || frame.type === 'ready' || frame.type === 'state' || frame.type === 'pong' || frame.type === 'shutdown_ack') {
    assertWorkerFrame(frame);
  } else {
    assertSupervisorFrame(frame);
  }
  const text = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTROL_FRAME_BYTES) {
    throw Object.assign(new Error('Control frame is too large.'), { code: 'FRAME_TOO_LARGE' });
  }
  return Buffer.from(text, 'utf8');
}

export class NdjsonFrameDecoder<T> {
  private buffer = Buffer.alloc(0);

  constructor(private readonly validate: (value: unknown) => asserts value is T) {}

  push(chunk: Buffer): readonly T[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_CONTROL_BUFFER_BYTES) {
      this.buffer = Buffer.alloc(0);
      throw Object.assign(new Error('Control frame buffer is too large.'), { code: 'FRAME_TOO_LARGE' });
    }
    return this.drain([]);
  }

  private drain(frames: readonly T[]): readonly T[] {
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) return frames;
    const line = this.buffer.subarray(0, newline);
    this.buffer = this.buffer.subarray(newline + 1);
    if (line.length === 0) return this.drain(frames);
    if (line.length + 1 > MAX_CONTROL_FRAME_BYTES) {
      throw Object.assign(new Error('Control frame is too large.'), { code: 'FRAME_TOO_LARGE' });
    }
    const parsed = (() => {
      try { return JSON.parse(line.toString('utf8')) as unknown; }
      catch { throw Object.assign(new Error('Malformed control frame JSON.'), { code: 'INVALID_FRAME' }); }
    })();
    this.validate(parsed);
    return this.drain([...frames, parsed]);
  }
}
