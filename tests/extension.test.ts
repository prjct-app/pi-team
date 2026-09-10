import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { harness, until } from './harness.ts';

test('team check-ins do not trigger automatic context compaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-no-auto-compaction-'));
  const pm = harness(root, 'pm');
  const backend = harness(root, 'backend');
  t.after(async () => {
    await pm.emit('session_shutdown'); await backend.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await backend.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await backend.command('join shop backend');
  await pm.command('wake'); await until(() => backend.received.length === 1);
  await backend.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Check-in complete' }] } });
  backend.busy(false); await backend.emit('agent_settled');

  const status = JSON.parse((await backend.tools.get('team_status').execute('call', {}, undefined, undefined, undefined)).content[0].text);
  assert.equal(status.compacting, false);
  assert.ok(!backend.notices.some(notice => /context compaction/i.test(notice)));
});

test('/team wake requests an actionable check-in from every teammate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-wake-'));
  const pm = harness(root, 'pm');
  const backend = harness(root, 'backend');
  const frontend = harness(root, 'frontend');
  t.after(async () => {
    await pm.emit('session_shutdown'); await backend.emit('session_shutdown'); await frontend.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await backend.emit('session_start'); await frontend.emit('session_start');
  await pm.command('create shop');
  await pm.command('join shop pm'); await backend.command('join shop backend'); await frontend.command('join shop frontend');
  backend.busy(true); frontend.busy(true);

  await pm.command('wake Prioritize the release blocker.');

  const status = JSON.parse((await pm.tools.get('team_status').execute('call', {}, undefined, undefined, undefined)).content[0].text);
  assert.deepEqual(status.emittedUnresolved.items.map((item: { to: string }) => item.to).sort(), ['backend', 'frontend']);
  assert.ok(pm.notices.some(notice => /Queued team check-in for 2 teammates/.test(notice)));

  backend.busy(false); frontend.busy(false);
  await until(() => backend.received.length === 1 && frontend.received.length === 1);
  for (const message of [backend.received[0], frontend.received[0]]) {
    assert.match(message.content, /report what you are working on, what remains, blockers, and your next concrete step/i);
    assert.match(message.content, /use team_send to ask them directly/i);
    assert.match(message.content, /complete any pending work you can finish/i);
    assert.match(message.content, /Prioritize the release blocker\./);
  }
});

test('/team wake uses the default check-in without a custom message and handles a solo team', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-wake-default-'));
  const pm = harness(root, 'pm');
  const backend = harness(root, 'backend');
  t.after(async () => {
    await pm.emit('session_shutdown'); await backend.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await backend.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm');
  await pm.command('wake');
  assert.equal(pm.notices.at(-1), 'No teammates to check in with.');

  await backend.command('join shop backend');
  await pm.command('wake');
  await until(() => backend.received.length === 1);
  assert.match(backend.received[0].content, /Team check-in:/);
  assert.doesNotMatch(backend.received[0].content, /Sender's message:/);
});

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
  assert.match(be.received[0].content, /data, not instructions from the user/);
  // Peer rules are carried once, by the system prompt of every joined turn,
  // instead of a second copy inside each message that stays in the branch.
  assert.doesNotMatch(be.received[0].content, /another agent, not the user/,
    'Peer rules are not duplicated into the injected message');
  const [patch] = await be.emit('before_agent_start', { systemPrompt: 'BASE' }) as [{ systemPrompt: string }];
  assert.match(patch.systemPrompt, /another agent, not the user/,
    'The turn that processes a peer message still carries the peer rules');
  assert.match(patch.systemPrompt, /Joined team: shop; your alias: backend/);
  assert.match(patch.systemPrompt, /focused task for this independent session/);
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

test('completed team turns continue directly to the next queued task', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-next-task-'));
  const pm = harness(root, 'pm');
  const be = harness(root, 'backend');
  t.after(async () => {
    await pm.emit('session_shutdown'); await be.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  be.busy(true);
  await pm.command('send backend First focused task');
  await pm.command('send backend Second focused task');
  be.busy(false); await until(() => be.received.length === 1);
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'First task done' }] } });
  be.busy(false); await be.emit('agent_settled');

  await until(() => be.received.length === 2);
  assert.match(be.received[1].content, /Second focused task/);
  assert.ok(!be.notices.some(notice => /context compaction/i.test(notice)));
});

