import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installTeam, type InstallTeamOptions } from '../src/index.ts';
import { parseTeamCommand } from '../src/commands/team-command.ts';
import { SYMBOL } from '@prjct.app/pi-tui-kit';

type Sent = { readonly content: string; readonly options: { readonly triggerTurn?: boolean; readonly deliverAs?: string } };

/** One simulated Pi terminal over a shared store. */
function terminal(root: string, sessionId: string, entries: unknown[] = [], now: () => number = Date.now, extra: Partial<InstallTeamOptions> = {}) {
  const handlers = new Map<string, any>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
  const active: string[] = ['read', 'bash']; const notices: string[] = []; const sent: Sent[] = []; const identities: Sent[] = []; const status = { text: undefined as string | undefined };
  const idle = { value: true };
  const confirms = { answer: true };
  const ctx = {
    cwd: `/work/${sessionId}`, hasUI: true, isIdle: () => idle.value,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    ui: {
      notify: (s: string) => notices.push(s), confirm: async () => confirms.answer, theme: { fg: (_c: string, s: string) => s }, setWidget() {},
      setStatus: (k: string, t: string | undefined) => { if (k === 'mode:team') status.text = t?.replace(`${SYMBOL.mode} `, ''); },
    },
  };
  const api = {
    on: (n: string, h: any) => handlers.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c),
    registerTool: (t: any) => { tools.set(t.name, t); active.push(t.name); }, getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
    sendMessage: (m: any, options: any) => (m.customType === 'team-identity' ? identities : sent).push({ content: m.content, options }),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;
  installTeam(api, { root, pollMs: 10, heartbeatMs: 100, now, complete: async (_s, user) => user, ...extra });
  return {
    active, notices, sent, identities, status, idle, entries, tools, root, confirms,
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
  const make = async (session: string, entries: unknown[] = [], now?: () => number, extra: Partial<InstallTeamOptions> = {}) => {
    const term = terminal(root, session, entries, now, extra); open.push(term); await term.emit('session_start', { reason: 'startup' }); return term;
  };
  t.after(async () => {
    for (const term of open) await term.emit('session_shutdown', { reason: 'quit' });
    await rm(root, { recursive: true, force: true });
  });
  return make;
}

async function until(check: () => boolean, ms = 10_000, refresh?: () => Promise<void>): Promise<void> {
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

  // The role is one persisted message per change, never a per-turn system-prompt edit.
  assert.equal(await a.emit('before_agent_start', { prompt: 'Implement the login endpoint', systemPrompt: 'base' }), undefined);
  const identity = a.identities.filter(m => /You are "backend" in team "shop"/.test(String(m.content)));
  assert.equal(identity.length, 1);
  assert.deepEqual(identity[0]!.options, { triggerTurn: false, deliverAs: 'followUp' });
  // Activity is written by backend's own terminal; reviewer sees it once it lands.
  const seen = { text: '' };
  await until(() => /◆ backend {2}working \d+s · Implement the login endpoint/.test(seen.text), 2000, async () => {
    seen.text = (await b.tool('team_peers', {})).content[0].text;
  });

  // Busy recipient: steered into the running work, never parked in a queue.
  a.idle.value = false;
  await b.tool('team_message', { to: 'backend', kind: 'question', body: 'Which status code for a bad password?' });
  await until(() => a.sent.length === 1);
  assert.match(a.sent[0]!.content, /Team message from reviewer \(question/);
  assert.deepEqual(a.sent[0]!.options, { triggerTurn: true, deliverAs: 'steer' });

  // Idle recipient: a question opens a turn.
  await a.tool('team_message', { to: 'reviewer', kind: 'question', body: 'Is 401 right for src/auth.ts?' });
  await until(() => b.sent.length === 1);
  assert.deepEqual(b.sent[0]!.options, { triggerTurn: true, deliverAs: 'followUp' });

  // Idle recipient: information also opens a turn without human input.
  await a.tool('team_message', { to: 'reviewer', kind: 'info', body: '401, see src/auth.ts' });
  await until(() => b.sent.length === 2);
  assert.match(b.sent[1]!.content, /Team message from backend \(info/);
  assert.deepEqual(b.sent[1]!.options, { triggerTurn: true, deliverAs: 'followUp' });
});

test('answers and findings wake autonomous work beyond the former limit', async t => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  for (const index of Array.from({ length: 10 }, (_, i) => i)) {
    await b.tool('team_message', { to: 'backend', kind: 'info', body: `finding ${index}` });
    await until(() => a.sent.length === index + 1);
  }
  assert.ok(a.sent.every(message => message.options.triggerTurn));
  await b.tool('team_message', { to: 'backend', kind: 'handoff', body: 'Please own the retry fix.' });
  await until(() => a.sent.length === 11);
  assert.deepEqual(a.sent.at(-1)!.options, { triggerTurn: true, deliverAs: 'followUp' });
  a.idle.value = false;
  await b.tool('team_message', { to: 'backend', kind: 'info', body: 'The repro is in tests/retry.ts.' });
  await until(() => a.sent.length === 12);
  assert.deepEqual(a.sent.at(-1)!.options, { triggerTurn: true, deliverAs: 'steer' });
});

test('a long message is delivered whole and the model sees no length budget to squeeze into', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  const tool = b.tools.get('team_message');
  assert.equal(tool.parameters.properties.body.maxLength, undefined);
  assert.match(tool.description, /normal spacing/);
  assert.match(tool.description, /Never send progress updates or check-ins/);
  const body = 'The login endpoint returns 401 for a bad password and 423 after five failures. '.repeat(120);
  assert.ok(body.length > 8_000);
  await b.tool('team_message', { to: 'backend', kind: 'info', body });
  await until(() => a.sent.length === 1);
  assert.ok(a.sent[0]!.content.includes(body.trim()));
});

