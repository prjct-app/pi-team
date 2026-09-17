import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  dashboardText, nextDashboardSelection, openTeamDashboard, renderDashboard, sanitizeDashboardText,
  type DashboardSnapshot,
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
  omitted: { members: false, inbox: false, requests: false, leases: false },
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

test('dashboard adapts its layout and viewport while retaining stable member selection', () => {
  const compact = renderDashboard(snapshot, 36, 'member:member-b', 8);
  const standard = renderDashboard(snapshot, 80, 'member:member-b', 12);
  const wide = renderDashboard(snapshot, 120, 'member:member-b', 16);

  assert.ok(compact.length <= 8 && compact.every(line => visibleWidth(line) <= 36));
  assert.ok(standard.length <= 12 && standard.every(line => visibleWidth(line) <= 80));
  assert.ok(wide.length <= 16 && wide.every(line => visibleWidth(line) <= 120));
  assert.match(compact.join('\n'), /> ○ offline · reviewer/);
  assert.match(standard.join('\n'), /> ○ offline · reviewer · external/);
  assert.match(wide.join('\n'), /> ○ offline · reviewer/);
  assert.match(wide.join('\n'), /DETAIL · Member/);
  assert.match(wide.join('\n'), /Member ID: member-b/);
  assert.equal(nextDashboardSelection(snapshot, 'member:member-a', 1), 'member:member-b');
});

test('adaptive truncation preserves cell bounds for wide and combining text', () => {
  const international: DashboardSnapshot = {
    ...snapshot,
    team: { ...snapshot.team, alias: '開発👩🏽‍💻e\u0301\x1b]2;owned\x07' },
    members: [{ ...snapshot.members[0]!, alias: '設計👨‍👩‍👧‍👦e\u0301'.repeat(8) }],
  };
  const compact = renderDashboard(international, 24, 'member:member-a', 8);
  const standard = renderDashboard(international, 80, 'member:member-a', 12);
  const wide = renderDashboard(international, 120, 'member:member-a', 16);
  assert.ok(compact.every(line => visibleWidth(line) <= 24));
  assert.ok(standard.every(line => visibleWidth(line) <= 80));
  assert.ok(wide.every(line => visibleWidth(line) <= 120));
  assert.doesNotMatch([...compact, ...standard, ...wide].join('\n'), /owned|\x1b\]2/);
});

test('bounded-page markers identify the section that actually omitted records', () => {
  const text = dashboardText({
    ...snapshot,
    omitted: { members: true, inbox: false, requests: true, leases: false },
  });
  assert.match(text, /Members \(2\+\)/);
  assert.match(text, /Inbox \(1\)/);
  assert.doesNotMatch(text, /Inbox \(1\+\)/);
  assert.match(text, /Requests \(1\+\)/);
  assert.match(text, /Leases \(1\)/);
});

test('small heights preserve recovery and close guidance', () => {
  const lines = renderDashboard(snapshot, 30, 'member:member-a', 4);
  assert.ok(lines.length <= 4);
  assert.match(lines.join('\n'), /Resize terminal/);
  assert.match(lines.join('\n'), /Esc close/);
});

test('dashboard sanitizes terminal controls and Escape only closes the adaptive overlay', async () => {
  assert.equal(sanitizeDashboardText('\x1b]2;owned\x07bad\n\u202ename'), 'bad name');
  const observed: { component?: any; done: number; renders: number; options?: any } = { done: 0, renders: 0 };
  const terminal = { rows: 24 };
  const context = {
    hasUI: true,
    mode: 'tui',
    ui: {
      custom: async (factory: any, options: any) => {
        observed.options = options;
        observed.component = factory({
          terminal,
          requestRender() { observed.renders += 1; },
        }, {}, {}, () => { observed.done += 1; });
        assert.ok(observed.component.render(80).length <= 22);
        terminal.rows = 10;
        assert.ok(observed.component.render(36).length <= 8);
        observed.component.handleInput('\r');
        assert.match(observed.component.render(36).join('\n'), /Member ID: member-a/);
        observed.component.handleInput('\x1b[B');
        assert.match(observed.component.render(120).join('\n'), /Member ID: member-b/);
        observed.component.handleInput('\x1b');
      },
    },
  } as unknown as ExtensionContext;
  await openTeamDashboard(context, snapshot);
  assert.equal(observed.options.overlay, true);
  assert.equal(observed.done, 1);
  assert.equal(observed.renders, 2);
});

test('print mode writes the bounded plain snapshot without relying on its no-op UI', async () => {
  const output: string[] = [];
  const context = {
    hasUI: false,
    mode: 'print',
    ui: { notify: () => assert.fail('Print mode UI is unavailable') },
  } as unknown as ExtensionContext;
  await openTeamDashboard(context, snapshot, text => output.push(text));
  assert.equal(output.length, 1);
  assert.match(output[0]!, /TEAM · shop/);
  assert.match(output[0]!, /Plain snapshot · metadata only/);
  assert.doesNotMatch(output[0]!, /Esc close/);
  assert.ok(output[0]!.trimEnd().split('\n').every(line => visibleWidth(line) <= 80));
});