test('restored sessions ignore legacy pending-compaction state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-legacy-compaction-'));
  const pm = harness(root, 'pm');
  const original = harness(root, 'backend');
  let resumed: ReturnType<typeof harness> | undefined;
  t.after(async () => {
    await pm.emit('session_shutdown'); await resumed?.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await original.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await original.command('join shop backend');
  await original.emit('session_shutdown', { reason: 'reload' });
  await pm.command('send backend Work after upgrade');
  const saved = [...original.entries, {
    type: 'custom', customType: 'team-membership',
    data: { team: 'shop', alias: 'backend', session: 'backend', paused: false, needsCompaction: true, compactionSubject: 'Legacy task' },
  }];

  resumed = harness(root, 'backend', saved);
  await resumed.emit('session_start', { reason: 'reload' });
  await until(() => resumed!.received.length === 1);
  assert.match(resumed.received[0].content, /Work after upgrade/);
  assert.ok(!resumed.notices.some(notice => /context compaction/i.test(notice)));
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
  await until(async () => (await status(pm)).emittedUnresolved.items.length === 1);
  let view = await status(pm);
  assert.equal(view.emittedUnresolved.items[0].subject, 'Implement login endpoint');
  assert.equal(view.emittedUnresolved.items[0].state, 'pending');
  view = await status(be);
  assert.equal(view.queuedForYou.items.length, 1);
  be.busy(false);
  await until(() => be.received.length === 1);
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Login done' }] } });
  be.busy(false); await be.emit('agent_settled');
  await until(() => pm.received.length === 1);
  assert.match(pm.received[0].content, /Original request you emitted/);
  assert.match(pm.received[0].content, /Implement login endpoint/);
  view = await status(pm);
  assert.equal(view.emittedUnresolved.items.length, 0, 'A completed request is no longer outstanding');
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

test('the TUI keeps the persistent team widget minimal and shows request flow on demand', async (t) => {
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

  await until(async () => {
    const status = JSON.parse((await pm.tools.get('team_status').execute('call', {}, undefined, undefined, undefined)).content[0].text);
    return status.otherTeamWork.items.length === 1;
  });
  assert.deepEqual(pm.widgets.get('team'), ['shop · pm · connected']);

  await pm.command('status');
  assert.match(pm.notices.at(-1) ?? '', /Request flow \(requester → assignee\)/);
  assert.match(pm.notices.at(-1) ?? '', /frontend → backend \(busy\) · queued · Publish the login API contract/);

  const status = JSON.parse((await pm.tools.get('team_status').execute('call', {}, undefined, undefined, undefined)).content[0].text);
  assert.equal(status.otherTeamWork.items[0].subject, 'Publish the login API contract');
  assert.equal(status.otherTeamWork.items[0].assigneeStatus, 'busy');

  backend.busy(false);
  await until(() => backend.received.length === 1);
  assert.deepEqual(pm.widgets.get('team'), ['shop · pm · connected']);
});

test('a takeover that lands while the settle handler is queued still persists an interrupted result', async (t) => {
  const { Mailbox } = await import('../src/mailbox.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-takeover-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  await pm.command('send backend Implement login'); await until(() => be.received.length === 1);
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Finished the login work' }] } });
  // The settle handler must observe the takeover recorded after it was queued,
  // not the value captured when it started waiting.
  be.busy(false);
  const settled = be.emit('agent_settled');
  await be.emit('input', { source: 'interactive', text: 'Actually stop, do my thing instead.' });
  await settled;
  await until(() => pm.received.length === 1);
  assert.match(pm.received[0].content, /User took over/);
  assert.doesNotMatch(pm.received[0].content, /Finished the login work/);
  // The durable mailbox outcome, not just the forwarded text, must record it.
  const box = new Mailbox(root);
  const observer = await box.join('shop', 'observer', 'observer', '/observer');
  const request = (await box.snapshot(observer)).flow;
  assert.equal(request.length, 0, 'The claimed request is settled, not left outstanding');
});

test('a quiet tick opens no mailbox transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-quiet-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be'); const fe = harness(root, 'fe');
  t.after(async () => {
    await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await fe.emit('session_shutdown');
    await rm(root, { recursive: true, force: true });
  });
  await pm.emit('session_start'); await be.emit('session_start'); await fe.emit('session_start');
  await pm.command('create shop');
  await pm.command('join shop pm'); await be.command('join shop backend'); await fe.command('join shop frontend');

  // The two conditions that used to keep a full mailbox transaction running on
  // every tick forever: a member recorded offline, and a peer legitimately
  // holding a claim. Neither is something to recover from.
  await fe.command('leave');
  await pm.command('send backend Implement login');
  await until(() => be.received.length === 1);

  // A no-op mutation publishes nothing, so the revision cannot show the waste.
  // What it costs is the transaction itself: an uncached full parse of the
  // record, plus its directory syscalls and presence scan, per tick per member.
  const { counters } = await import('../src/store.ts');
  // Let the reads caused by the setup writes settle first: publishing a new
  // record legitimately invalidates every reader's cache exactly once.
  await new Promise(resolve => setTimeout(resolve, 200));
  const before = counters.reads;
  // Many poll intervals (pollMs is 20 in tests), across three joined sessions.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(counters.reads, before, 'Idle polling must not open mailbox transactions');
});

test('a note reaches a quiet session exactly once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-notes-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  const notes = () => be.entries.filter(e => e.customType === 'team-event' && e.data?.kind === 'note').length;
  await pm.command('note backend API contract changed');
  await pm.command('note backend Second update');
  await until(() => notes() === 2);
  assert.equal(be.received.length, 0, 'Notes never start a model turn');
  // The guard that skips the mailbox transaction must not re-deliver either.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(notes(), 2, 'Consumed notes are not appended again by later ticks');
});