test('a kind the model made up is read as ours instead of failing the send', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  const tool = b.tools.get('team_message');
  assert.deepEqual(tool.prepareArguments({ to: 'backend', kind: 'answer', body: 'yes' }), { to: 'backend', kind: 'info', body: 'yes' });
  assert.deepEqual(tool.prepareArguments({ to: 'backend', kind: 'Request', body: 'take T1' }), { to: 'backend', kind: 'handoff', body: 'take T1' });
  const valid = { to: 'backend', kind: 'question', body: 'why?' };
  assert.equal(tool.prepareArguments(valid), valid);
});

test('an offline or unknown teammate fails now instead of queuing', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  await b.command('leave');
  assert.equal(b.status.text, undefined);
  assert.ok(!b.active.includes('team_message'));
  // A role that left is gone from the team, so there is no one to send to.
  await assert.rejects(a.tool('team_message', { to: 'reviewer', kind: 'info', body: 'hi' }), /No "reviewer"/);
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
  assert.match(b.last(), /"backend" is online in another terminal \(\/work\/s-a\)/);
  await b.command('join shop docs');
  await b.command('send backend Please rebase on main');
  await until(() => a.sent.length === 1);
  assert.match(a.sent[0]!.content, /From the person at this terminal: Please rebase on main/);
  await a.command('');
  assert.match(a.last(), /team shop · you are backend\n◇ backend \(you\)[^\n]*\n○ docs/);
});

test('reload keeps the role: it is released on shutdown and taken back on start', async (t) => {
  const make = await setup(t);
  const entries: unknown[] = [];
  const a = await make('s-a', entries);
  await a.command('join shop backend');
  await a.emit('session_shutdown', { reason: 'reload' });
  assert.equal(a.status.text, undefined, 'The mode line clears with the old session');
  const again = await make('s-a', entries);
  assert.equal(again.status.text, 'team shop · backend');
  assert.ok(again.active.includes('team_message'));
  await again.command('leave');
  const third = await make('s-a', entries);
  assert.equal(third.status.text, undefined, 'An explicit leave is remembered');
});

test('questions and handoffs never wait for a wake window or user input', async t => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  for (const index of Array.from({ length: 12 }, (_, i) => i)) {
    await b.tool('team_message', { to: 'backend', kind: index % 2 ? 'question' : 'handoff', body: `work ${index}` });
    await until(() => a.sent.length === index + 1);
  }
  assert.ok(a.sent.every(s => s.options.triggerTurn && s.options.deliverAs === 'followUp'));
  assert.ok(!a.notices.some(n => /window|wait.*type/.test(n)));
  a.idle.value = false;
  await b.tool('team_message', { to: 'backend', kind: 'info', body: 'The dependency is ready.' });
  await until(() => a.sent.length === 13);
  assert.deepEqual(a.sent.at(-1)!.options, { triggerTurn: true, deliverAs: 'steer' });
});

