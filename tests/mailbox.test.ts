import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Mailbox } from '../src/mailbox.ts';

test('PM and backend join an explicit team; a typo does not create a new team', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm-session', '/projects/planning');
  await box.join('shop', 'backend', 'be-session', '/projects/api');
  assert.deepEqual((await box.members(pm)).map(m => m.alias), ['pm', 'backend']);
  await assert.rejects(box.join('shpo', 'frontend', 'fe-session', '/projects/web'), /Unknown team/);
  assert.deepEqual(await box.teams(), ['shop']);
  await assert.rejects(box.join('shop', 'pm', 'other-session', '/other'), /already in use/);
  await box.leave(pm);
  assert.equal((await box.join('shop', 'pm', 'other-session', '/other')).alias, 'pm');
});

test('messages wait for readiness, are claimed once, and return a correlated result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm-session', '/planning');
  const be = await box.join('shop', 'backend', 'be-session', '/api');
  const sent = await box.send(pm, { to: 'backend', kind: 'request', subject: 'Login API', body: 'Implement login' });
  assert.equal(await box.receive(be, false), undefined);
  const received = await box.receive(be, true);
  assert.equal(received?.id, sent.id);
  assert.equal(await box.receive(be, true), undefined);
  await box.complete(be, sent.id, { outcome: 'completed', body: 'Login implemented', files: ['src/login.ts'], tests: ['npm test: passed'] });
  await box.complete(be, sent.id, { outcome: 'completed', body: 'Duplicate completion', files: [], tests: [] });
  const reply = await box.receive(pm, true);
  assert.equal(reply?.kind, 'result');
  assert.equal(reply?.parentId, sent.id);
  assert.deepEqual(reply?.result?.files, ['src/login.ts']);
  assert.equal(reply?.body, 'Login implemented');
  assert.equal(await box.receive(pm, true), undefined);
  assert.equal((await box.history(pm)).length, 2);
});

test('notes do not wake models; teams, identifiers, payloads and conversation budgets are bounded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  await box.create('other');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  const other = await box.join('other', 'backend', 'other-be', '/other');
  await assert.rejects(box.create('../escape'), /lowercase/);
  await assert.rejects(box.send(pm, { to: 'pm', kind: 'request', subject: 'Self', body: 'loop' }), /yourself/);
  await assert.rejects(box.send(pm, { to: 'backend', kind: 'request', subject: 'Large', body: 'x'.repeat(17000) }), /too large/);
  await box.send(pm, { to: 'backend', kind: 'note', subject: 'FYI', body: 'Contract updated' });
  assert.equal(await box.receive(be, true), undefined);
  assert.equal((await box.notes(be)).length, 1);
  assert.equal((await box.notes(be)).length, 0);
  assert.deepEqual(await box.history(other), []);
  let previous = (await box.send(pm, { to: 'backend', kind: 'request', subject: 'Start', body: 'Work' })).id;
  await assert.rejects(box.send(pm, { to: 'backend', kind: 'request', subject: 'Start', body: 'Work' }), /Duplicate/);
  for (let i = 1; i < 8; i++) {
    const current = i % 2 ? be : pm;
    const to = i % 2 ? 'pm' : 'backend';
    previous = (await box.send(current, { to, kind: 'request', subject: `Step ${i}`, body: 'Work', parentId: previous })).id;
  }
  await assert.rejects(box.send(pm, { to: 'backend', kind: 'request', subject: 'Loop', body: 'Work', parentId: previous }), /Conversation limit/);
});

test('leaving preserves pending work, interrupts claimed work, and fences an old owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  const job = await box.send(pm, { to: 'backend', kind: 'request', subject: 'Claimed', body: 'Work' });
  await box.receive(be, true);
  await box.send(pm, { to: 'backend', kind: 'request', subject: 'Queued', body: 'Work later' });
  await box.leave(be);
  const returned = await box.join('shop', 'backend', 'new-be', '/new-be');
  assert.equal((await box.receive(returned, true))?.subject, 'Queued');
  await assert.rejects(box.heartbeat(be, 'idle'), /expired or replaced/);
  const report = await box.receive(pm, true);
  assert.equal(report?.parentId, job.id);
  assert.equal(report?.result?.outcome, 'interrupted');
  assert.match(report?.body ?? '', /not automatically retried/);
});