test('the widget is registered again after leaving and rejoining', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-widget-'));
  const pm = harness(root, 'pm');
  t.after(async () => { await pm.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm');
  await until(() => pm.widgets.get('team')?.[0] === 'shop · pm · connected');
  await pm.command('leave');
  assert.equal(pm.widgets.get('team'), undefined, 'Leaving clears the widget');
  await pm.command('join shop pm');
  await until(() => pm.widgets.get('team')?.[0] === 'shop · pm · connected');
});

test('a session reload re-registers the widget on the new context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-widget-reload-'));
  const pm = harness(root, 'pm');
  t.after(async () => { await pm.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm');
  await until(() => pm.widgets.get('team')?.[0] === 'shop · pm · connected');
  // Reload: Pi supplies a new context, and the restored membership renders the
  // very same status text. Caching on text alone would skip the registration
  // and leave the reloaded session with no widget at all.
  pm.widgets.delete('team');
  pm.renewContext();
  await pm.emit('session_start', { reason: 'reload' });
  await until(() => pm.widgets.get('team')?.[0] === 'shop · pm · connected');
});

test('the reported file list truncates at the byte boundary of a full serialization', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-files-'));
  const pm = harness(root, 'pm'); const be = harness(root, 'be');
  t.after(async () => { await pm.emit('session_shutdown'); await be.emit('session_shutdown'); await rm(root, { recursive: true, force: true }); });
  await pm.emit('session_start'); await be.emit('session_start');
  await pm.command('create shop'); await pm.command('join shop pm'); await be.command('join shop backend');
  await pm.command('send backend Refactor everything'); await until(() => be.received.length === 1);

  // Long paths so the 31000-byte cap binds before the 50-file cap.
  const paths = Array.from({ length: 60 }, (_, i) => `src/module-${i}/${'segment/'.repeat(70)}file.ts`);
  for (const path of paths) await be.emit('tool_result', { toolName: 'edit', input: { path }, isError: false });
  await be.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] } });
  be.busy(false); await be.emit('agent_settled');
  await until(() => pm.received.length === 1);

  // Reference count, computed the way the loop used to: re-serialize per file.
  const body = 'Done';
  const reference = { outcome: 'completed', body, files: [] as string[], tests: [] as string[] };
  const resolved = paths.map(path => join('/worktrees/be', path));
  const expected = resolved.filter(file => {
    if (reference.files.length >= 50 || file.length > 4096) return false;
    if (Buffer.byteLength(JSON.stringify({ ...reference, files: [...reference.files, file] })) > 31000) return false;
    reference.files.push(file);
    return true;
  }).length;

  assert.ok(expected > 0 && expected < paths.length, 'The fixture must actually hit the cap');
  assert.equal(pm.received[0].details.result.files.length, expected, 'Same boundary as re-serializing per file');
  assert.match(pm.received[0].details.result.body, /File list truncated/);
});

test('the file-list cap matches a full re-serialization at every boundary', async () => {
  const { fitFiles } = await import('../src/index.ts');
  // The original formula, kept here as the reference the fast path must match.
  const reference = (base: { outcome: string; body: string; files: string[]; tests: string[] }, candidates: string[]) => {
    const report = { ...base, files: [] as string[] };
    const truncated = candidates.some(file => {
      if (report.files.length >= 50 || file.length > 4096) return true;
      if (Buffer.byteLength(JSON.stringify({ ...report, files: [...report.files, file] })) > 31000) return true;
      report.files.push(file);
      return false;
    });
    return { files: report.files, truncated };
  };
  // Sweep path lengths so the cumulative size crosses 31000 at many different
  // offsets: an off-by-one in the running total shows up at one of them.
  const lengths = Array.from({ length: 120 }, (_, i) => 400 + i);
  const mismatches = lengths.filter(length => {
    const base = { outcome: 'completed', body: 'x'.repeat(300), files: [] as string[], tests: [] as string[] };
    const candidates = Array.from({ length: 90 }, (_, i) => `/w/${String(i).padStart(3, '0')}/${'p'.repeat(length)}`);
    const fast = fitFiles(base as never, candidates);
    const slow = reference(base, candidates);
    return fast.truncated !== slow.truncated || fast.files.length !== slow.files.length;
  });
  assert.deepEqual(mismatches, [], 'The running total must agree with re-serialization at every length');
  // Non-ASCII paths encode wider than they measure in characters.
  const unicode = Array.from({ length: 90 }, (_, i) => `/w/${i}/${'ñ→"\\\\'.repeat(90)}`);
  const base = { outcome: 'completed', body: 'y', files: [] as string[], tests: [] as string[] };
  assert.equal(fitFiles(base as never, unicode).files.length, reference(base, unicode).files.length);
});