test('the panel lists every team with its members, and the timeline in detail', async () => {
  const { teamPanelSpec } = await import('../src/team/panel.ts');
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  const shop = {
    id: 't-shop', name: 'shop',
    mates: [
      { id: 'm-b', role: 'backend', online: true, cwd: '/w/b', self: false, admin: false, activity: { state: 'working' as const, since: '2026-09-23T11:57:00.000Z', focus: 'Implement login' } },
      { id: 'm-r', role: 'reviewer', online: true, cwd: '/w/r', self: true, admin: true, activity: { state: 'idle' as const, since: '2026-09-23T11:59:50.000Z' } },
      { id: 'm-d', role: 'docs', online: false, cwd: '/w/d', self: false, admin: false },
    ],
    events: [
      { at: '2026-09-23T11:57:00.000Z', type: 'working' as const, byId: 'm-b', role: 'backend', text: 'Implement login' },
      { at: '2026-09-23T11:58:00.000Z', type: 'message' as const, byId: 'm-r', role: 'reviewer', toId: 'm-b', to: 'backend', kind: 'question' as const, text: 'Which code?' },
      { at: '2026-09-23T11:59:00.000Z', type: 'refused' as const, byId: 'm-r', role: 'reviewer', toId: 'm-d', to: 'docs', kind: 'info' as const, text: 'offline' },
    ],
  };
  const other = { id: 't-infra', name: 'infra', mates: [{ id: 'm-o', role: 'ops', online: true, cwd: '/w/o', self: false, admin: true }], events: [] };
  const snapshot = { joined: { teamId: 't-shop', memberId: 'm-r', team: 'shop', role: 'reviewer' }, teams: [shop, other] };
  const requests: unknown[] = [];
  const spec = teamPanelSpec({ load: async () => snapshot, request: intent => requests.push(intent), now: () => now }, snapshot);
  assert.match(spec.summary!(), /you are reviewer in shop · 2 teams/);
  const items = spec.items();
  assert.deepEqual(items.map(item => [item.label, item.meta]), [
    ['shop', '2/3 online · 1 working · you'], ['  backend', 'working 3m'], ['  reviewer (you)', 'idle 10s'], ['  docs', 'offline'],
    ['infra', '1/1 online'], ['  ops', 'online'],
  ]);
  // Shape says what a row is: squares are teams, diamonds the admin, dots members.
  assert.deepEqual(items.map(item => item.symbol), ['■', '●', '◇', '○', '■', '◇']);
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
  const notices: string[] = [];
  const noting = { ...control, notice: (text: string) => { notices.push(text); } };
  assert.equal(key('m').when!(items[1]), true, 'Always offered on a member row');
  assert.equal(key('m').when!(items[0]), false, 'Not on a team row');
  await key('m').run(items[2], noting);
  await key('m').run(items[3], noting);
  await key('m').run(items[5], noting);
  assert.deepEqual(notices, ['That is you.', 'docs is offline; nothing would be delivered. Press a to join as docs.', 'Join infra first to message its members: select infra and press a.']);
  assert.equal(spec.activate!.when!(items[1]), true, 'Enter on a member messages it');
  assert.equal(key('a').when!(items[0]), false, 'Already in shop');
  assert.equal(key('a').when!(items[4]), true);
  assert.equal(key('a').when!(items[3]), true, 'An offline role can be joined as');
  assert.equal(key('a').when!(items[1]), false, 'An online role cannot');
  await key('m').run(items[1], control);
  await key('a').run(items[4], control);
  await key('a').run(items[3], control);
  await key('n').run(undefined, control);
  assert.equal(key('x').when!(items[1]), true, 'The admin may remove a member');
  assert.equal(key('x').when!(items[2]), false, 'Not yourself');
  assert.equal(key('x').when!(items[5]), false, 'Not in a team you are not in');
  assert.equal(key('d').when!(items[0]), true, 'The admin may delete its team');
  assert.equal(key('d').when!(items[4]), false);
  assert.equal(key('l').when!(items[0]), true);
  await key('x').run(items[1], control);
  await key('l').run(items[0], control);
  await key('d').run(items[0], control);
  assert.equal(key('r').when!(items[0]), true, 'The admin renames its team');
  assert.equal(key('r').when!(items[1]), true, 'The admin renames a member');
  assert.equal(key('r').when!(items[4]), false, 'Not a team you are not in');
  await key('r').run(items[0], control);
  await key('r').run(items[1], control);
  assert.deepEqual(requests, [
    { action: 'message', teamId: 't-shop', memberId: 'm-b', role: 'backend' }, { action: 'join', teamId: 't-infra', team: 'infra' },
    { action: 'take', teamId: 't-shop', team: 'shop', memberId: 'm-d', role: 'docs' }, { action: 'create' },
    { action: 'remove', teamId: 't-shop', memberId: 'm-b', role: 'backend' }, { action: 'leave', teamId: 't-shop', team: 'shop' }, { action: 'delete', teamId: 't-shop', team: 'shop' },
    { action: 'rename-team', teamId: 't-shop', team: 'shop' }, { action: 'rename-member', teamId: 't-shop', memberId: 'm-b', role: 'backend' },
  ]);
  const notAdmin = teamPanelSpec({ load: async () => snapshot, request() {}, now: () => now },
    { joined: { teamId: 't-shop', memberId: 'm-b', team: 'shop', role: 'backend' }, teams: [{ ...shop, mates: shop.mates.map(mate => ({ ...mate, self: mate.role === 'backend' })) }] });
  const byBackend = notAdmin.items();
  const on = (k: string) => notAdmin.actions!.find(action => action.key === k)!;
  assert.equal(on('x').when!(byBackend[3]), true, 'Anyone clears an offline role');
  assert.equal(on('x').when!(byBackend[2]), false, 'An online admin is not removed by a member');
  const withOnlineDocs = teamPanelSpec({ load: async () => snapshot, request() {}, now: () => now },
    { joined: { teamId: 't-shop', memberId: 'm-b', team: 'shop', role: 'backend' }, teams: [{ ...shop, mates: shop.mates.map(mate => ({ ...mate, self: mate.role === 'backend', online: true })) }] });
  assert.equal(withOnlineDocs.actions!.find(action => action.key === 'x')!.when!(withOnlineDocs.items()[3]), false, 'Only the admin removes an online role');
  assert.equal(on('d').when!(byBackend[0]), false, 'Only the admin deletes');
  assert.equal(on('r').when!(byBackend[0]), false, 'Only the admin renames the team');
  assert.equal(on('r').when!(byBackend[1]), true, 'A member renames itself');
  assert.equal(on('r').when!(byBackend[3]), false, 'But not others');
});

