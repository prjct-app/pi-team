import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActivityJournal, sanitizeActivityText } from '../src/activity.ts';

test('activity text removes terminal controls and common credentials', () => {
  const text = sanitizeActivityText('\x1b]0;owned\x07Bearer abc.def api_key=secret ghp_abcdefghijklmnopqrstuvwxyz https://me:pass@example.com', 500);
  assert.doesNotMatch(text, /\x1b|abc\.def|secret|ghp_|me:pass/);
  assert.match(text, /Bearer \[redacted\]/);
  assert.match(text, /api_key=\[redacted\]/);
});

test('activity text redacts cloud, package, chat, and private-key credentials', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvSecretKeyMaterial\n-----END RSA PRIVATE KEY-----';
  const text = sanitizeActivityText([
    'AKIAIOSFODNN7EXAMPLE',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'github_pat_11AAAAAAAABBBBBBBBBB',
    'npm_abcdefghijklmnopqrstuvwxyz012345',
    'xoxb-12345678901-abcdefghij',
    pem,
  ].join(' '), 2_000);
  assert.doesNotMatch(text, /AKIA|sk-ant-|github_pat_|npm_|xoxb-|MIIEv|PRIVATE KEY/);
  assert.match(text, /\[redacted\]/);
});

test('activity journals are structured, ordered, private, sanitized, and reject stale sequences', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new ActivityJournal(root);
  const first = await journal.append('demo', {
    seq: 1, at: 10, alias: 'backend', kind: 'progress',
    summary: 'Calling API with Bearer top-secret\x1b[31m', detail: 'password=hunter2', workItemId: 'api',
  });
  assert.equal(first.summary, 'Calling API with Bearer [redacted]');
  assert.equal(first.detail, 'password=[redacted]');
  await journal.append('demo', { seq: 2, at: 20, alias: 'backend', kind: 'test', summary: 'Tests passed' });
  await assert.rejects(journal.append('demo', { seq: 2, at: 30, alias: 'backend', kind: 'progress', summary: 'Duplicate' }), /sequence must increase/);
  assert.deepEqual((await journal.read('demo', 'backend')).map(event => event.seq), [1, 2]);
  const mode = stat(join(root, 'demo', 'activity', 'backend.jsonl')).then(info => info.mode & 0o777);
  assert.equal(await mode, 0o600);
});

test('activity journals rotate and expose only a bounded recent stream', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-activity-rotate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new ActivityJournal(root);
  for (const seq of Array.from({ length: 270 }, (_, index) => index + 1)) {
    await journal.append('demo', { seq, at: seq, alias: 'frontend', kind: 'progress', summary: `Update ${seq}`, detail: 'x'.repeat(2_000) });
  }
  await access(join(root, 'demo', 'activity', 'frontend.1.jsonl'));
  const events = await journal.read('demo', 'frontend', 10_000);
  assert.equal(events.length, 200);
  assert.equal(events.at(-1)?.seq, 270);
  assert.ok((events.at(0)?.seq ?? 0) > 1);
});
