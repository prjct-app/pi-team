import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
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
  readonly omitted: {
    readonly members: boolean;
    readonly inbox: boolean;
    readonly requests: boolean;
    readonly leases: boolean;
  };
};

type Row = {
  readonly id: string;
  readonly section: string;
  readonly summary: string;
  readonly compact: string;
  readonly details: readonly string[];
  readonly selectable: boolean;
};

type RenderLine = { readonly id?: string; readonly text: string };
type DashboardLayout = 'compact' | 'standard' | 'wide';

const DISPLAY_LIMIT = 10;
const DEFAULT_HEIGHT = 24;
const WIDE_MIN_COLUMNS = 96;
const STANDARD_MIN_COLUMNS = 48;

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
    runtime.leases.page(membership.teamId, 100),
    runtime.receipts.page(membership.teamId, membership.memberId, 100),
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
  const activeLeases = leases.items.filter(lease => !lease.releasedAt && Date.parse(lease.expiresAt) > Date.now()).map(lease => ({
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
    requests: receipts.items.map(receipt => ({ id: receipt.messageId, status: receipt.status, at: receipt.at })),
    leases: activeLeases,
    warnings,
    omitted: {
      members: peers.nextCursor !== undefined,
      inbox: inbox.nextCursor !== undefined,
      requests: receipts.nextCursor !== undefined,
      leases: leases.nextCursor !== undefined,
    },
  };
}

function section(id: string, label: string, count: number, additional = false): Row {
  return {
    id: `section-${id}`,
    section: label,
    summary: `${label} (${count}${additional ? '+' : ''})`,
    compact: `[${label} ${count}${additional ? '+' : ''}]`,
    details: [],
    selectable: false,
  };
}

function moreRow(id: string, sectionName: string, count: number): readonly Row[] {
  return count > DISPLAY_LIMIT ? [{
    id: `section-${id}-more`,
    section: sectionName,
    summary: `… ${count - DISPLAY_LIMIT} more not shown`,
    compact: `… ${count - DISPLAY_LIMIT} more`,
    details: [],
    selectable: false,
  }] : [];
}

function dashboardRows(snapshot: DashboardSnapshot): readonly Row[] {
  const members = snapshot.members.slice(0, DISPLAY_LIMIT).map(member => ({
    id: `member:${member.id}`,
    section: 'Member',
    summary: `${member.status === 'online' ? '● online' : '○ offline'} · ${member.alias} · ${member.kind}`,
    compact: `${member.status === 'online' ? '● online' : '○ offline'} · ${member.alias}`,
    details: [`Member ID: ${member.id}`, `Alias: ${member.alias}`, `Kind: ${member.kind}`, `Status: ${member.status}`],
    selectable: true,
  }));
  const inbox = snapshot.inbox.slice(0, DISPLAY_LIMIT).map(item => ({
    id: `inbox:${item.id}`,
    section: 'Inbox item',
    summary: `◇ ${item.kind} · ${item.id} · from ${item.from} · ${item.createdAt}`,
    compact: `◇ ${item.kind} · from ${item.from}`,
    details: [`Message ID: ${item.id}`, `Kind: ${item.kind}`, `From member: ${item.from}`, `Created: ${item.createdAt}`],
    selectable: true,
  }));
  const runtimes = snapshot.runtimes.slice(0, DISPLAY_LIMIT).map(runtime => ({
    id: `runtime:${runtime.id}`,
    section: 'Owned runtime',
    summary: `◆ ${runtime.state} · ${runtime.id} · member ${runtime.memberId}${runtime.requestId ? ` · request ${runtime.requestId}` : ''}`,
    compact: `◆ ${runtime.state} · member ${runtime.memberId}`,
    details: [
      `Runtime ID: ${runtime.id}`,
      `Member ID: ${runtime.memberId}`,
      `State: ${runtime.state}`,
      ...(runtime.requestId ? [`Request ID: ${runtime.requestId}`] : []),
    ],
    selectable: true,
  }));
  const requests = snapshot.requests.slice(0, DISPLAY_LIMIT).map(request => ({
    id: `request:${request.id}`,
    section: 'Request receipt',
    summary: `◇ ${request.status} · ${request.id} · ${request.at}`,
    compact: `◇ ${request.status} · ${request.id}`,
    details: [`Message ID: ${request.id}`, `Status: ${request.status}`, `Updated: ${request.at}`],
    selectable: true,
  }));
  const leases = snapshot.leases.slice(0, DISPLAY_LIMIT).map(lease => ({
    id: `lease:${lease.id}`,
    section: 'Lease',
    summary: `◇ ${lease.kind} · ${lease.resource} · expires ${lease.expiresAt}`,
    compact: `◇ ${lease.kind} · ${lease.resource}`,
    details: [`Lease ID: ${lease.id}`, `Kind: ${lease.kind}`, `Resource: ${lease.resource}`, `Expires: ${lease.expiresAt}`],
    selectable: true,
  }));
  const warnings = snapshot.warnings.slice(0, DISPLAY_LIMIT).map((warning, index) => ({
    id: `warning:${index}`,
    section: 'Shutdown/recovery warning',
    summary: `! warning · ${warning}`,
    compact: `! warning · ${warning}`,
    details: [`Warning: ${warning}`, 'Closing this view does not cancel or change the operation.'],
    selectable: true,
  }));
  return [
    section('members', 'Members', snapshot.members.length, snapshot.omitted.members),
    ...members,
    ...moreRow('members', 'Members', snapshot.members.length),
    section('inbox', 'Inbox', snapshot.inbox.length, snapshot.omitted.inbox),
    ...inbox,
    ...moreRow('inbox', 'Inbox', snapshot.inbox.length),
    section('runtimes', 'Owned runtimes', snapshot.runtimes.length),
    ...runtimes,
    ...moreRow('runtimes', 'Owned runtimes', snapshot.runtimes.length),
    section('requests', 'Requests', snapshot.requests.length, snapshot.omitted.requests),
    ...requests,
    ...moreRow('requests', 'Requests', snapshot.requests.length),
    section('leases', 'Leases', snapshot.leases.length, snapshot.omitted.leases),
    ...leases,
    ...moreRow('leases', 'Leases', snapshot.leases.length),
    section('warnings', 'Shutdown/recovery warnings', snapshot.warnings.length),
    ...warnings,
    ...moreRow('warnings', 'Shutdown/recovery warnings', snapshot.warnings.length),
    ...(snapshot.omitted.members || snapshot.omitted.inbox || snapshot.omitted.requests || snapshot.omitted.leases ? [{
      id: 'section-page-omitted',
      section: 'Limits',
      summary: '… additional bounded-page records omitted',
      compact: '… more records omitted',
      details: [],
      selectable: false,
    }] : []),
  ];
}

function layoutFor(width: number): DashboardLayout {
  return width >= WIDE_MIN_COLUMNS ? 'wide' : width >= STANDARD_MIN_COLUMNS ? 'standard' : 'compact';
}

function safeLine(value: string, width: number): string {
  return truncateToWidth(sanitizeDashboardText(value), Math.max(1, width));
}

function padLine(value: string, width: number): string {
  const line = safeLine(value, width);
  return `${line}${' '.repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function selectableRows(snapshot: DashboardSnapshot): readonly Row[] {
  return dashboardRows(snapshot).filter(row => row.selectable);
}

export function nextDashboardSelection(
  snapshot: DashboardSnapshot,
  selectedId: string | undefined,
  offset: number,
): string | undefined {
  const rows = selectableRows(snapshot);
  if (rows.length === 0) return undefined;
  const current = rows.findIndex(row => row.id === selectedId);
  const index = current < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, current + offset));
  return rows[index]?.id;
}

function visibleWindow(lines: readonly RenderLine[], height: number, selectedId?: string): readonly string[] {
  if (height <= 0) return [];
  const capacity = Math.max(1, height - 2);
  const selected = Math.max(0, lines.findIndex(line => line.id === selectedId));
  const ideal = selected - Math.floor(capacity / 2);
  const start = Math.max(0, Math.min(Math.max(0, lines.length - capacity), ideal));
  const page = lines.slice(start, start + capacity).map(line => line.text);
  return [
    ...(start > 0 ? [`↑ ${start} more`] : []),
    ...page,
    ...(start + capacity < lines.length ? [`↓ ${lines.length - start - capacity} more`] : []),
  ].slice(0, height);
}

function rowLines(rows: readonly Row[], layout: Exclude<DashboardLayout, 'wide'>, selectedId?: string, expandedId?: string): readonly RenderLine[] {
  return rows.flatMap(row => {
    const prefix = row.id === selectedId ? '> ' : '  ';
    const text = `${prefix}${layout === 'compact' ? row.compact : row.summary}`;
    const detail = row.selectable && row.id === expandedId
      ? row.details.map(value => ({ text: `    ${value}` }))
      : [];
    return [{ id: row.id, text }, ...detail];
  });
}

function selectedDetails(rows: readonly Row[], selectedId: string | undefined): readonly string[] {
  const selected = rows.find(row => row.id === selectedId && row.selectable);
  return selected
    ? [`DETAIL · ${selected.section}`, selected.summary, '', ...selected.details]
    : ['DETAIL', 'Use ↑↓ to select a record.'];
}

function renderWide(rows: readonly Row[], width: number, bodyHeight: number, selectedId?: string): readonly string[] {
  const gap = ' │ ';
  const available = Math.max(2, width - visibleWidth(gap));
  const leftWidth = Math.max(1, Math.floor(available * 0.48));
  const rightWidth = Math.max(1, available - leftWidth);
  const left = visibleWindow(
    rows.map(row => ({ id: row.id, text: `${row.id === selectedId ? '> ' : '  '}${row.compact}` })),
    bodyHeight,
    selectedId,
  );
  const right = selectedDetails(rows, selectedId).slice(0, bodyHeight);
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
    `${padLine(left[index] ?? '', leftWidth)}${gap}${safeLine(right[index] ?? '', rightWidth)}`);
}

function dashboardHeader(snapshot: DashboardSnapshot, width: number, layout: DashboardLayout): string {
  const text = layout === 'compact'
    ? `TEAM ${snapshot.team.teamId} [${snapshot.team.state}] · ${snapshot.team.alias}`
    : `TEAM · ${snapshot.team.teamId} · ${snapshot.team.state} · joined as ${snapshot.team.alias}`;
  return safeLine(text, width);
}

function dashboardFooter(width: number, layout: DashboardLayout): string {
  const text = width < 24
    ? 'Esc close'
    : width < 40
      ? '↑↓ move · Esc close'
      : layout === 'compact'
        ? '↑↓ move · Enter details · Esc close'
        : '↑↓ select · Enter details · Esc close view (operations continue)';
  return safeLine(text, width);
}

export function renderDashboard(
  snapshot: DashboardSnapshot,
  width: number,
  selectedId?: string,
  height = DEFAULT_HEIGHT,
  expandedId?: string,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const layout = layoutFor(safeWidth);
  const header = dashboardHeader(snapshot, safeWidth, layout);
  const footer = dashboardFooter(safeWidth, layout);
  if (safeHeight < 5) {
    return [header, safeLine('Resize terminal; view limited.', safeWidth), footer].slice(0, safeHeight);
  }
  const rows = dashboardRows(snapshot);
  const bodyHeight = safeHeight - 2;
  const body = layout === 'wide'
    ? renderWide(rows, safeWidth, bodyHeight, selectedId)
    : visibleWindow(rowLines(rows, layout, selectedId, expandedId), bodyHeight, selectedId)
      .map(line => safeLine(line, safeWidth));
  return [header, ...body, footer].slice(0, safeHeight);
}

export function dashboardText(snapshot: DashboardSnapshot, width = 80): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows = dashboardRows(snapshot);
  return [
    dashboardHeader(snapshot, safeWidth, layoutFor(safeWidth)),
    ...rows.map(row => safeLine(`  ${row.summary}`, safeWidth)),
    safeLine('Plain snapshot · metadata only · message bodies omitted', safeWidth),
  ].join('\n');
}

class DashboardComponent {
  private selectedId?: string;
  private expandedId?: string;

  constructor(
    private readonly snapshot: DashboardSnapshot,
    private readonly close: () => void,
    private readonly renderRequested: () => void,
    private readonly viewportHeight: () => number,
  ) {
    this.selectedId = selectableRows(snapshot)[0]?.id;
  }

  private select(id: string | undefined): void {
    this.selectedId = id;
    this.expandedId = undefined;
  }

  private move(offset: number): void {
    this.select(nextDashboardSelection(this.snapshot, this.selectedId, offset));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.close(); return; }
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.pageUp)) this.move(-5);
    else if (matchesKey(data, Key.pageDown)) this.move(5);
    else if (matchesKey(data, Key.home)) this.select(nextDashboardSelection(this.snapshot, undefined, 0));
    else if (matchesKey(data, Key.end)) this.select(selectableRows(this.snapshot).at(-1)?.id);
    else if (matchesKey(data, Key.enter)) this.expandedId = this.expandedId === this.selectedId ? undefined : this.selectedId;
    else return;
    this.renderRequested();
  }

  render(width: number): string[] {
    return renderDashboard(this.snapshot, width, this.selectedId, this.viewportHeight(), this.expandedId);
  }

  invalidate(): void {}
}

export async function openTeamDashboard(
  context: ExtensionContext,
  snapshot: DashboardSnapshot,
  writePlain: (text: string) => void = text => process.stdout.write(text),
): Promise<void> {
  if (context.mode === 'print') {
    writePlain(`${dashboardText(snapshot)}\n`);
    return;
  }
  if (!context.hasUI || context.mode !== 'tui') {
    context.ui.notify(dashboardText(snapshot), 'info');
    return;
  }
  await context.ui.custom<void>((tui, _theme, _keybindings, done) =>
    new DashboardComponent(
      snapshot,
      () => done(undefined),
      () => tui.requestRender(),
      () => Math.max(3, tui.terminal.rows - 2),
    ), {
    overlay: true,
    overlayOptions: () => ({ width: '100%', maxHeight: '100%', anchor: 'center', margin: 1 }),
  });
}