test('the team timeline records joins, work, messages, refusals and leaves', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  await a.emit('before_agent_start', { prompt: 'Implement login', systemPrompt: 'base' });
  const { TeamSession } = await import('../src/team/session.ts');
  const { TeamRuntime } = await import('../src/runtime/team-runtime.ts');
  const { TeamPaths } = await import('../src/storage/paths.ts');
  const reader = new TeamSession(new TeamRuntime(new TeamPaths(a.root)));
  const seen = { types: [] as string[] };
  // Each terminal writes its own events; wait for backend's before reviewer acts, so the order is fixed.
  const shopId = (await reader.findTeam('shop'))!;
  assert.match(shopId, /^t-[0-9a-f-]{36}$/, 'Teams are stored by UUID, not by name');
  await until(() => seen.types.includes('working'), 2000, async () => { seen.types = (await reader.events(shopId)).map(event => event.type); });
  await b.tool('team_message', { to: 'backend', kind: 'question', body: 'Which code?' });
  await b.tool('team_message', { to: 'docs', kind: 'info', body: 'hi' }).catch(() => {});
  await a.command('leave');
  await until(() => seen.types.includes('left'), 2000, async () => {
    seen.types = (await reader.events(shopId)).map(event => `${event.type}`);
  });
  const events = await reader.events(shopId);
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

test('leave asks first; declining keeps the terminal in the team', async (t) => {
  const make = await setup(t);
  const a = await make('s-a');
  await a.command('join shop backend');
  a.confirms.answer = false;
  await a.command('leave');
  assert.equal(a.status.text, 'team shop · backend');
  a.confirms.answer = true;
  await a.command('leave');
  assert.equal(a.status.text, undefined);
});

test('the admin removes a member; that terminal is told and leaves', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b'); const c = await make('s-c');
  await a.command('join shop backend'); await b.command('join shop reviewer'); await c.command('join shop docs');
  await b.command('remove docs');
  assert.match(b.last(), /docs is online; only the admin can remove it/);
  await a.command('remove docs');
  assert.match(a.last(), /Removed docs from shop/);
  // The status clears first; the reason follows once the timeline is read.
  await until(() => c.notices.some(n => /You were removed from shop by backend/.test(n)));
  assert.equal(c.status.text, undefined);
  assert.ok(!c.active.includes('team_message'));
  await a.command('');
  assert.doesNotMatch(a.last(), /docs/, 'A removed role is gone from the team');
});

