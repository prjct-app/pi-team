import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { harness, until } from './harness.ts';

test('Pi commands connect peers; a request waits while working, typing, or showing a dialog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const pm = harness(root, 'pm');
  const be = harness(root, 'backend');
  t.after(async () => {
    await pm.emit('session_shutdown'); await be.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop');
  await pm.command('join shop pm'); await be.command('join shop backend');
  be.busy(true);
  await pm.command('send backend Implement login');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(be.received.length, 0);
  be.editor('My unfinished prompt'); be.busy(false);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(be.received.length, 0);
  await be.emit('ui_prompt_start'); be.editor('');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(be.received.length, 0);
  await be.emit('ui_prompt_end');
  await until(() => be.received.length === 1);
  assert.match(be.received[0].content, /another agent, not the user/);
  assert.match(be.received[0].content, /Implement login/);
  await be.emit('tool_result', { toolName: 'edit', input: { path: 'src/login.ts' }, isError: false });
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [
    { type: 'thinking', thinking: 'Private reasoning must not be sent' },
    { type: 'text', text: 'Login ready. Tests: npm test passed.' },
  ] } });
  be.busy(false); await be.emit('agent_settled');
  await until(() => pm.received.length === 1);
  assert.match(pm.received[0].content, /Login ready/);
  assert.match(pm.received[0].content, /src\/login.ts/);
  assert.doesNotMatch(pm.received[0].content, /Private reasoning/);
});

test('leaving defers until the current result is returned, without starting queued work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  await pm.command('send backend First task');
  await until(() => be.received.length === 1);
  await be.command('leave');
  await pm.command('send backend Second task');
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'First task finished' }] } });
  be.busy(false); await be.emit('agent_settled');
  await until(() => pm.received.length === 1);
  assert.match(pm.received[0].content, /First task finished/);
  assert.equal(be.received.length, 1);
  await pm.command('members');
  assert.ok(pm.notices.some(n => /backend · offline/.test(n)));
  await be.command('join shop backend');
  await until(() => be.received.length === 2);
  assert.match(be.received[1].content, /Second task/);
});

test('an aborted task pauses reception, and a result does not cause an automatic reply loop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  await pm.command('send backend First task'); await until(() => be.received.length === 1);
  await pm.command('send backend Second task');
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'aborted', content: [] } });
  be.busy(false); await be.emit('agent_settled');
  await until(() => pm.received.length === 1);
  await pm.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Task was interrupted' }] } });
  pm.busy(false); await pm.emit('agent_settled');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(be.received.length, 1);
  await be.command('resume'); await until(() => be.received.length === 2);
  assert.match(be.received[1].content, /Second task/);
});

test('automatic work pauses after five turns and requires an explicit resume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  pm.busy(true); be.busy(true);
  for (let i = 0; i < 6; i++) await pm.command(`send backend Task ${i}`);
  be.busy(false);
  for (let i = 0; i < 5; i++) {
    await until(() => be.received.length === i + 1);
    await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Finished' }] } });
    be.busy(false); await be.emit('agent_settled');
  }
  await until(() => be.notices.some(n => /auto-turn limit/.test(n)));
  assert.equal(be.received.length, 5);
  await be.command('resume'); await until(() => be.received.length === 6);
});

test('user takeover does not forward unrelated user work as a peer result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  await pm.command('send backend Implement login'); await until(() => be.received.length === 1);
  await be.emit('input', { source: 'interactive', text: 'Stop that, work on my private note instead.' });
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Private note contents' }] } });
  be.busy(false); await be.emit('agent_settled');
  await until(() => pm.received.length === 1);
  assert.doesNotMatch(pm.received[0].content, /Private note contents/);
  assert.match(pm.received[0].content, /User took over/);
});

test('reload restores the same paused membership but a fork does not inherit it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const original = harness(root, 'session');
  await original.emit('session_start'); await original.command('create shop'); await original.command('join shop backend');
  await original.command('pause'); await original.emit('session_shutdown', { reason: 'reload' });
  const resumed = harness(root, 'session', original.entries);
  const fork = harness(root, 'fork-session', original.entries);
  t.after(async () => { await resumed.emit('session_shutdown'); await fork.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await resumed.emit('session_start', { reason: 'reload' });
  await resumed.command('members');
  assert.ok(resumed.notices.some(n => /backend/.test(n)));
  const membership = resumed.entries.filter(e => e.customType === 'team-membership').at(-1).data;
  assert.equal(membership.paused, true);
  await fork.emit('session_start', { reason: 'fork' }); await fork.command('members');
  assert.ok(fork.notices.some(n => /Join a team first/.test(n)));
});

test('message previews are one line and details expand without emitting terminal escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const h = harness(root, 'session');
  t.after(() => rm(root, { recursive: true, force: true }));
  const render = h.renderers.get('team-event');
  const event = { data: { from: 'pm', to: 'backend', kind: 'request', state: 'pending', subject: 'API\ncontract', body: '\x1b]0;Malicious title\x07Full details here' } };
  const collapsed = render(event, { expanded: false }).render(40);
  assert.equal(collapsed.length, 1);
  assert.doesNotMatch(collapsed[0], /\n|\x1b\]/);
  const { visibleWidth } = await import('@earendil-works/pi-tui');
  assert.ok(visibleWidth(collapsed[0]) <= 40);
  const expanded = render(event, { expanded: true }).render(80).join('\n');
  assert.match(expanded, /Full details here/);
  assert.doesNotMatch(expanded, /Malicious title/);
});

