import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { sanitizeActivityText } from './activity.ts';
import type { ActivityEvent, ManagedAgentState, TeamViewSnapshot, WorkItem } from './managed-schema.ts';

type Tab = 'plan' | 'agents' | 'blockers';
type PanelOptions = {
  tui: Pick<TUI, 'requestRender'>;
  theme: Theme;
  initial: TeamViewSnapshot;
  load: () => Promise<TeamViewSnapshot>;
  done: () => void;
  refreshMs?: number;
};

const TABS: Tab[] = ['plan', 'agents', 'blockers'];
const STATUS_SYMBOL: Record<string, string> = {
  planning: '◌', starting: '◌', queued: '○', ready: '◉', active: '●', busy: '●',
  blocked: '◆', waiting: '◐', recovering: '↻', verifying: '◇', completed: '✓',
  failed: '✕', cancelled: '−', offline: '○', idle: '·',
};

function safe(text: string, limit = 2_000): string {
  return sanitizeActivityText(text, limit).replace(/\s+/g, ' ').trim();
}

function fit(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return `${truncated}${' '.repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function statusColor(status: string): 'success' | 'error' | 'warning' | 'accent' | 'muted' | 'dim' {
  if (status === 'completed' || status === 'ready') return 'success';
  if (status === 'failed' || status === 'blocked') return 'error';
  if (status === 'waiting' || status === 'recovering' || status === 'verifying') return 'warning';
  if (status === 'active' || status === 'starting') return 'accent';
  return status === 'offline' || status === 'cancelled' ? 'dim' : 'muted';
}

function statusText(theme: Theme, status: string): string {
  return theme.fg(statusColor(status), `${STATUS_SYMBOL[status] ?? '·'} ${status}`);
}

function workLabel(item: WorkItem, theme: Theme, critical: Set<string>): string {
  const path = critical.has(item.id) ? theme.fg('warning', '⚑') : ' ';
  const assignee = item.assignee ? ` · ${safe(item.assignee, 48)}` : '';
  return `${path} ${statusText(theme, item.status)} · ${safe(item.title, 160)}${assignee}`;
}

function agentLabel(agent: ManagedAgentState, theme: Theme, selected: boolean): string {
  const marker = selected ? theme.fg('accent', '›') : ' ';
  const task = agent.workItemId ? ` · ${safe(agent.workItemId, 128)}` : '';
  return `${marker} ${statusText(theme, agent.status)} · ${safe(agent.alias, 48)} · ${safe(agent.role, 80)}${task}`;
}

function activityLabel(event: ActivityEvent, theme: Theme): string {
  const time = new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${theme.fg('dim', time)} ${theme.fg(statusColor(event.kind === 'blocker' ? 'blocked' : event.kind === 'result' ? 'completed' : 'active'), STATUS_SYMBOL[event.kind === 'blocker' ? 'blocked' : event.kind === 'result' ? 'completed' : 'active'] ?? '·')} ${safe(event.summary, 240)}`;
}

export function teamWidget(snapshot: TeamViewSnapshot): string {
  const active = snapshot.agents.filter(agent => ['active', 'starting', 'recovering'].includes(agent.status)).length;
  const blocker = snapshot.blockers.length ? ` · ${snapshot.blockers.length} blocked` : '';
  const approval = snapshot.approvals.length ? ` · approval required` : '';
  return `${safe(snapshot.team, 48)} · ${STATUS_SYMBOL[snapshot.goal.status] ?? '·'} ${snapshot.goal.status} · ${snapshot.progress.percent}% · ${active}/${snapshot.agents.length} active${blocker}${approval}`;
}