test('unsafe storage and malformed records are refused without deleting the inbox', async (t) => {
  const { symlink, writeFile, readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(root, join(root, 'alias'));
  await assert.rejects(new Mailbox(join(root, 'alias')).create('shop'), /Unsafe directory/);
  const box = new Mailbox(root);
  await box.create('shop');
  const be = await box.join('shop', 'backend', 'be', '/be');
  const broken = JSON.stringify({ version: 1, members: [null], messages: [] });
  await writeFile(join(root, 'shop', 'state.json'), broken);
  await assert.rejects(box.history(be), /Invalid mailbox format/);
  assert.equal(await readFile(join(root, 'shop', 'state.json'), 'utf8'), broken);
});

test('automatic results retain reserved inbox capacity when other senders fill the requester inbox', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  const fe = await box.join('shop', 'frontend', 'fe', '/fe');
  await box.send(pm, { to: 'backend', kind: 'request', subject: 'API', body: 'Implement login' });
  const task = await box.receive(be, true);
  assert.ok(task);
  for (let i = 0; i < 49; i++) {
    await box.send(fe, { to: 'pm', kind: 'note', subject: `Finding ${i}`, body: 'Review later' });
  }
  let overflow: unknown;
  try {
    await box.send(fe, { to: 'pm', kind: 'note', subject: 'Overflow', body: 'Must not consume the result slot' });
  } catch (error) { overflow = error; }
  await box.complete(be, task.id, { outcome: 'completed', body: 'API ready', files: [], tests: [] });
  const inbox = (await box.history(pm)).filter(m => m.to === 'pm' && m.state === 'pending');
  assert.equal(inbox.length, 50, 'Automatic results must not exceed the recipient limit');
  assert.ok(overflow instanceof Error && /inbox full/i.test(overflow.message));
  assert.equal(inbox.filter(m => m.parentId === task.id && m.kind === 'result').length, 1);
  const claimedResult = await box.receive(pm, true);
  assert.ok(claimedResult);
  await assert.rejects(box.send(fe, { to: 'pm', kind: 'note', subject: 'While claimed', body: 'The claim can still be released' }), /Recipient inbox full/);
  await box.release(pm, claimedResult.id);
  assert.equal((await box.history(pm)).filter(m => m.to === 'pm' && m.state === 'pending').length, 50);
  // Consuming notes releases slots, without waking a model or losing the result.
  assert.equal((await box.notes(pm)).length, 49);
  await box.send(fe, { to: 'pm', kind: 'note', subject: 'After draining', body: 'Space is available' });
});

test('a full requester inbox rejects requests without reservable replies but still permits notes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-sender-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  for (let i = 0; i < 50; i++) {
    await box.send(be, { to: 'pm', kind: 'note', subject: `Finding ${i}`, body: 'Review later' });
  }
  const request = { to: 'backend', kind: 'request' as const, subject: 'API', body: 'Implement login' };
  await assert.rejects(box.send(pm, request), /Sender inbox full/);
  assert.equal((await box.history(be)).filter(m => m.kind === 'request').length, 0, 'A rejected send must not queue work');
  await box.send(pm, { to: 'backend', kind: 'note', subject: 'FYI', body: 'Notes need no result slot' });
  assert.equal((await box.notes(be))[0].body, 'Notes need no result slot');
  await box.notes(pm);
  const sent = await box.send(pm, request);
  assert.equal((await box.receive(be, true))?.id, sent.id);
  await box.leave(be);
  const result = await box.receive(pm, true);
  assert.equal(result?.parentId, sent.id);
  assert.equal(result?.result?.outcome, 'interrupted', 'Disconnect results use the same reserved slot');
});

test('presence heartbeats keep members online without touching the shared record', async (t) => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-presence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  const before = await readFile(join(root, 'shop', 'state.json'), 'utf8');
  await box.heartbeat(pm, 'busy');
  assert.equal((await box.members(be)).find(m => m.alias === 'pm')?.status, 'busy');
  assert.equal(await readFile(join(root, 'shop', 'state.json'), 'utf8'), before, 'Heartbeats never rewrite the team record');
  // A stale presence file marks the member offline without any write.
  await writeFile(join(root, 'shop', 'presence', 'pm.json'),
    JSON.stringify({ token: pm.token, status: 'idle', seen: Date.now() - 60_000 }), { mode: 0o600 });
  assert.equal((await box.members(be)).find(m => m.alias === 'pm')?.status, 'offline');
  // The next mutation sweeps the stale member; its presence file is removed.
  await box.send(be, { to: 'pm', kind: 'note', subject: 'FYI', body: 'Sweep' });
  assert.equal((await box.history(be)).length, 1);
});

test('pre-envelope mailboxes migrate transparently on the first write', async (t) => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  // A 0.1.x mailbox: plain JSON state without an envelope or revision history.
  await mkdir(join(root, 'shop'), { mode: 0o700 });
  const legacy = JSON.stringify({ version: 1, members: [], messages: [] });
  await writeFile(join(root, 'shop', 'state.json'), legacy, { mode: 0o600 });
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  await box.send(pm, { to: 'backend', kind: 'request', subject: 'Task', body: 'Work' });
  assert.equal((await box.receive(be, true))?.subject, 'Task');
  const migrated = JSON.parse(await readFile(join(root, 'shop', 'state.json'), 'utf8'));
  assert.equal(migrated.schemaVersion, 1, 'Writes republish legacy mailboxes as envelope records');
  assert.ok(migrated.revision >= 1);
});

