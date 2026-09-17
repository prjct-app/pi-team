import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_CONTROL_BUFFER_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  NdjsonFrameDecoder,
  assertWorkerFrame,
  controlTokenMatches,
  encodeControlFrame,
  type WorkerFrame,
} from '../src/supervisor/control-protocol.ts';
import { createWorkerBootstrap } from '../src/supervisor/worker-bootstrap.ts';
import type { WorkerClient, WorkerClientOptions } from '../src/supervisor/worker-client.ts';

test('control protocol validates bounded versioned NDJSON and constant-time tokens', () => {
  const decoder = new NdjsonFrameDecoder<WorkerFrame>(assertWorkerFrame);
  const frame: WorkerFrame = {
    version: CONTROL_PROTOCOL_VERSION,
    type: 'state',
    runtimeId: 'runtime-1',
    seq: 2,
    ownerEpoch: 1,
    state: 'busy',
    requestId: 'request-1',
  };
  const encoded = encodeControlFrame(frame);
  assert.deepEqual(decoder.push(encoded.subarray(0, 5)), []);
  assert.deepEqual(decoder.push(encoded.subarray(5)), [frame]);
  assert.equal(controlTokenMatches('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(controlTokenMatches('a'.repeat(64), 'b'.repeat(64)), false);
  assert.equal(controlTokenMatches('a'.repeat(64), 'short'), false);
  assert.throws(() => decoder.push(Buffer.from('{bad}\n')), (error: unknown) =>
    (error as { code?: string }).code === 'INVALID_FRAME');

  const oversizedFrame = new NdjsonFrameDecoder<WorkerFrame>(assertWorkerFrame);
  assert.throws(() => oversizedFrame.push(Buffer.from(`${'x'.repeat(MAX_CONTROL_FRAME_BYTES + 1)}\n`)),
    (error: unknown) => (error as { code?: string }).code === 'FRAME_TOO_LARGE');
  const oversized = new NdjsonFrameDecoder<WorkerFrame>(assertWorkerFrame);
  assert.throws(() => oversized.push(Buffer.alloc(MAX_CONTROL_BUFFER_BYTES + 1)), (error: unknown) =>
    (error as { code?: string }).code === 'FRAME_TOO_LARGE');
  assert.throws(() => assertWorkerFrame({ ...frame, requestId: undefined }), /Busy worker state/);
  assert.throws(() => assertWorkerFrame({ ...frame, version: 2 }), /Invalid worker control frame/);
});

test('worker bootstrap uses only documented abort and shutdown context controls', async () => {
  const calls: string[] = [];
  const clients: WorkerClientOptions[] = [];
  const fake = {
    start: async () => {},
    busy(requestId: string) { calls.push(`busy:${requestId}`); },
    ready() { calls.push('ready'); },
    stop() { calls.push('stop'); },
  } as unknown as WorkerClient;
  const bootstrap = createWorkerBootstrap({
    PI_TEAM_CONTROL_SOCKET: '/tmp/pi-team-control.sock',
    PI_TEAM_RUNTIME_ID: 'runtime-1',
    PI_TEAM_CONTROL_TOKEN: 'a'.repeat(64),
    PI_TEAM_OWNER_PROCESS_NONCE: 'b'.repeat(64),
  }, options => { clients.push(options); return fake; });
  assert.ok(bootstrap);
  bootstrap.attach({ abort() { calls.push('abort'); }, shutdown() { calls.push('shutdown'); } });
  await bootstrap.start();
  bootstrap.busy('request-1');
  bootstrap.ready();
  await clients[0]!.hooks.abort('request-1');
  await clients[0]!.hooks.shutdown('stop');
  bootstrap.dispose();
  assert.deepEqual(calls, ['busy:request-1', 'ready', 'abort', 'shutdown', 'stop']);
  assert.equal(createWorkerBootstrap({}), undefined);
  assert.throws(() => createWorkerBootstrap({ PI_TEAM_RUNTIME_ID: 'runtime-1' }), /Incomplete supervised Team worker environment/);
});
