import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanel } from '@prjct.app/pi-tui-kit';
import { teamPanelSpec, type TeamOps } from '../src/dynamic/panel.ts';
import type { TeamState } from '../src/dynamic/domain.ts';

const theme: any = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
const tick = () => new Promise(resolve => setImmediate(resolve));
const now = new Date().toISOString();
const policy: any = { tools: ['read'] };
const team: TeamState = {
  schemaVersion: 1, teamId: `p-${'a'.repeat(40)}`, projectPath: '/work', epoch: 3,
  owner: { sessionId: 's1', instanceId: 'i1', epoch: 3, processPid: 100, processGroupId: 100, processStartToken: 't' },
  orchestrator: { summary: '' },
  experts: [
    { id: 'e1', role: 'reviewer', capabilities: ['review'], instructions: '', policy, sessionRef: 's2', generation: 1, status: 'busy', memory: '', history: ['a1'], createdAt: now, updatedAt: now },
  ],
  runs: [
    { id: 'r1', objective: 'Ship the login form', summary: '', status: 'completed', createdAt: now, updatedAt: now, startedAt: now, endedAt: now },
    { id: 'r2', objective: 'Review the importer', summary: '', status: 'active', createdAt: now, updatedAt: now, startedAt: now },
  ],
  assignments: [
    { id: 'a1', runId: 'r2', expertId: 'e1', generation: 1, ownerEpoch: 3, status: 'running', task: 'Read src/importer.ts', result: '', error: '', createdAt: now, updatedAt: now },
  ],
  createdAt: now, updatedAt: now,
};

function open(initial: TeamState | undefined, owner = true) {
  const calls: string[] = [];
  const ops: TeamOps = {
    load: async () => initial,
    isOwner: () => owner,
    cancel: async id => { calls.push(`cancel ${id}`); return `Cancellation recorded for Run ${id}.`; },
    compose: () => { calls.push('compose'); },
  };
  const closed = { value: false };
  const panel = createPanel(teamPanelSpec(ops, initial), { terminal: { columns: 130, rows: 30 }, requestRender() {} } as any, theme, () => { closed.value = true; });
  return {
    calls, closed,
    screen: () => panel.render(130).join('\n'),
    press: async (...keys: string[]) => { for (const key of keys) { panel.handleInput!(key); await tick(); await tick(); } },
    dispose: () => panel.dispose(),
  };
}

test('runs, newest first, and experts are rows; a run shows its assignments', async t => {
  const view = open(team); t.after(view.dispose);
  const text = view.screen();
  assert.match(text, /Team {2}1 active · 0 queued · 1\/1 experts busy/);
  assert.match(text, /● team\s+owned/);
  assert.ok(text.indexOf('Review the importer') < text.indexOf('Ship the login form'), 'newest run first');
  assert.match(text, /● expert · reviewer\s+busy/);
  await view.press('\x1b[B');
  assert.match(view.screen(), /Assignments \(1\)[\s\S]*● running {3}reviewer · Read src\/importer\.ts/);
});

test('cancel asks again and only applies to an active run owned by this session', async t => {
  const view = open(team); t.after(view.dispose);
  await view.press('\x1b[B', 'c');
  assert.deepEqual(view.calls, []);
  await view.press('c');
  assert.deepEqual(view.calls, ['cancel r2']);
  const observer = open(team, false); t.after(observer.dispose);
  await observer.press('\x1b[B');
  assert.doesNotMatch(observer.screen(), /c Cancel run/);
});

test('an empty project offers a new objective', async t => {
  const view = open(undefined); t.after(view.dispose);
  assert.match(view.screen(), /No Team for this project yet\. Press n/);
  await view.press('n');
  assert.equal(view.closed.value, true);
  assert.deepEqual(view.calls, ['compose']);
});
