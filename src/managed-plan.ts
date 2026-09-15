import { lstat, mkdir } from 'node:fs/promises';
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
  if (!unique(ids)) throw new Error('Managed team work item ids must be unique');
  if (!unique(aliases)) throw new Error('Managed team agent aliases must be unique');
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
  if (typed.approvals.some(approval => approval.status !== 'required' && approval.actor !== 'user')) {
    throw new Error('Managed team approvals can only be decided by the user');
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

  async read(team: string): Promise<StoreRecord<ManagedPlan> | undefined> {
    identifier(team);
    return readRecord(this.planPath(team), parse, MAX_BYTES);
  }

  async create(plan: ManagedPlan): Promise<StoreRecord<ManagedPlan>> {
    assertManagedPlan(plan);
    await this.prepare(plan.team);
    if (await this.read(plan.team)) throw new Error(`Managed team "${plan.team}" already exists`);
    return publish(this.planPath(plan.team), 0, plan, parse, {
      maxBytes: MAX_BYTES,
      lockPath: this.lockPath(plan.team),
    });
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
