import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishActiveRoot } from '../src/agents.ts';
import { harness, until } from './harness.ts';

const KEY = Symbol.for('prjct.agents');
type Registry = { activeRoot?: () => string | undefined; handle?: { lines: () => string[] } };
const space = (): Registry | undefined => (globalThis as unknown as Record<symbol, Registry | undefined>)[KEY];

test('the process registry is shared without importing pi-subagents', () => {
  delete (globalThis as unknown as Record<symbol, Registry | undefined>)[KEY];
  const handle = { lines: () => ['Nadia · running'] };
  (globalThis as unknown as Record<symbol, Registry | undefined>)[KEY] = { handle };
  publishActiveRoot(() => 'root-1');
  assert.equal(space()?.activeRoot?.(), 'root-1');
  assert.equal(space()?.handle, handle, 'publishing the team provider preserves state owned by pi-subagents');
  delete (globalThis as unknown as Record<symbol, Registry | undefined>)[KEY];
});

test('the provider exposes the root id only while this session works a team request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-agents-'));
  delete (globalThis as unknown as Record<symbol, Registry | undefined>)[KEY];
  const pm = harness(root, 'pm');
  const backend = harness(root, 'backend');
  t.after(async () => {
    await pm.emit('session_shutdown');
    await backend.emit('session_shutdown');
    delete (globalThis as unknown as Record<symbol, Registry | undefined>)[KEY];
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start');
  await backend.emit('session_start');
  await pm.command('create shop');
  await pm.command('join shop pm');
  await backend.command('join shop backend');
  assert.equal(typeof space()?.activeRoot, 'function');
  assert.equal(space()?.activeRoot?.(), undefined, 'no active team request means no root to inherit');

  await pm.command('send backend Map the importer');
  await until(() => backend.received.length === 1);
  assert.equal(space()?.activeRoot?.(), backend.received[0].details.rootId,
    'a subagent born in the turn is filed under that request');
});