function progressBar(completed: number, total: number, width = 8): string {
  const filled = total ? Math.round(Math.max(0, Math.min(1, completed / total)) * width) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function teamWidgetLines(snapshot: TeamViewSnapshot, theme: Theme, width: number): string[] {
  const priority: Record<WorkItem['status'], number> = {
    active: 0, verifying: 0, blocked: 1, ready: 2, waiting: 3, queued: 4, failed: 5, completed: 6, cancelled: 7,
  };
  const ordered = snapshot.workItems.map((item, index) => ({ item, index }))
    .sort((left, right) => priority[left.item.status] - priority[right.item.status] || left.index - right.index)
    .map(value => value.item);
  const visible = ordered.slice(0, 8);
  const remaining = Math.max(0, ordered.length - visible.length);
  const critical = new Set(snapshot.criticalPath);
  const title = theme.fg('accent', theme.bold(`▸ ${safe(snapshot.team, 48)} ${snapshot.progress.completed}/${snapshot.progress.total}`));
  const barColor = snapshot.goal.status === 'completed' ? 'success' : snapshot.goal.status === 'blocked' || snapshot.goal.status === 'failed' ? 'error' : 'accent';
  const lines = [
    `${title} ${theme.fg(barColor, progressBar(snapshot.progress.completed, snapshot.progress.total))}${theme.fg('muted', ` ${snapshot.progress.percent}% · ${snapshot.goal.status}`)}`,
    ...visible.map(item => workLabel(item, theme, critical)),
    ...(remaining ? [theme.fg('dim', `  … ${remaining} more work item${remaining === 1 ? '' : 's'}`)] : []),
    ...snapshot.blockers.slice(0, 2).map(blocker => `${theme.fg('error', '◆ blocker')} · ${safe(blocker.summary, 240)}`),
    ...snapshot.approvals.slice(0, 2).map(approval => `${theme.fg('warning', '◆ approval')} · ${approval.kind} · ${safe(approval.summary, 240)}`),
    theme.fg('dim', '/team plan · activity and details'),
  ];
  return lines.map(line => truncateToWidth(line, width));
}

export class TeamPlanPanel implements Component, Focusable {
  focused = true;
  private snapshot: TeamViewSnapshot;
  private tab: Tab = 'plan';
  private selectedAlias?: string;
  private follow = true;
  private activityOffset = 0;
  private closed = false;
  private refreshToken = 0;
  private protectedRevision?: number;
  private timer?: ReturnType<typeof setInterval>;
  private rowAliases = new Map<number, string>();

  constructor(private readonly options: PanelOptions) {
    this.snapshot = structuredClone(options.initial);
    this.selectedAlias = this.snapshot.agents[0]?.alias;
    const timer = setInterval(() => { void this.refresh(); }, options.refreshMs ?? 750);
    timer.unref();
    this.timer = timer;
  }

  private async refresh(): Promise<void> {
    const token = ++this.refreshToken;
    try {
      const next = await this.options.load();
      if (this.closed || token !== this.refreshToken || next.revision < this.snapshot.revision || (this.protectedRevision !== undefined && next.revision <= this.protectedRevision)) return;
      this.protectedRevision = undefined;
      this.snapshot = structuredClone(next);
      if (!this.snapshot.agents.some(agent => agent.alias === this.selectedAlias)) { this.selectedAlias = this.snapshot.agents[0]?.alias; this.activityOffset = 0; }
      this.options.tui.requestRender();
    } catch { /* The next refresh retries without replacing the last good snapshot. */ }
  }

  setSnapshot(snapshot: TeamViewSnapshot): void {
    if (snapshot.revision < this.snapshot.revision) return;
    this.refreshToken++;
    this.protectedRevision = snapshot.revision;
    this.snapshot = structuredClone(snapshot);
    if (!this.snapshot.agents.some(agent => agent.alias === this.selectedAlias)) { this.selectedAlias = this.snapshot.agents[0]?.alias; this.activityOffset = 0; }
    this.options.tui.requestRender();
  }

  private select(delta: number): void {
    if (!this.snapshot.agents.length) return;
    const current = Math.max(0, this.snapshot.agents.findIndex(agent => agent.alias === this.selectedAlias));
    const index = Math.max(0, Math.min(this.snapshot.agents.length - 1, current + delta));
    this.selectedAlias = this.snapshot.agents[index]?.alias;
    this.follow = true;
    this.activityOffset = 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'q')) { this.options.done(); return; }
    if (matchesKey(data, 'tab')) {
      this.tab = TABS[(TABS.indexOf(this.tab) + 1) % TABS.length]!;
    } else if (matchesKey(data, '1')) this.tab = 'plan';
    else if (matchesKey(data, '2')) this.tab = 'agents';
    else if (matchesKey(data, '3')) this.tab = 'blockers';
    else if (matchesKey(data, 'up')) { this.tab = 'agents'; this.select(-1); }
    else if (matchesKey(data, 'down')) { this.tab = 'agents'; this.select(1); }
    else if (matchesKey(data, 'pageUp')) { this.tab = 'agents'; this.follow = false; this.activityOffset += 5; }
    else if (matchesKey(data, 'pageDown')) { this.tab = 'agents'; this.activityOffset = Math.max(0, this.activityOffset - 5); this.follow = this.activityOffset === 0; }
    else if (matchesKey(data, 'f')) { this.follow = true; this.activityOffset = 0; }
    else return;
    this.options.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return;
    const alias = this.rowAliases.get(event.y);
    if (!alias) return;
    this.tab = 'agents';
    this.selectedAlias = alias;
    this.follow = true;
    this.activityOffset = 0;
    this.options.tui.requestRender();
    return { handled: true, focus: true, render: true };
  }

  private planLines(): string[] {
    const critical = new Set(this.snapshot.criticalPath);
    const work = this.snapshot.workItems.length
      ? this.snapshot.workItems.map(item => workLabel(item, this.options.theme, critical))
      : [this.options.theme.fg('dim', 'No work items yet; the lead is planning.')];
    const dependencies = this.snapshot.dependencies.filter(edge => edge.status === 'waiting');
    return [
      this.options.theme.bold('Work plan'),
      ...work,
      ...(dependencies.length ? ['', this.options.theme.bold('Waiting dependencies'), ...dependencies.slice(0, 8).map(edge => `  ${safe(edge.from, 128)} → ${safe(edge.to, 128)}`)] : []),
    ];
  }

  private agentLines(startRow: number): string[] {
    const rows = this.snapshot.agents.length
      ? this.snapshot.agents.map(agent => agentLabel(agent, this.options.theme, agent.alias === this.selectedAlias))
      : [this.options.theme.fg('dim', 'No managed agents have started.')];
    this.rowAliases = new Map(this.snapshot.agents.map((agent, index) => [startRow + 1 + index, agent.alias]));
    const selected = this.snapshot.agents.find(agent => agent.alias === this.selectedAlias);
    if (!selected) return [this.options.theme.bold('Agents'), ...rows];
    const events = this.snapshot.activity[selected.alias] ?? [];
    const end = Math.max(0, events.length - Math.min(this.activityOffset, Math.max(0, events.length - 1)));
    const activity = events.slice(Math.max(0, end - 8), end).map(event => activityLabel(event, this.options.theme));
    return [
      this.options.theme.bold('Agents'), ...rows, '',
      `${this.options.theme.bold(safe(selected.alias, 48))} · ${safe(selected.branch, 255)}`,
      this.options.theme.fg('dim', safe(selected.worktree, 4096)),
      `${this.options.theme.bold('Activity')} · follow ${this.follow ? 'on' : 'off'}`,
      ...(activity.length ? activity : [this.options.theme.fg('dim', 'No structured activity yet.')]),
    ];
  }

  private blockerLines(): string[] {
    const blockers = this.snapshot.blockers.length
      ? this.snapshot.blockers.map(blocker => `${statusText(this.options.theme, blocker.status === 'open' ? 'blocked' : 'recovering')} · ${safe(blocker.summary, 240)} · ${safe(blocker.workItemId, 128)}`)
      : [this.options.theme.fg('success', '✓ No open blockers')];
    const approvals = this.snapshot.approvals.length
      ? this.snapshot.approvals.map(approval => `${this.options.theme.fg('warning', '◆ approval')} · ${approval.kind} · ${safe(approval.summary, 240)}`)
      : [this.options.theme.fg('dim', 'No approval is currently required.')];
    const requests = (this.snapshot.requests ?? []).slice(-8).map(request => `${request.status === 'queued' ? '○' : '✓'} ${request.status} · ${safe(request.objective, 160)}`);
    const controls = (this.snapshot.controls ?? []).slice(-8).map(control => `${new Date(control.at).toLocaleTimeString()} · user ${control.action}${control.target ? ` · ${safe(control.target, 128)}` : ''}`);
    const communications = (this.snapshot.communications ?? []).slice(-12).map(message => `${new Date(message.at).toLocaleTimeString()} · ${safe(message.from, 48)} → ${safe(message.to, 48)} · ${safe(message.message, 1_000)}`);
    return [this.options.theme.bold('Blockers'), ...blockers, '', this.options.theme.bold('Human gates'), ...approvals,
      '', this.options.theme.bold('Peer communication'), ...(communications.length ? communications : [this.options.theme.fg('dim', 'No structured peer messages.')]),
      '', this.options.theme.bold('Cross-session requests'), ...(requests.length ? requests : [this.options.theme.fg('dim', 'No queued team requests.')]),
      '', this.options.theme.bold('User control audit'), ...(controls.length ? controls : [this.options.theme.fg('dim', 'No control actions recorded.')])];
  }

  render(width: number): string[] {
    if (width < 4) return [' '.repeat(Math.max(0, width))];
    this.rowAliases = new Map();
    const theme = this.options.theme;
    const inner = width - 2;
    const tabs = TABS.map(tab => tab === this.tab ? theme.fg('accent', theme.bold(`[${tab}]`)) : theme.fg('dim', tab)).join('  ');
    const header = [
      `${theme.bold('Team Plan')} · ${theme.fg('accent', safe(this.snapshot.team, 48))} · ${statusText(theme, this.snapshot.goal.status)} · ${this.snapshot.progress.completed}/${this.snapshot.progress.total} (${this.snapshot.progress.percent}%)`,
      safe(this.snapshot.goal.objective, 16_000),
      tabs,
      '',
    ];
    const body = this.tab === 'plan' ? this.planLines() : this.tab === 'agents' ? this.agentLines(header.length + 1) : this.blockerLines();
    const footer = ['', theme.fg('dim', '1 plan · 2 agents · 3 trace/control · ↑↓ select · PgUp/PgDn activity · f follow · /team control · Esc close')];
    const content = [...header, ...body, ...footer].map(line => `│${fit(line, inner)}│`);
    return [`╭${'─'.repeat(inner)}╮`, ...content, `╰${'─'.repeat(inner)}╯`];
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    this.refreshToken++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