test('many members writing concurrently all commit without lock errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const writers = await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5'].map(alias => box.join('shop', alias, alias, `/${alias}`)));
  await Promise.all(writers.flatMap((writer, w) => [
    ...Array.from({ length: 4 }, (_, i) => box.send(writer, { to: 'pm', kind: 'note', subject: `N${w}-${i}`, body: 'finding' })),
    box.heartbeat(writer, 'busy'),
  ]));
  assert.equal((await box.notes(pm)).length, 20, 'No concurrent write is lost');
});

test('a snapshot reports record revision and presence-based statuses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  const frontend = await box.join('shop', 'frontend', 'frontend', '/frontend');
  const first = await box.snapshot(pm);
  assert.ok(first.revision >= 1);
  assert.deepEqual(first.members.map(m => m.alias).sort(), ['backend', 'frontend', 'pm']);
  const sent = await box.send(frontend, { to: 'backend', kind: 'request', subject: 'Task', body: 'Private implementation details' });
  const second = await box.snapshot(pm);
  assert.ok(second.revision > first.revision, 'Mutations advance the record revision');
  assert.equal(second.messages.find(m => m.id === sent.id), undefined, 'Unrelated message bodies remain private');
  assert.deepEqual(second.flow.find(m => m.id === sent.id), {
    id: sent.id, from: 'frontend', to: 'backend', subject: 'Task', state: 'pending', created: sent.created,
  });
  assert.equal('body' in second.flow[0], false);
  assert.equal((await box.snapshot(be)).messages.find(m => m.id === sent.id)?.state, 'pending');
});

test('only a dead member still holding a claim makes a snapshot sweepable', async (t) => {
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-sweepable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const be = await box.join('shop', 'backend', 'be', '/be');
  const fe = await box.join('shop', 'frontend', 'fe', '/fe');

  await box.send(pm, { to: 'backend', kind: 'request', subject: 'Task', body: 'Work' });
  await box.receive(be, true);
  assert.equal((await box.snapshot(pm)).sweepable, false, 'A live claim holder needs no sweep');

  // A member that leaves stays in the record as offline forever. On its own
  // that must never keep the sweep armed, or every tick pays a transaction.
  await box.leave(fe);
  assert.equal((await box.snapshot(pm)).sweepable, false,
    'A departed member plus a legitimately processing peer is not sweepable');

  // Now the claim holder itself goes away without releasing its claim.
  await writeFile(join(root, 'shop', 'presence', 'backend.json'),
    JSON.stringify({ token: be.token, status: 'idle', seen: Date.now() - 60_000 }), { mode: 0o600 });
  assert.equal((await box.snapshot(pm)).sweepable, true, 'A dead claim holder must be swept');

  await box.sweep(pm);
  assert.equal((await box.snapshot(pm)).sweepable, false, 'Sweeping settles the claim and disarms');
  const result = (await box.snapshot(pm)).messages.find(m => m.kind === 'result');
  assert.equal(result?.result?.outcome, 'interrupted', 'The requester receives an interrupted result');
});

test('a directory that becomes unsafe after a successful operation is refused again', async (t) => {
  const { chmod } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-unsafe-later-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  await box.join('shop', 'backend', 'be', '/be');
  // The mkdir is remembered per process, but the safety check is not: a team
  // directory opened up after a successful join must still be refused.
  await chmod(join(root, 'shop'), 0o777);
  await assert.rejects(box.send(pm, { to: 'backend', kind: 'note', subject: 'FYI', body: 'x' }),
    /Unsafe directory/, 'Validation is re-run, not cached, on every operation');
});

test('a no-op mutation on a legacy mailbox does not rewrite the record', async (t) => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-legacy-noop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  // A pre-envelope record carries no canonical serialization, so the no-op
  // check must fall back to serializing rather than assume one is present.
  await mkdir(join(root, 'shop'), { mode: 0o700 });
  await writeFile(join(root, 'shop', 'state.json'),
    JSON.stringify({ version: 1, members: [], messages: [] }), { mode: 0o600 });
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const before = await readFile(join(root, 'shop', 'state.json'), 'utf8');
  assert.deepEqual(await box.notes(pm), [], 'No notes to consume');
  assert.equal(await readFile(join(root, 'shop', 'state.json'), 'utf8'), before,
    'A mutation that changes nothing must not publish a revision');
});

