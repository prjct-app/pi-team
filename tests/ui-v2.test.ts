import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  dashboardText, openTeamDashboard, renderDashboard, sanitizeDashboardText, type DashboardSnapshot,
} from '../src/ui/team-dashboard.ts';

const snapshot: DashboardSnapshot = {
  team: { teamId: 'shop', state: 'open', alias: 'lead' },
  members: [
    { id: 'member-a', alias: 'backend', kind: 'supervised', status: 'online' },
    { id: 'member-b', alias: 'reviewer', kind: 'external', status: 'offline' },
  ],
  inbox: [{ id: 'message-1', kind: 'request', from: 'member-b', createdAt: '2026-01-01T00:00:00.000Z' }],
  runtimes: [{ id: 'runtime-1', memberId: 'member-a', state: 'busy', requestId: 'message-1' }],
  requests: [{ id: 'message-1', status: 'read', at: '2026-01-01T00:00:01.000Z' }],
  leases: [{ id: 'resource-1', kind: 'resource', resource: '/repo/api.ts', expiresAt: '2026-01-01T00:05:00.000Z' }],
  warnings: ['Runtime runtime-2 is lost.'],
  omitted: false,
};

test('dashboard is bounded at 80 columns and expresses status without color', () => {
  const lines = renderDashboard(snapshot, 80, 'member:member-b');
  assert.ok(lines.every(line => visibleWidth(line) <= 80));
  assert.match(lines.join('\n'), /● online · backend/);
  assert.match(lines.join('\n'), /○ offline · reviewer/);
  assert.match(lines.join('\n'), /> ○ offline · reviewer/);
  assert.doesNotMatch(lines.join('\n'), /body|secret|token/i);
  assert.match(dashboardText(snapshot), /Shutdown\/recovery warnings/);
});

test('dashboard sanitizes terminal controls and Escape only closes the view', async () => {
  assert.equal(sanitizeDashboardText('\x1b]2;owned\x07bad\n\u202ename'), 'bad name');
  const observed: { component?: any; done: number } = { done: 0 };
  const context = {
    hasUI: true,
    mode: 'tui',
    ui: {
      custom: async (factory: any) => {
        observed.component = factory({ requestRender() {} }, {}, {}, () => { observed.done += 1; });
        observed.component.handleInput('\x1b');
      },
    },
  } as unknown as ExtensionContext;
  await openTeamDashboard(context, snapshot);
  assert.equal(observed.done, 1);
});

test('headless dashboard uses the same bounded plain snapshot', async () => {
  const notices: string[] = [];
  const context = {
    hasUI: false,
    mode: 'print',
    ui: { notify(message: string) { notices.push(message); } },
  } as unknown as ExtensionContext;
  await openTeamDashboard(context, snapshot);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /TEAM · shop/);
});