test('the admin deletes its team; every other terminal is told', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  await b.command('delete');
  assert.match(b.last(), /Only the admin/);
  await a.command('delete');
  assert.match(a.last(), /Deleted team shop/);
  assert.equal(a.status.text, undefined);
  await until(() => b.notices.some(n => /Team shop was deleted/.test(n)));
  assert.equal(b.status.text, undefined);
  await new Promise(resolve => setTimeout(resolve, 80));
  await a.command('');
  assert.doesNotMatch(a.last(), /shop/, 'A deleted team is not brought back by a late write');
});

test('renames keep identity: the team and a role get new names, the trace and connection stay', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  await b.command('rename store');
  assert.match(b.last(), /Only the admin of shop \(backend\)/);
  a.confirms.answer = false;
  await a.command('rename store');
  assert.equal(a.status.text, 'team shop · backend', 'Declined: nothing renamed');
  a.confirms.answer = true;
  await a.command('rename store');
  assert.equal(a.status.text, 'team store · backend');
  await a.command('rename-role reviewer qa');
  assert.match(a.last(), /Renamed reviewer to qa/);
  // The renamed terminal stays connected and learns its new names.
  await until(() => b.status.text === 'team store · qa');
  assert.ok(b.notices.some(n => /you are now qa in store/.test(n)));
  await a.tool('team_message', { to: 'qa', kind: 'info', body: 'hello qa' });
  await until(() => b.sent.length === 1);
  await b.command('rename-role qa tester');
  assert.equal(b.status.text, 'team store · tester', 'A member renames itself');
  await b.command('rename-role backend boss');
  assert.match(b.last(), /Only the admin/);
  await b.command('join store other').catch(() => {});
  await b.command('join shop x');
  assert.match(b.last(), /Created and joined team shop/, 'The old name is free again, as a new team');
});

test('every destructive action asks first; declining changes nothing', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop reviewer');
  a.confirms.answer = false;
  await a.command('remove reviewer');
  await a.command('delete');
  await a.command('rename-role reviewer qa');
  await a.command('leave');
  assert.equal(a.status.text, 'team shop · backend');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(b.status.text, 'team shop · reviewer');
});

test('reload rejoins by ID, even after the role was renamed while away', async (t) => {
  const make = await setup(t);
  const entries: unknown[] = [];
  const admin = await make('s-admin');
  await admin.command('join shop lead');
  const a = await make('s-a', entries);
  await a.command('join shop backend');
  await a.emit('session_shutdown', { reason: 'reload' });
  await admin.command('rename-role backend api');
  const again = await make('s-a', entries);
  assert.equal(again.status.text, 'team shop · api');
});

test('the role reaches the model once per change and leaving says so', async (t) => {
  const make = await setup(t);
  const a = await make('s-id');
  await a.command('join shop backend');
  await a.emit('before_agent_start', { prompt: 'one', systemPrompt: 'base' });
  await a.emit('before_agent_start', { prompt: 'two', systemPrompt: 'base' });
  assert.equal(a.identities.length, 1, 'turns do not repeat it');
  await a.command('leave');
  assert.match(a.identities.at(-1)!.content, /no longer in a team/);
  assert.ok(a.identities.every(m => m.options.triggerTurn === false && m.options.deliverAs === 'followUp'));
});

test('a machine that slept keeps its role: a lapsed lease nobody took is taken back', async (t) => {
  const make = await setup(t);
  const clock = { skew: 0 };
  const a = await make('s-a', [], () => Date.now() + clock.skew);
  await a.command('join shop backend');
  clock.skew = 5 * 60_000;
  const b = await make('s-b', [], () => Date.now() + clock.skew);
  await b.command('join shop reviewer');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(!a.notices.some(n => /took the role|left shop/.test(n)), a.notices.join('\n'));
  assert.equal(a.status.text, 'team shop · backend');
  await b.tool('team_message', { to: 'backend', kind: 'info', body: 'still there?' });
  await until(() => a.sent.length === 1);
});

