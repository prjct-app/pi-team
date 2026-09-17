import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { Membership } from '../runtime/membership.ts';
import type { TeamRuntime } from '../runtime/team-runtime.ts';
import { ownerProcessNonce } from '../supervisor/supervisor.ts';

export type DashboardSnapshot = {
  readonly team: { readonly teamId: string; readonly state: string; readonly alias: string };
  readonly members: readonly {
    readonly id: string; readonly alias: string; readonly kind: string; readonly status: 'online' | 'offline';
  }[];
  readonly inbox: readonly {
    readonly id: string; readonly kind: string; readonly from: string; readonly createdAt: string;
  }[];
  readonly runtimes: readonly {
    readonly id: string; readonly memberId: string; readonly state: string; readonly requestId?: string;
  }[];
  readonly requests: readonly { readonly id: string; readonly status: string; readonly at: string }[];
  readonly leases: readonly {
    readonly id: string; readonly kind: string; readonly resource: string; readonly expiresAt: string;
  }[];
  readonly warnings: readonly string[];
  readonly omitted: boolean;
};

type Row = { readonly id: string; readonly text: string };
const DISPLAY_LIMIT = 10;

export function sanitizeDashboardText(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadDashboardSnapshot(
  runtime: TeamRuntime,
  membership: Membership,
): Promise<DashboardSnapshot> {
  const [team, peers, inbox, runtimes, leases, receipts] = await Promise.all([
    runtime.teams.read(membership.teamId),
    runtime.memberships.peerPage(membership, 100),
    runtime.delivery.inboxItems(membership, 100),
    runtime.runtimes.list(membership.teamId),
    runtime.leases.list(membership.teamId),
    runtime.receipts.list(membership.teamId, membership.memberId, 100),
  ]);
  if (!team) throw new Error(`Team "${membership.teamId}" is missing.`);
  const members = [
    { id: membership.memberId, alias: sanitizeDashboardText(membership.alias), kind: membership.kind, status: 'online' as const },
    ...peers.peers.map(peer => ({
      id: peer.memberId,
      alias: sanitizeDashboardText(peer.alias),
      kind: peer.kind,
      status: peer.status,
    })),
  ];
  const activeRuntimes = runtimes.filter(record => record.state !== 'terminated' &&
    record.owner.ownerSessionId === membership.sessionId && record.owner.ownerProcessNonce === ownerProcessNonce()).map(record => ({
    id: record.runtimeId,
    memberId: record.memberId,
    state: record.state,
    ...(record.activeRequestId ? { requestId: record.activeRequestId } : {}),
  }));
  const activeLeases = leases.filter(lease => !lease.releasedAt && Date.parse(lease.expiresAt) > Date.now()).map(lease => ({
    id: lease.leaseId,
    kind: lease.kind,
    resource: sanitizeDashboardText(lease.resourceId),
    expiresAt: lease.expiresAt,
  }));
  const warnings = [
    ...(team.state === 'open' ? [] : [`Team state is ${team.state}.`]),
    ...activeRuntimes.filter(record => ['lost', 'stopping'].includes(record.state))
      .map(record => `Runtime ${record.id} is ${record.state}.`),
  ];
  return {
    team: { teamId: team.teamId, state: team.state, alias: sanitizeDashboardText(membership.alias) },
    members,
    inbox: inbox.items.map(item => ({
      id: item.messageId,
      kind: item.kind,
      from: item.fromMemberId,
      createdAt: item.createdAt,
    })),
    runtimes: activeRuntimes,
    requests: receipts.map(receipt => ({ id: receipt.messageId, status: receipt.status, at: receipt.at })),
    leases: activeLeases,
    warnings,
    omitted: inbox.nextCursor !== undefined || peers.nextCursor !== undefined,
  };
}

function dashboardRows(snapshot: DashboardSnapshot): readonly Row[] {
  return [
    { id: 'section-team', text: `TEAM · ${snapshot.team.teamId} · ${snapshot.team.state} · joined as ${snapshot.team.alias}` },
    { id: 'section-members', text: `Members (${snapshot.members.length})` },
    ...snapshot.members.slice(0, DISPLAY_LIMIT).map(member => ({
      id: `member:${member.id}`,
      text: `${member.status === 'online' ? '● online' : '○ offline'} · ${member.alias} · ${member.kind}`,
    })),
    { id: 'section-inbox', text: `Inbox (${snapshot.inbox.length}${snapshot.omitted ? '+' : ''})` },
    ...snapshot.inbox.slice(0, DISPLAY_LIMIT).map(item => ({
      id: `inbox:${item.id}`,
      text: `◇ ${item.kind} · ${item.id} · from ${item.from} · ${item.createdAt}`,
    })),
    { id: 'section-runtimes', text: `Owned runtimes (${snapshot.runtimes.length})` },
    ...snapshot.runtimes.slice(0, DISPLAY_LIMIT).map(runtime => ({
      id: `runtime:${runtime.id}`,
      text: `◆ ${runtime.state} · ${runtime.id} · member ${runtime.memberId}${runtime.requestId ? ` · request ${runtime.requestId}` : ''}`,
    })),
    { id: 'section-requests', text: `Requests (${snapshot.requests.length})` },
    ...snapshot.requests.slice(0, DISPLAY_LIMIT).map(request => ({
      id: `request:${request.id}`,
      text: `◇ ${request.status} · ${request.id} · ${request.at}`,
    })),
    { id: 'section-leases', text: `Leases (${snapshot.leases.length})` },
    ...snapshot.leases.slice(0, DISPLAY_LIMIT).map(lease => ({
      id: `lease:${lease.id}`,
      text: `◇ ${lease.kind} · ${lease.resource} · expires ${lease.expiresAt}`,
    })),
    { id: 'section-warnings', text: `Shutdown/recovery warnings (${snapshot.warnings.length})` },
    ...snapshot.warnings.slice(0, DISPLAY_LIMIT).map((warning, index) => ({ id: `warning:${index}:${warning}`, text: `! warning · ${warning}` })),
    { id: 'section-controls', text: '↑↓ select · Esc close view (operations continue)' },
  ];
}

export function renderDashboard(snapshot: DashboardSnapshot, width: number, selectedId?: string): string[] {
  const safeWidth = Math.max(1, width);
  return dashboardRows(snapshot).map(row => {
    const heading = row.id.startsWith('section-');
    const prefix = row.id === selectedId ? '> ' : heading ? '  ' : '  ';
    return truncateToWidth(`${prefix}${row.text}`, safeWidth);
  });
}

export function dashboardText(snapshot: DashboardSnapshot, width = 80): string {
  return renderDashboard(snapshot, width).join('\n');
}

class DashboardComponent {
  private selectedId?: string;

  constructor(
    private readonly snapshot: DashboardSnapshot,
    private readonly close: () => void,
    private readonly renderRequested: () => void,
  ) {
    this.selectedId = dashboardRows(snapshot).find(row => !row.id.startsWith('section-'))?.id;
  }

  private move(offset: number): void {
    const selectable = dashboardRows(this.snapshot).filter(row => !row.id.startsWith('section-'));
    if (selectable.length === 0) return;
    const current = selectable.findIndex(row => row.id === this.selectedId);
    const next = current < 0 ? 0 : Math.max(0, Math.min(selectable.length - 1, current + offset));
    this.selectedId = selectable[next]?.id;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.close(); return; }
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else return;
    this.renderRequested();
  }

  render(width: number): string[] { return renderDashboard(this.snapshot, width, this.selectedId); }
  invalidate(): void {}
}

export async function openTeamDashboard(context: ExtensionContext, snapshot: DashboardSnapshot): Promise<void> {
  if (!context.hasUI || context.mode !== 'tui') {
    context.ui.notify(dashboardText(snapshot), 'info');
    return;
  }
  await context.ui.custom<void>((tui, _theme, _keybindings, done) =>
    new DashboardComponent(snapshot, () => done(undefined), () => tui.requestRender()));
}
