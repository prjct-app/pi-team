import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installTeam } from '../src/index.ts';
import { TeamPaths } from '../src/storage/paths.ts';
import { TeamStore } from '../src/storage/team-store.ts';
import { TeamRuntime } from '../src/runtime/team-runtime.ts';

type Handler = (event: any, context: ExtensionContext) => unknown;

async function until(predicate: () => Promise<boolean>, attempts = 100): Promise<void> {
  if (await predicate()) return;
  if (attempts <= 0) throw new Error('Condition was not reached.');
  await new Promise(resolve => setTimeout(resolve, 20));
  return until(predicate, attempts - 1);
}

function extensionHarness(root: string, sessionId: string, entries: any[] = [], reloadTtlMs = 20_000) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notices: { message: string; level: string }[] = [];
  const activeTools: string[] = [];
  const context = {
    cwd: '/repo',
    mode: 'tui',
    hasUI: true,
    isIdle: () => true,
    abort() {},
    shutdown() {},
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
    ui: {
      notify(message: string, level = 'info') { notices.push({ message, level }); },
      confirm: async () => true,
    },
  } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    registerMessageRenderer() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); },
    sendMessage() {},
    getActiveTools: () => [...activeTools],
    setActiveTools(next: string[]) { activeTools.splice(0, activeTools.length, ...next); },
  } as unknown as ExtensionAPI;
  installTeam(api, { root, heartbeatMs: 60_000, pollMs: 60_000, reloadTtlMs });
  return {
    entries,
    notices,
    activeTools,
    tools,
    async emit(name: string, event: unknown = {}) {
      return Promise.all((handlers.get(name) ?? []).map(handler => handler(event, context)));
    },
    async command(input: string) { await commands.get('team').handler(input, context); },
  };
}

test('v2 extension does not intercept normal prompts and activates the compact tool only after join', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-extension-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = extensionHarness(root, 'session-1');
  await app.emit('session_start', { reason: 'startup' });
  assert.equal(app.activeTools.includes('team'), false);
  assert.deepEqual(await app.emit('input', { source: 'interactive', text: 'Implement the API' }), [undefined]);
  await app.command('create shop lead');
  assert.equal(app.activeTools.includes('team'), true);
  assert.match(app.notices.at(-1)?.message ?? '', /Created and joined/);
  assert.ok(app.entries.some(entry => entry.customType === 'team-v2-membership' && entry.data?.teamId === 'shop'));
  await app.emit('session_shutdown', { reason: 'quit' });
});

test('edit tools respect another member resource lease while Bash receives an advisory warning', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-extension-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = extensionHarness(root, 'session-owner');
  await app.emit('session_start', { reason: 'startup' });
  await app.command('create lease-team lead');
  const runtime = new TeamRuntime(new TeamPaths(root));
  const peer = await runtime.memberships.join({ teamId: 'lease-team', alias: 'peer', sessionId: 'peer-session', cwd: '/repo-a', kind: 'external' });
  await runtime.resources.claim(peer, 'src');
  const edit = await app.emit('tool_call', { toolName: 'edit', input: { path: '/repo-a/src/app.ts', edits: [] } });
  assert.equal((edit[0] as { block?: boolean })?.block, true);
  await app.emit('tool_call', { toolName: 'bash', input: { command: 'cat /repo-a/src/app.ts' } });
  assert.match(app.notices.at(-1)?.message ?? '', /claimed by another member/);
  await app.emit('session_shutdown', { reason: 'quit' });
});

test('purge remains an explicit human command and removes only a closed inactive team', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-extension-purge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new TeamRuntime(new TeamPaths(root));
  await runtime.teams.create({
    schemaVersion: 2, teamId: 'archive', state: 'closed',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const app = extensionHarness(root, 'session-purge');
  await app.emit('session_start', { reason: 'startup' });
  await app.command('purge archive');
  assert.equal(await runtime.teams.read('archive'), undefined);
  assert.match(app.notices.at(-1)?.message ?? '', /Purged closed Team/);
  await app.emit('session_shutdown', { reason: 'quit' });
});

test('reload retains exact membership for the same session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-extension-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries: any[] = [];
  const original = extensionHarness(root, 'session-reload', entries);
  await original.emit('session_start', { reason: 'startup' });
  await original.command('create reload-team lead');
  const teams = new TeamStore(new TeamPaths(root));
  const before = (await teams.listMembers('reload-team')).find(member => member.alias === 'lead')!;
  await original.emit('session_shutdown', { reason: 'reload' });

  const replacement = extensionHarness(root, 'session-reload', entries);
  await replacement.emit('session_start', { reason: 'reload' });
  const after = (await teams.listMembers('reload-team')).find(member => member.alias === 'lead')!;
  assert.equal(after.generation, before.generation);
  assert.equal(replacement.activeTools.includes('team'), true);
  await replacement.emit('session_shutdown', { reason: 'quit' });
});

test('failed reload expires into membership cleanup instead of indefinite ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-extension-failed-reload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = extensionHarness(root, 'session-failed-reload', [], 10);
  await app.emit('session_start', { reason: 'startup' });
  await app.command('create failed-reload lead');
  await app.emit('session_shutdown', { reason: 'reload' });
  const runtime = new TeamRuntime(new TeamPaths(root));
  await until(async () => {
    const [member] = await runtime.teams.listMembers('failed-reload');
    const leases = await runtime.leases.list('failed-reload');
    return member?.state === 'left' && leases.every(lease => lease.releasedAt !== undefined);
  });
});

for (const reason of ['new', 'fork', 'resume'] as const) {
  test(`${reason} starts a boundary that does not inherit outgoing Team membership`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `pi-team-extension-${reason}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entries: any[] = [];
    const original = extensionHarness(root, `session-before-${reason}`, entries);
    await original.emit('session_start', { reason: 'startup' });
    await original.command(`create ${reason}-team lead`);
    await original.emit('session_shutdown', { reason });

    const replacement = extensionHarness(root, `session-after-${reason}`, entries);
    await replacement.emit('session_start', { reason, previousSessionFile: '/old' });
    assert.equal(replacement.activeTools.includes('team'), false);
    await replacement.emit('session_shutdown', { reason: 'quit' });
  });
}
