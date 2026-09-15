import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TeamPlanPanel, teamWidget } from '../src/team-plan-panel.ts';
import type { TeamViewSnapshot } from '../src/managed-schema.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function snapshot(revision = 1): TeamViewSnapshot {
  const now = Date.now();
  return {
    revision, team: 'release-team',
    goal: { id: 'goal', objective: 'Ship the coordinated release', status: 'active', repoRoot: '/repo', baseBranch: 'develop', baseCommit: 'a'.repeat(40), createdAt: now, updatedAt: now },
    progress: { completed: 1, total: 3, percent: 33 },
    workItems: [
      { id: 'api', title: 'Build API', detail: '', kind: 'implementation', status: 'active', dependsOn: [], assignee: 'backend', attempts: 1, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] },
      { id: 'ui', title: 'Build UI', detail: '', kind: 'implementation', status: 'waiting', dependsOn: ['api'], assignee: 'frontend', attempts: 0, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] },
      { id: 'verify', title: 'Verify', detail: '', kind: 'verification', status: 'queued', dependsOn: ['ui'], attempts: 0, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] },
    ],
    dependencies: [{ from: 'api', to: 'ui', status: 'waiting' }, { from: 'ui', to: 'verify', status: 'waiting' }],
    blockers: [{ id: 'blocker', workItemId: 'ui', kind: 'dependency', summary: 'Waiting for API', detail: '', status: 'open', owner: 'frontend', createdAt: now }],
    approvals: [{ id: 'publish', kind: 'publish-pr', status: 'required', summary: 'Publish and open PR', requestedAt: now }],
    agents: [
      { alias: 'backend', role: 'Backend engineer', status: 'active', worktree: '/worktrees/backend', branch: 'team/backend', workItemId: 'api', lastSeen: now, restarts: 0, activitySeq: 1 },
      { alias: 'frontend', role: 'Frontend engineer', status: 'waiting', worktree: '/worktrees/frontend', branch: 'team/frontend', lastSeen: now, restarts: 0, activitySeq: 1 },
    ],
    criticalPath: ['api', 'ui', 'verify'],
    activity: {
      backend: [{ seq: 1, at: now, alias: 'backend', kind: 'progress', summary: 'Editing API route' }],
      frontend: [{ seq: 1, at: now, alias: 'frontend', kind: 'blocker', summary: 'Waiting for contract' }],
    },
  };
}

function panel() {
  const renders = { count: 0 };
  const closed = { value: false };
  const component = new TeamPlanPanel({
    tui: { requestRender: () => { renders.count++; } },
    theme, initial: snapshot(), load: async () => snapshot(), done: () => { closed.value = true; }, refreshMs: 100_000,
  });
  return { component, renders, closed };
}

test('team plan panel renders responsive bounded lines and semantic plan state', () => {
  const { component } = panel();
  try {
    const lines = component.render(58);
    assert.ok(lines.every(line => visibleWidth(line) <= 58));
    const text = lines.join('\n');
    assert.match(text, /Team Plan.*active.*1\/3 \(33%\)/);
    assert.match(text, /⚑ ● active · Build API · backend/);
    assert.match(text, /api → ui/);
    assert.doesNotMatch(text, /\/worktrees\/backend/, 'Plan view stays compact');
  } finally { component.dispose(); }
});

test('keyboard and mouse provide equivalent agent activity navigation', () => {
  const { component, renders, closed } = panel();
  try {
    component.handleInput('2');
    assert.match(component.render(90).join('\n'), /› ● active · backend/);
    component.handleInput('\x1b[B');
    assert.match(component.render(90).join('\n'), /› ◐ waiting · frontend/);
    assert.match(component.render(90).join('\n'), /Waiting for contract/);
    component.handleInput('\x1b[A');
    const agentLines = component.render(90);
    const frontendRow = agentLines.findIndex(line => line.includes('frontend'));
    const click = component.handleMouse({ type: 'click', button: 'left', x: 4, y: frontendRow, screenX: 4, screenY: 7, width: 90, height: 30, shift: false, alt: false, ctrl: false });
    assert.deepEqual(click, { handled: true, focus: true, render: true });
    assert.match(component.render(90).join('\n'), /› ◐ waiting · frontend/);
    assert.ok(renders.count >= 4);
    component.handleInput('\x1b');
    assert.equal(closed.value, true);
  } finally { component.dispose(); }
});

test('panel rejects stale snapshots and widget summarizes blockers and approvals', () => {
  const { component } = panel();
  try {
    const newer = snapshot(3);
    newer.goal.status = 'blocked';
    newer.progress = { completed: 2, total: 3, percent: 67 };
    component.setSnapshot(newer);
    component.setSnapshot(snapshot(2));
    assert.match(component.render(72).join('\n'), /blocked.*2\/3 \(67%\)/);
    assert.equal(teamWidget(newer), 'release-team · ◆ blocked · 67% · 1/2 active · 1 blocked · approval required');
  } finally { component.dispose(); }
});


test('manual same-revision snapshots cannot be clobbered by an older in-flight refresh', async () => {
  const pending: { resolve?: (value: TeamViewSnapshot) => void } = {};
  const load = () => new Promise<TeamViewSnapshot>(resolve => { pending.resolve = resolve; });
  const component = new TeamPlanPanel({ tui: { requestRender() {} }, theme, initial: snapshot(1), load, done() {}, refreshMs: 5 });
  try {
    await new Promise(resolve => setTimeout(resolve, 15));
    const newer = snapshot(1);
    newer.goal.status = 'blocked';
    component.setSnapshot(newer);
    pending.resolve?.(snapshot(1));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(component.render(70).join('\n'), /blocked/);
  } finally { component.dispose(); }
});

test('activity follow mode can pause, browse older events, and return to the tail', () => {
  const value = snapshot();
  value.activity.backend = Array.from({ length: 15 }, (_, index) => ({ seq: index + 1, at: index + 1, alias: 'backend', kind: 'progress' as const, summary: `Update ${index + 1}` }));
  const component = new TeamPlanPanel({ tui: { requestRender() {} }, theme, initial: value, load: async () => value, done() {}, refreshMs: 100_000 });
  try {
    component.handleInput('2');
    assert.match(component.render(90).join('\n'), /Update 15/);
    component.handleInput('\x1b[5~');
    const older = component.render(90).join('\n');
    assert.match(older, /follow off/);
    assert.doesNotMatch(older, /Update 15/);
    component.handleInput('f');
    const tail = component.render(90).join('\n');
    assert.match(tail, /follow on/);
    assert.match(tail, /Update 15/);
  } finally { component.dispose(); }
});
