import assert from 'node:assert/strict';
import { mkdtemp, rm, lstat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installTeam } from '../src/index.ts';
import { DynamicStore, resolveProject } from '../src/dynamic/store.ts';

function harness(root: string) {
  const handlers = new Map<string, any>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
  const active = ['read', 'other']; const turns: string[] = []; const notices: string[] = [];
  const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => 'session-test' }, ui: { notify: (s: string) => notices.push(s) } };
  const api = { on: (n: string, h: any) => handlers.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c),
    registerTool: (t: any) => { tools.set(t.name, t); active.push(t.name); }, getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
    sendUserMessage: (s: string) => turns.push(s), sendMessage() {} } as unknown as ExtensionAPI;
  installTeam(api, { root, pollMs: 60_000, identity: async () => ({ processPid: 4242, processGroupId: 4242, processStartToken: 'test' }),
    runner: () => ({ run: async () => ({ status: 'completed', summary: 'Verified', stopped: true }), close: async () => {} }) });
  return { handlers, active, turns, notices, tools, command: (s: string) => commands.get('team').handler(s, ctx),
    emit: (n: string, event: any = {}) => handlers.get(n)?.(event, ctx) };
}

test('fresh startup is inert; explicit objective creates one Run and one user turn; normal prompts unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-ext-')); const app = harness(root);
  try {
    await app.emit('session_start');
    await assert.rejects(lstat(join(root, 'orchestration-v2')), { code: 'ENOENT' });
    assert.deepEqual(app.active, ['read', 'other']); assert.equal(app.handlers.has('input'), false);
    assert.equal(await app.emit('before_agent_start', { systemPrompt: 'normal' }), undefined);
    await app.command('Ship login validation'); await app.command('Second objective');
    assert.equal(app.turns.length, 1); assert.ok(app.active.includes('team_orchestrate'));
    const state = await new DynamicStore(join(root, 'orchestration-v2')).read((await resolveProject(root)).teamId);
    assert.deepEqual(state?.runs.map(r => r.status), ['active', 'queued']);
    await app.tools.get('team_orchestrate').execute('id', { action: 'finish', summary: 'Verified' });
    assert.deepEqual(app.active, ['read', 'other']);
  } finally { await app.emit('session_shutdown', { reason: 'quit' }); await rm(root, { recursive: true, force: true }); }
});
for (const reason of ['reload', 'new', 'fork']) test(`${reason} interrupts and fences without replay; removed commands leave old bytes intact`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-boundary-')); const app = harness(root);
  try {
    const old = join(root, 'old-store.json'); await writeFile(old, 'user bytes');
    await app.emit('session_start');
    for (const text of ['create shop lead', 'join shop lead', 'migrate shop', 'legacy inspect']) await app.command(text);
    assert.equal(await readFile(old, 'utf8'), 'user bytes'); assert.equal(app.turns.length, 0);
    await app.command('Ship login validation'); await app.command('Queued'); await app.emit('session_shutdown', { reason });
    const state = await new DynamicStore(join(root, 'orchestration-v2')).read((await resolveProject(root)).teamId);
    assert.equal(state?.owner, undefined); assert.equal(state?.runs[0]?.status, 'cancelled'); assert.equal(state?.runs[1]?.status, 'queued');
    const replacement = harness(root); await replacement.emit('session_start', { reason });
    assert.equal(replacement.turns.length, 0); assert.deepEqual(replacement.active, ['read', 'other']);
    await replacement.emit('session_shutdown', { reason: 'quit' });
  } finally { await app.emit('session_shutdown', { reason: 'quit' }); await rm(root, { recursive: true, force: true }); }
});