test('explicit leave detaches locally even when the old team storage is unavailable', async (t) => {
  const { rename } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const h = harness(root, 'session');
  t.after(async () => { await h.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await h.emit('session_start'); await h.command('create old'); await h.command('join old pm');
  await rename(join(root, 'old'), join(root, 'archived'));
  await h.command('leave'); await h.command('create next'); await h.command('join next pm');
  assert.ok(h.notices.some(n => /Joined next as pm/.test(n)));
});

test('a session without a selected model leaves work queued rather than claiming it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  be.modelAvailable(false);
  await pm.command('send backend Implement login');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(be.received.length, 0);
  be.modelAvailable(true); await until(() => be.received.length === 1);
});

test('a successfully reported task does not leave restoration unnecessarily paused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-clean-resume-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'backend');
  let resumed: ReturnType<typeof harness> | undefined;
  t.after(async () => {
    await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await resumed?.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  await pm.command('send backend First task'); await until(() => be.received.length === 1);
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] } });
  be.busy(false); await be.emit('agent_settled');
  await be.emit('session_shutdown');
  await pm.command('send backend Pending task');
  resumed = harness(root, 'backend', be.entries);
  await resumed.emit('session_start', { reason: 'startup' });
  await until(() => resumed!.received.length === 1);
  assert.match(resumed.received[0].content, /Pending task/);
});

test('aging emitted requests trigger review turns that quiet down without progress', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-review-'));
  const pm = harness(root, 'pm', [], { reviewMs: 40, agingMs: 0 });
  const be = harness(root, 'backend');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  be.busy(true); // The request stays pending; nothing settles it.
  await pm.command('send backend Build the API');
  const reviews = () => pm.received.filter(m => m.customType === 'team-review');
  await until(() => reviews().length === 1);
  assert.match(reviews()[0].content, /not a user message/);
  assert.match(reviews()[0].content, /Build the API/);
  assert.match(reviews()[0].content, /team_status/);
  pm.busy(false); await until(() => reviews().length === 2);
  pm.busy(false); await until(() => reviews().length === 3);
  pm.busy(false);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(reviews().length, 3, 'Reviews quiet down while the mailbox does not change');
});

test('team_status reports outstanding work and results carry the original request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-status-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'backend');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  const status = async (h: ReturnType<typeof harness>) =>
    JSON.parse((await h.tools.get('team_status').execute('call', {}, undefined, undefined, undefined)).content[0].text);
  be.busy(true);
  await pm.command('send backend Implement login endpoint');
  await until(async () => (await status(pm)).emittedUnresolved.length === 1);
  let view = await status(pm);
  assert.equal(view.emittedUnresolved[0].subject, 'Implement login endpoint');
  assert.equal(view.emittedUnresolved[0].state, 'pending');
  view = await status(be);
  assert.equal(view.queuedForYou.length, 1);
  be.busy(false);
  await until(() => be.received.length === 1);
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Login done' }] } });
  be.busy(false); await be.emit('agent_settled');
  await until(() => pm.received.length === 1);
  assert.match(pm.received[0].content, /Original request you emitted/);
  assert.match(pm.received[0].content, /Implement login endpoint/);
  view = await status(pm);
  assert.equal(view.emittedUnresolved.length, 0, 'A completed request is no longer outstanding');
});

test('a temporarily missing mailbox record notifies but never pauses reception', async (t) => {
  const { rename } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-transient-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'backend');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  await rename(join(root, 'shop', 'state.json'), join(root, 'shop', 'state.bak'));
  await new Promise(resolve => setTimeout(resolve, 150));
  await rename(join(root, 'shop', 'state.bak'), join(root, 'shop', 'state.json'));
  assert.ok(pm.notices.concat(be.notices).some(n => /missing/.test(n)), 'The outage is surfaced once');
  await pm.command('send backend Still alive');
  await until(() => be.received.length === 1, 8000);
  assert.match(be.received[0].content, /Still alive/);
});

test('the TUI shows team-wide requester-to-assignee blockers and offers a full status view', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-flow-'));
  const pm = harness(root, 'pm');
  const frontend = harness(root, 'frontend');
  const backend = harness(root, 'backend');
  t.after(async () => {
    await pm.emit('session_shutdown'); await frontend.emit('session_shutdown'); await backend.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await frontend.emit('session_start'); await backend.emit('session_start');
  await pm.command('create shop');
  await pm.command('join shop pm'); await frontend.command('join shop frontend');
  backend.busy(true); await backend.command('join shop backend');
  await frontend.command('send backend Publish the login API contract');

  await until(() => pm.widgets.get('team')?.some(line => /frontend → backend/.test(line)) ?? false);
  const widget = pm.widgets.get('team')!.join('\n');
  assert.match(widget, /request flow \(requester → assignee\)/);
  assert.match(widget, /frontend → backend \(busy\) · queued · Publish the login API contract/);

  await pm.command('status');
  assert.match(pm.notices.at(-1) ?? '', /Request flow \(requester → assignee\)/);
  assert.match(pm.notices.at(-1) ?? '', /frontend → backend \(busy\)/);

  const status = JSON.parse((await pm.tools.get('team_status').execute('call', {}, undefined, undefined, undefined)).content[0].text);
  assert.equal(status.teamFlow[0].subject, 'Publish the login API contract');
  assert.equal(status.teamFlow[0].assigneeStatus, 'busy');

  backend.busy(false);
  await until(() => backend.received.length === 1);
  await until(() => pm.widgets.get('team')?.some(line => /frontend → backend .* · active ·/.test(line)) ?? false);
});