test('removing an offline member settles dead work and fences the removed identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-remove-member-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const backend = await box.join('shop', 'backend', 'backend', '/backend');
  await assert.rejects(box.removeMember(pm, 'backend'), /active/);
  await assert.rejects(box.renameMember(pm, 'backend', 'api'), /active/);
  const inbound = await box.send(pm, { to: 'backend', kind: 'request', subject: 'Dead queue', body: 'Will not run' });
  const outbound = await box.send(backend, { to: 'pm', kind: 'request', subject: 'Dead requester', body: 'No owner remains' });
  await box.leave(backend);

  const removed = await box.removeMember(pm, 'backend');

  assert.equal(removed.settled, 2);
  assert.deepEqual((await box.members(pm)).map(member => member.alias), ['pm']);
  const history = await box.history(pm);
  assert.equal(history.find(message => message.id === inbound.id)?.state, 'interrupted');
  assert.equal(history.find(message => message.id === outbound.id)?.state, 'interrupted');
  assert.equal(history.find(message => message.parentId === inbound.id)?.result?.outcome, 'interrupted');
  await assert.rejects(box.heartbeat(backend, 'idle'), /expired or replaced/);
});

test('removing a stale claim holder preserves the interrupted result for its requester', async (t) => {
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-remove-stale-member-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const backend = await box.join('shop', 'backend', 'backend', '/backend');
  const task = await box.send(pm, { to: 'backend', kind: 'request', subject: 'Claimed', body: 'May be partial' });
  await box.receive(backend, true);
  await writeFile(join(root, 'shop', 'presence', 'backend.json'),
    JSON.stringify({ token: backend.token, status: 'idle', seen: Date.now() - 60_000 }), { mode: 0o600 });

  await box.removeMember(pm, 'backend');

  const result = await box.receive(pm, true);
  assert.equal(result?.parentId, task.id);
  assert.equal(result?.result?.outcome, 'interrupted');
});

test('renaming a member preserves queued work under the new alias', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-rename-member-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const backend = await box.join('shop', 'backend', 'backend', '/backend');
  const task = await box.send(pm, { to: 'backend', kind: 'request', subject: 'Keep queue', body: 'Deliver after rename' });
  await box.leave(backend);

  await box.renameMember(pm, 'backend', 'api');
  assert.deepEqual((await box.members(pm)).map(member => member.alias), ['pm', 'api']);
  const api = await box.join('shop', 'api', 'api', '/api');
  assert.equal((await box.receive(api, true))?.id, task.id);
  assert.equal((await box.history(pm)).find(message => message.id === task.id)?.to, 'api');
});

test('renaming and deleting teams require every member to be offline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await assert.rejects(box.deleteTeam('missing'), /Unknown team/);
  assert.deepEqual(await box.teams(), [], 'Deleting an unknown team must not create a ghost directory');
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  await assert.rejects(box.renameTeam('shop', 'store'), /active member/);
  await assert.rejects(box.deleteTeam('shop'), /active member/);
  await box.leave(pm);

  await box.renameTeam('shop', 'store');
  assert.deepEqual(await box.teams(), ['store']);
  await assert.rejects(box.join('shop', 'pm', 'old', '/old'), /Unknown team/);
  const restored = await box.join('store', 'pm', 'new', '/new');
  assert.equal(restored.team, 'store');
  await box.leave(restored);
  await box.deleteTeam('store');
  assert.deepEqual(await box.teams(), []);
  await assert.rejects(box.join('store', 'pm', 'again', '/again'), /Unknown team/);
});

test('team rename recovers an interrupted directory move and settles stale claims', async (t) => {
  const { rename: move, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'pi-team-rename-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = new Mailbox(root);
  await box.create('shop');
  const pm = await box.join('shop', 'pm', 'pm', '/pm');
  const backend = await box.join('shop', 'backend', 'backend', '/backend');
  const task = await box.send(pm, { to: 'backend', kind: 'request', subject: 'Stale claim', body: 'May be partial' });
  await box.receive(backend, true);
  await box.leave(pm);
  await writeFile(join(root, 'shop', 'presence', 'backend.json'),
    JSON.stringify({ token: backend.token, status: 'idle', seen: Date.now() - 60_000 }), { mode: 0o600 });

  await box.renameTeam('shop', 'store');
  const restored = await box.join('store', 'pm', 'restored', '/restored');
  const result = await box.receive(restored, true);
  assert.equal(result?.parentId, task.id);
  assert.equal(result?.result?.outcome, 'interrupted');

  await box.leave(restored);
  await move(join(root, 'store'), join(root, 'moved'));
  await box.renameTeam('store', 'moved');
  assert.deepEqual(await box.teams(), ['moved']);
  assert.equal((await box.join('moved', 'pm', 'again', '/again')).team, 'moved');
});
