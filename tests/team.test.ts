import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { AUTO_TURN_LIMIT, installTeam } from '../src/index.ts';
import { parseTeamCommand } from '../src/commands/team-command.ts';

type Sent = { readonly content: string; readonly options: { readonly triggerTurn?: boolean; readonly deliverAs?: string } };

/** One simulated Pi terminal over a shared store. */
function terminal(root: string, sessionId: string, entries: unknown[] = []) {
  const handlers = new Map<string, any>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
  const active: string[] = ['read', 'bash']; const notices: string[] = []; const sent: Sent[] = []; const status = { text: undefined as string | undefined };
  const idle = { value: true };
  const ctx = {
    cwd: `/work/${sessionId}`, hasUI: true, isIdle: () => idle.value,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    ui: { notify: (s: string) => notices.push(s), setStatus: (_k: string, t: string | undefined) => { status.text = t; } },
  };
  const api = {
    on: (n: string, h: any) => handlers.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c),
    registerTool: (t: any) => { tools.set(t.name, t); active.push(t.name); }, getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
    sendMessage: (m: any, options: any) => sent.push({ content: m.content, options }),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  installTeam(api, { root, pollMs: 10, complete: async (_s, user) => user });
  return {
    active, notices, sent, status, idle, entries, tools, root,
    command: (s: string) => commands.get('team').handler(s, ctx),
    commandWith: (s: string, extra: { mode?: string; ui?: Record<string, unknown> }) =>
      commands.get('team').handler(s, { ...ctx, ...extra, ui: { ...ctx.ui, setEditorText() {}, ...extra.ui } }),
    emit: (n: string, event: any = {}) => handlers.get(n)?.(event, ctx),
    tool: (name: string, input: unknown) => tools.get(name).execute('id', input),
    last: () => notices.at(-1) ?? '',
  };
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const open: ReturnType<typeof terminal>[] = [];
  const make = async (session: string, entries: unknown[] = []) => {
    const term = terminal(root, session, entries); open.push(term); await term.emit('session_start', { reason: 'startup' }); return term;
  };
  t.after(async () => {
    for (const term of open) await term.emit('session_shutdown', { reason: 'quit' });
    await rm(root, { recursive: true, force: true });
  });
  return make;
}

async function until(check: () => boolean, ms = 2000, refresh?: () => Promise<void>): Promise<void> {
  const start = Date.now();
  await refresh?.();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for delivery.');
    await new Promise(resolve => setTimeout(resolve, 10));
    await refresh?.();
  }
}

test('parses the four commands and rejects the rest', () => {
  assert.deepEqual(parseTeamCommand(''), { action: 'status' });
  assert.deepEqual(parseTeamCommand('join shop backend'), { action: 'join', team: 'shop', role: 'backend' });
  assert.deepEqual(parseTeamCommand('send backend please review  the API'), { action: 'send', to: 'backend', body: 'please review  the API' });
  assert.deepEqual(parseTeamCommand('leave'), { action: 'leave' });
  assert.throws(() => parseTeamCommand('join Shop'), /Usage/);
  assert.throws(() => parseTeamCommand('join shop Backend'), /Role must be/);
  assert.throws(() => parseTeamCommand('send backend'), /Usage/);
  assert.throws(() => parseTeamCommand('create shop'), /Unknown/);
});

test('startup is inert: no tools, no status, no prompt change until join', async (t) => {
  const make = await setup(t);
  const a = await make('s-a');
  assert.deepEqual(a.active, ['read', 'bash']);
  assert.equal(a.status.text, undefined);
  assert.equal(await a.emit('before_agent_start', { prompt: 'hi', systemPrompt: 'base' }), undefined);
});

test('two terminals join by name, see each other working, and a message arrives at once', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend');
  assert.match(a.last(), /Created and joined team shop as backend/);
  assert.equal(a.status.text, 'team shop · backend');
  assert.ok(a.active.includes('team_message') && a.active.includes('team_peers'));
  await b.command('join shop reviewer');
  assert.match(b.last(), /^Joined team shop as reviewer/);

  const prompt = await a.emit('before_agent_start', { prompt: 'Implement the login endpoint', systemPrompt: 'base' });
  assert.match(prompt.systemPrompt, /You are "backend" in team "shop"/);
  // Activity is written by backend's own terminal; reviewer sees it once it lands.
  const seen = { text: '' };
  await until(() => /● backend {2}working \d+s · Implement the login endpoint/.test(seen.text), 2000, async () => {
    seen.text = (await b.tool('team_peers', {})).content[0].text;
  });

  // Busy recipient: steered into the running work, never parked in a queue.
  a.idle.value = false;
  await b.tool('team_message', { to: 'backend', kind: 'question', body: 'Which status code for a bad password?' });
  await until(() => a.sent.length === 1);
  assert.match(a.sent[0]!.content, /Team message from reviewer \(question/);
  assert.deepEqual(a.sent[0]!.options, { triggerTurn: true, deliverAs: 'steer' });

  // Idle recipient: the message opens a turn.
  await a.tool('team_message', { to: 'reviewer', kind: 'info', body: '401, see src/auth.ts' });
  await until(() => b.sent.length === 1);
  assert.deepEqual(b.sent[0]!.options, { triggerTurn: true, deliverAs: 'followUp' });
});

