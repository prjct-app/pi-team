import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { identifier } from './mailbox.ts';
import { ManagedPlanSchema, type ActivityEvent, type ManagedPlan, type TeamViewSnapshot, type WorkItem } from './managed-schema.ts';
import { envelope, publish, readRecord, type Record as StoreRecord } from './store.ts';

const MAX_BYTES = 4_000_000;
const MAX_ATTEMPTS = 100;

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function assertPrivateDirectory(path: string, info: { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }): void {
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe managed-team directory: ${path}. Expected a private directory owned by this user.`);
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(path, await lstat(path));
}

export function assertManagedPlan(plan: unknown): asserts plan is ManagedPlan {
  if (!Value.Check(ManagedPlanSchema, plan)) throw new Error('Invalid managed team plan');
  const typed = plan as ManagedPlan;
  const ids = typed.workItems.map(item => item.id);
  const aliases = typed.agents.map(agent => agent.alias);
  const blockerIds = typed.blockers.map(blocker => blocker.id);
  const approvalIds = typed.approvals.map(approval => approval.id);
  const requestIds = (typed.requests ?? []).map(request => request.id);
  const controlIds = (typed.controls ?? []).map(control => control.id);
  const communicationIds = (typed.communications ?? []).map(message => message.id);
  if (!unique(ids)) throw new Error('Managed team work item ids must be unique');
  if (!unique(aliases)) throw new Error('Managed team agent aliases must be unique');
  if (!unique(blockerIds)) throw new Error('Managed team blocker ids must be unique');
  if (!unique(approvalIds)) throw new Error('Managed team approval ids must be unique');
  if (!unique(requestIds)) throw new Error('Managed team request ids must be unique');
  if (!unique(controlIds)) throw new Error('Managed team control ids must be unique');
  if (!unique(communicationIds)) throw new Error('Managed team communication ids must be unique');
  if (typed.workItems.some(item => item.attempts > item.maxAttempts)) throw new Error('Managed team work item attempts cannot exceed maxAttempts');
  const known = new Set(ids);
  if (typed.workItems.some(item => item.dependsOn.includes(item.id) || item.dependsOn.some(dependency => !known.has(dependency)))) {
    throw new Error('Managed team dependencies must reference other work items');
  }
  if (typed.workItems.some(item => item.assignee && !aliases.includes(item.assignee))) {
    throw new Error('Managed team assignments must reference a known agent');
  }
  if (typed.blockers.some(blocker => !known.has(blocker.workItemId))) {
    throw new Error('Managed team blockers must reference a known work item');
  }
  if (typed.agents.some(agent => agent.workItemId && !known.has(agent.workItemId))) {
    throw new Error('Managed team agent state must reference a known work item');
  }
  if ((typed.communications ?? []).some(message => !aliases.includes(message.from) || !aliases.includes(message.to) || (message.workItemId && !known.has(message.workItemId)))) {
    throw new Error('Managed peer communication must reference known agents and work items');
  }
  if ((typed.controls ?? []).some(control => control.target && !known.has(control.target))) {
    throw new Error('Managed control targets must reference known work items');
  }
  if (typed.approvals.some(approval => approval.status === 'required'
    ? approval.actor !== undefined || approval.decidedAt !== undefined || approval.evidence !== undefined
    : approval.actor !== 'user' || approval.decidedAt === undefined || (approval.status === 'consumed' && !approval.evidence))) {
    throw new Error('Managed team approvals can only be decided by the user and must record the decision time');
  }
  const activePeerItems = typed.workItems.filter(item => item.status === 'active' && !['integration', 'verification'].includes(item.kind));
  if (new Set(activePeerItems.map(item => item.assignee)).size !== activePeerItems.length || activePeerItems.some(item => !item.assignee)) {
    throw new Error('Active managed peer work must have one distinct assignee');
  }
  if (typed.agents.some(agent => agent.status === 'active'
    ? !agent.workItemId || !activePeerItems.some(item => item.id === agent.workItemId && item.assignee === agent.alias)
    : agent.workItemId !== undefined)) {
    throw new Error('Managed agent activity must match its assigned active work item');
  }
  if (activePeerItems.some(item => !typed.agents.some(agent => agent.alias === item.assignee && agent.status === 'active' && agent.workItemId === item.id))) {
    throw new Error('Every active managed peer work item must match its agent state');
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(typed.workItems.map(item => [item.id, item]));
  function visit(item: WorkItem): void {
    if (visiting.has(item.id)) throw new Error('Managed team dependency graph must be acyclic');
    if (visited.has(item.id)) return;
    visiting.add(item.id);
    for (const dependency of item.dependsOn) visit(byId.get(dependency)!);
    visiting.delete(item.id);
    visited.add(item.id);
  }
  for (const item of typed.workItems) visit(item);
}

function parse(raw: string): StoreRecord<ManagedPlan> {
  const record = envelope<ManagedPlan>(raw);
  assertManagedPlan(record.payload);
  return record;
}

function criticalPath(items: WorkItem[]): string[] {
  const remaining = items.filter(item => !['completed', 'cancelled'].includes(item.status));
  const byId = new Map(remaining.map(item => [item.id, item]));
  const memo = new Map<string, string[]>();
  function pathTo(item: WorkItem): string[] {
    const found = memo.get(item.id);
    if (found) return found;
    const candidates = item.dependsOn.map(dependency => byId.get(dependency)).filter(value => !!value).map(pathTo);
    const longest = candidates.reduce<string[]>((best, candidate) => candidate.length > best.length ? candidate : best, []);
    const result = [...longest, item.id];
    memo.set(item.id, result);
    return result;
  }
  return remaining.map(pathTo).reduce<string[]>((best, candidate) => candidate.length > best.length ? candidate : best, []);
}

export function buildTeamView(revision: number, plan: ManagedPlan, activity: Record<string, ActivityEvent[]> = {}): TeamViewSnapshot {
  assertManagedPlan(plan);
  const completed = plan.workItems.filter(item => item.status === 'completed').length;
  const total = plan.workItems.filter(item => item.status !== 'cancelled').length;
  return {
    revision,
    team: plan.team,
    goal: structuredClone(plan.goal),
    progress: { completed, total, percent: total ? Math.round(completed * 100 / total) : 0 },
    workItems: structuredClone(plan.workItems),
    dependencies: plan.workItems.flatMap(item => item.dependsOn.map(dependency => ({
      from: dependency,
      to: item.id,
      status: plan.workItems.find(candidate => candidate.id === dependency)?.status === 'completed' ? 'satisfied' as const : 'waiting' as const,
    }))),
    blockers: structuredClone(plan.blockers.filter(blocker => blocker.status !== 'resolved')),
    approvals: structuredClone(plan.approvals.filter(approval => approval.status === 'required')),
    agents: structuredClone(plan.agents),
    criticalPath: criticalPath(plan.workItems),
    requests: structuredClone(plan.requests ?? []),
    controls: structuredClone(plan.controls ?? []),
    communications: structuredClone(plan.communications ?? []),
    activity: structuredClone(activity),
  };
}

export class ManagedPlanStore {
  constructor(readonly root: string) {}

  private teamPath(team: string): string { return join(this.root, identifier(team)); }
  private planPath(team: string): string { return join(this.teamPath(team), 'plan.json'); }
  private lockPath(team: string): string { return join(this.root, '.locks', `${identifier(team)}-plan.lock`); }

  private async prepare(team: string): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, '.locks'));
    await privateDirectory(this.teamPath(team));
  }

  async list(): Promise<StoreRecord<ManagedPlan>[]> {
    await privateDirectory(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    const teams = entries.filter(entry => entry.isDirectory() && entry.name !== '.locks' && /^[a-z][a-z0-9-]{0,47}$/.test(entry.name));
    const records = await Promise.all(teams.map(entry => this.read(entry.name)));
    return records.filter((record): record is StoreRecord<ManagedPlan> => !!record)
      .sort((left, right) => right.payload.goal.updatedAt - left.payload.goal.updatedAt || left.payload.team.localeCompare(right.payload.team));
  }

  async forRepository(repoRoot: string): Promise<StoreRecord<ManagedPlan>[]> {
    return (await this.list()).filter(record => record.payload.goal.repoRoot === repoRoot);
  }

  async read(team: string): Promise<StoreRecord<ManagedPlan> | undefined> {
    identifier(team);
    return readRecord(this.planPath(team), parse, MAX_BYTES);
  }

  async create(plan: ManagedPlan): Promise<StoreRecord<ManagedPlan>> {
    assertManagedPlan(plan);
    await this.prepare(plan.team);
    if (await this.read(plan.team)) throw new Error(`Managed team "${plan.team}" already exists`);
    return this.createAttempt(plan, MAX_ATTEMPTS);
  }

  private async createAttempt(plan: ManagedPlan, remaining: number): Promise<StoreRecord<ManagedPlan>> {
    if (remaining < 1) throw new Error(`Managed team \"${plan.team}\" already exists or is being created`);
    try {
      return await publish(this.planPath(plan.team), 0, plan, parse, {
        maxBytes: MAX_BYTES,
        lockPath: this.lockPath(plan.team),
      });
    } catch (error) {
      if (!['STALE_REVISION', 'RECORD_LOCKED'].includes((error as { code?: string }).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 25));
      if (await this.read(plan.team)) throw new Error(`Managed team \"${plan.team}\" already exists`);
      return this.createAttempt(plan, remaining - 1);
    }
  }

  async update(team: string, transform: (current: ManagedPlan) => ManagedPlan): Promise<StoreRecord<ManagedPlan>> {
    await this.prepare(team);
    return this.updateAttempt(team, transform, MAX_ATTEMPTS);
  }

  private async updateAttempt(team: string, transform: (current: ManagedPlan) => ManagedPlan, remaining: number): Promise<StoreRecord<ManagedPlan>> {
    if (remaining < 1) throw new Error('Managed team plan is busy; try again.');
    const current = await this.read(team);
    if (!current) throw new Error(`Unknown managed team "${team}"`);
    const next = transform(structuredClone(current.payload));
    assertManagedPlan(next);
    if (next.team !== team) throw new Error('Managed team updates cannot rename the team');
    try {
      return await publish(this.planPath(team), current.revision, next, parse, {
        maxBytes: MAX_BYTES,
        lockPath: this.lockPath(team),
      });
    } catch (error) {
      if (!['STALE_REVISION', 'RECORD_LOCKED'].includes((error as { code?: string }).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 25));
      return this.updateAttempt(team, transform, remaining - 1);
    }
  }

  async snapshot(team: string, activity: Record<string, ActivityEvent[]> = {}): Promise<TeamViewSnapshot> {
    const record = await this.read(team);
    if (!record) throw new Error(`Unknown managed team "${team}"`);
    return buildTeamView(record.revision, record.payload, activity);
  }
}