test('a role belongs to its session: closed, it comes back; nobody gets it without confirming', async (t) => {
  const make = await setup(t);
  const entries: unknown[] = [];
  const a = await make('s-a', entries);
  await a.command('join shop backend');
  const b = await make('s-b');
  await b.command('join shop backend');
  assert.match(b.last(), /online in another terminal/, 'An online role is never taken');
  await a.emit('session_shutdown', { reason: 'quit' });
  b.confirms.answer = false;
  await b.command('join shop backend');
  assert.equal(b.last(), 'Nothing joined.');
  const again = await make('s-a', entries);
  assert.equal(again.status.text, 'team shop · backend', 'The owner takes it back on resume');
  assert.ok(!again.notices.some(n => /could not rejoin/.test(n)), again.notices.join('\n'));
});

test('an offline role is taken over after confirming; the old session is told once and never lingers', async (t) => {
  const make = await setup(t);
  const entries: unknown[] = [];
  const a = await make('s-a', entries);
  await a.command('join shop backend');
  await a.emit('session_shutdown', { reason: 'quit' });
  const b = await make('s-b');
  await b.command('join shop backend');
  assert.match(b.last(), /Took over backend in team shop/);
  assert.equal(b.status.text, 'team shop · backend');
  const old = await make('s-a', entries);
  assert.equal(old.status.text, undefined);
  assert.match(old.last(), /no longer in shop\. backend in shop now belongs to another Pi session \(\/work\/s-b\)/);
  const later = await make('s-a', entries);
  assert.deepEqual(later.notices, [], 'It does not try again');
});

test('a terminal taken over while it slept is told who has the role now', async (t) => {
  const make = await setup(t);
  const a = await make('s-a');
  await a.command('join shop backend');
  // Seen from b, a has been asleep for five minutes.
  const b = await make('s-b', [], () => Date.now() + 5 * 60_000);
  await b.command('join shop backend');
  assert.match(b.last(), /Took over backend/);
  await until(() => a.notices.some(n => /backend in shop was taken over by the Pi session in \/work\/s-b/.test(n)));
  assert.equal(a.status.text, undefined);
});

test('an explicit leave frees the role for another session', async (t) => {
  const make = await setup(t);
  const a = await make('s-a');
  await a.command('join shop backend');
  await a.command('leave');
  const b = await make('s-b');
  await b.command('join shop backend');
  assert.equal(b.status.text, 'team shop · backend');
});

test('a fork carries the role forward from the session it replaces', async (t) => {
  const make = await setup(t);
  const entries: unknown[] = [];
  const a = await make('s-a', entries);
  await a.command('join shop backend');
  await a.emit('session_shutdown', { reason: 'fork' });
  // Not made through setup: shut down here, before setup's cleanup removes the store under its poll.
  const forked = terminal(a.root, 's-fork', [...entries]);
  try {
    await forked.emit('session_start', { reason: 'fork' });
    assert.equal(forked.status.text, 'team shop · backend');
    const back = await make('s-a', entries);
    assert.match(back.notices.join('\n'), /belongs to another Pi session/, 'The role moved to the fork');
  } finally {
    await forked.emit('session_shutdown', { reason: 'quit' });
  }
});


test('an offline admin can be removed; the longest-standing member becomes admin', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend'); await b.command('join shop docs');
  await a.emit('session_shutdown', { reason: 'quit' });
  await b.command('remove backend');
  assert.match(b.last(), /Removed backend from shop/);
  await b.command('rename store');
  assert.match(b.last(), /Renamed team shop to store/, 'docs is the admin now');
});

test('a team nobody is online in can be deleted by anyone; a live one only by its admin', async (t) => {
  const make = await setup(t);
  const a = await make('s-a'); const b = await make('s-b');
  await a.command('join shop backend');
  const panels: any[] = [];
  const custom = (factory: any) => new Promise(resolve => {
    const tui = { requestRender() {}, terminal: { rows: 30, columns: 120 } };
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    panels.push(factory(tui, theme, {}, resolve));
  });
  await b.commandWith('', { mode: 'tui', ui: { custom } });
  await until(() => panels.length === 1);
  panels[0].handleInput('d');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(panels.length, 1, 'Not offered while backend is online');
  await a.emit('session_shutdown', { reason: 'quit' });
  // The open panel refreshes every second.
  await until(() => panels[0].render(120).join('\n').includes('0/1 online'), 3000);
  panels[0].handleInput('d');
  await until(() => panels.length === 2);
  assert.match(b.notices.join('\n'), /Deleted team shop/);
});