test('an offline or unknown teammate fails now instead of queuing', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  await b.command('leave');
  assert.equal(b.status.text, undefined);
  assert.ok(!b.active.includes('team_message'));
  await assert.rejects(a.tool('team_message', { to: 'reviewer', kind: 'info', body: 'hi' }), /offline, so nothing was sent/);
  await assert.rejects(a.tool('team_message', { to: 'nobody', kind: 'info', body: 'hi' }), /No "nobody"/);
  await assert.rejects(a.tool('team_message', { to: 'backend', kind: 'info', body: 'hi' }), /That is you/);
  await b.command('join shop reviewer');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(b.sent.length, 0, 'Nothing sent while offline is delivered later');
});

test('/team send carries what the person typed, and a taken role is refused', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend');
  await b.command('join shop backend');
  assert.match(b.last(), /already online in team shop/);
  await b.command('join shop docs');
  await b.command('send backend Please rebase on main');
  await until(() => a.sent.length === 1);
  assert.match(a.sent[0]!.content, /From the person at this terminal: Please rebase on main/);
  await a.command('');
  assert.match(a.last(), /team shop · you are backend\n● backend \(you\)[^\n]*\n● docs/);
});

test('reload keeps the role: it is released on shutdown and taken back on start', async (t) => {
  const make = await setup(t);
  const entries: unknown[] = [];
  const a = await make('s-a', entries);
  await a.command('join shop backend');
  await a.emit('session_shutdown', { reason: 'reload' });
  const again = await make('s-a', entries);
  assert.equal(again.status.text, 'team shop · backend');
  assert.ok(again.active.includes('team_message'));
  await again.command('leave');
  const third = await make('s-a', entries);
  assert.equal(third.status.text, undefined, 'An explicit leave is remembered');
});

test('teammates cannot ping-pong forever: turns stop after the limit until the person types', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  for (const index of Array.from({ length: AUTO_TURN_LIMIT + 1 }, (_, i) => i)) {
    await b.tool('team_message', { to: 'backend', kind: 'info', body: `note ${index}` });
    await until(() => a.sent.length === index + 1);
  }
  assert.equal(a.sent.filter(s => s.options.triggerTurn).length, AUTO_TURN_LIMIT);
  assert.equal(a.sent.at(-1)!.options.triggerTurn, false);
  assert.ok(a.notices.some(n => /no longer start turns until you type/.test(n)));
  await a.emit('input', { source: 'interactive', text: 'go on' });
  await b.tool('team_message', { to: 'backend', kind: 'info', body: 'after you typed' });
  await until(() => a.sent.length === AUTO_TURN_LIMIT + 2);
  assert.equal(a.sent.at(-1)!.options.triggerTurn, true);
});

