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