test('the panel lists every team with its members, and the timeline in detail', async () => {
  const { teamPanelSpec } = await import('../src/team/panel.ts');
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  const shop = {
    team: 'shop',
    mates: [
      { role: 'backend', online: true, cwd: '/w/b', self: false, activity: { state: 'working' as const, since: '2026-09-23T11:57:00.000Z', focus: 'Implement login' } },
      { role: 'reviewer', online: true, cwd: '/w/r', self: true, activity: { state: 'idle' as const, since: '2026-09-23T11:59:50.000Z' } },
      { role: 'docs', online: false, cwd: '/w/d', self: false },
    ],
    events: [
      { at: '2026-09-23T11:57:00.000Z', type: 'working' as const, role: 'backend', text: 'Implement login' },
      { at: '2026-09-23T11:58:00.000Z', type: 'message' as const, role: 'reviewer', to: 'backend', kind: 'question' as const, text: 'Which code?' },
      { at: '2026-09-23T11:59:00.000Z', type: 'refused' as const, role: 'reviewer', to: 'docs', kind: 'info' as const, text: 'offline' },
    ],
  };
  const other = { team: 'infra', mates: [{ role: 'ops', online: true, cwd: '/w/o', self: false }], events: [] };
  const snapshot = { joined: { team: 'shop', role: 'reviewer' }, teams: [shop, other] };
  const requests: unknown[] = [];
  const spec = teamPanelSpec({ load: async () => snapshot, request: intent => requests.push(intent), leave: async () => 'Left team shop.', now: () => now }, snapshot);
  assert.match(spec.summary!(), /you are reviewer in shop · 2 teams/);
  const items = spec.items();
  assert.deepEqual(items.map(item => [item.label, item.meta]), [
    ['shop', '2/3 online · 1 working · you'], ['  backend', 'working 3m'], ['  reviewer (you)', 'idle 10s'], ['  docs', 'offline'],
    ['infra', '1/1 online'], ['  ops', 'online'],
  ]);
  const team = spec.detail(items[0]!);
  const timeline = team.sections!.find(section => section.title.startsWith('Timeline'))!.lines;
  assert.equal(timeline.length, 3);
  assert.match(timeline[0]!, /reviewer → docs info refused \(offline\)/);
  assert.match(timeline[1]!, /reviewer → backend question: Which code\?/);
  assert.match(timeline[2]!, /backend working · Implement login/);
  const backend = spec.detail(items[1]!);
  assert.equal(backend.fields![0]!.value, 'Implement login');
  assert.equal(backend.sections![0]!.lines.length, 2, 'Only what involves backend');

  const control = { close() {}, refresh() {}, notice() {}, select() {} };
  const key = (k: string) => spec.actions!.find(action => action.key === k)!;
  assert.equal(key('m').when!(items[1]), true);
  assert.equal(key('m').when!(items[2]), false, 'Not to yourself');
  assert.equal(key('m').when!(items[3]), false, 'Not to someone offline');
  assert.equal(key('m').when!(items[5]), false, 'Not into a team you are not in');
  assert.equal(key('a').when!(items[0]), false, 'Already in shop');
  assert.equal(key('a').when!(items[4]), true);
  await key('m').run(items[1], control);
  await key('a').run(items[4], control);
  await key('n').run(undefined, control);
  assert.deepEqual(requests, [{ action: 'message', team: 'shop', role: 'backend' }, { action: 'join', team: 'infra' }, { action: 'create' }]);
});

test('the team timeline records joins, work, messages, refusals and leaves', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  await a.emit('before_agent_start', { prompt: 'Implement login', systemPrompt: 'base' });
  await b.tool('team_message', { to: 'backend', kind: 'question', body: 'Which code?' });
  await b.tool('team_message', { to: 'docs', kind: 'info', body: 'hi' }).catch(() => {});
  await a.command('leave');
  const { TeamSession } = await import('../src/team/session.ts');
  const { TeamRuntime } = await import('../src/runtime/team-runtime.ts');
  const { TeamPaths } = await import('../src/storage/paths.ts');
  const reader = new TeamSession(new TeamRuntime(new TeamPaths(a.root)));
  const seen = { types: [] as string[] };
  await until(() => seen.types.includes('left'), 2000, async () => {
    seen.types = (await reader.events('shop')).map(event => `${event.type}`);
  });
  const events = await reader.events('shop');
  assert.deepEqual(events.map(event => [event.type, event.role, event.to ?? '']), [
    ['joined', 'backend', ''], ['joined', 'reviewer', ''], ['working', 'backend', ''],
    ['message', 'reviewer', 'backend'], ['refused', 'reviewer', 'docs'], ['left', 'backend', ''],
  ]);
});

test('from the panel: create a team, then message a teammate, with typed input', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await b.command('join shop reviewer');
  const answers = ['infra', 'ops'];
  const panels: any[] = [];
  const custom = (factory: any) => new Promise(resolve => {
    const tui = { requestRender() {}, terminal: { rows: 30, columns: 120 } };
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    panels.push(factory(tui, theme, {}, resolve));
  });
  await a.commandWith('', { mode: 'tui', ui: { custom, input: async () => answers.shift() } });
  await until(() => panels.length === 1);
  panels[0].handleInput('n');
  await until(() => panels.length === 2);
  assert.equal(a.status.text, 'team infra · ops');
  assert.match(a.notices.join('\n'), /Created and joined team infra as ops/);
});
test('/team opens the docked panel in the TUI', async (t) => {
  const make = await setup(t);
  const a = await make('s-a');
  await a.command('join shop backend');
  const opened: unknown[] = [];
  await a.commandWith('', { mode: 'tui', ui: { custom: (factory: unknown) => { opened.push(factory); return new Promise(() => {}); } } });
  await until(() => opened.length === 1);
});
