import { randomUUID } from 'node:crypto';
import { ActivityJournal, sanitizeActivityText } from './activity.ts';
import { ManagedPlanStore } from './managed-plan.ts';
import type { ActivityEvent, ManagedAgentState, ManagedPlan, WorkItem } from './managed-schema.ts';

export type ExecutionResult = {
  outcome: 'completed' | 'failed' | 'interrupted';
  summary: string;
  commit?: string;
  tests?: string[];
};

export type SchedulerRuntime = {
  execute(plan: ManagedPlan, item: WorkItem, agent?: ManagedAgentState): Promise<ExecutionResult>;
  now(): number;
};

type Launch = { item: WorkItem; agent?: ManagedAgentState };
type ActivityInput = Pick<ActivityEvent, 'kind' | 'summary' | 'detail' | 'workItemId'>;

function terminal(item: WorkItem): boolean {
  return ['completed', 'failed', 'cancelled'].includes(item.status);
}

function dependencies(item: WorkItem, plan: ManagedPlan): WorkItem[] {
  const byId = new Map(plan.workItems.map(candidate => [candidate.id, candidate]));
  return item.dependsOn.map(id => byId.get(id)!).filter(value => !!value);
}

function nextStatus(item: WorkItem, plan: ManagedPlan): WorkItem['status'] {
  if (terminal(item) || item.status === 'active' || item.status === 'verifying') return item.status;
  const needs = dependencies(item, plan);
  if (needs.some(dependency => ['failed', 'cancelled', 'blocked'].includes(dependency.status))) return 'blocked';
  return needs.every(dependency => dependency.status === 'completed') ? 'ready' : 'waiting';
}

function eligibleAgent(item: WorkItem, agents: ManagedAgentState[], reserved: Set<string>): ManagedAgentState | undefined {
  if (['integration', 'verification'].includes(item.kind)) return undefined;
  const available = agents.filter(agent => !reserved.has(agent.alias) && ['idle', 'recovering'].includes(agent.status) && (!item.assignee || item.assignee === agent.alias));
  return available.find(agent => agent.status === 'idle') ?? available[0];
}

export function scheduleReady(plan: ManagedPlan, now: number): { plan: ManagedPlan; launches: Launch[] } {
  if (plan.goal.status === 'paused') return { plan, launches: [] };
  const normalized = plan.workItems.map(item => {
    const status = nextStatus(item, plan);
    const unavailable = item.assignee && plan.agents.some(agent => agent.alias === item.assignee && ['failed', 'offline'].includes(agent.status));
    return { ...item, status, ...(unavailable && status !== 'active' ? { assignee: undefined } : {}), updatedAt: item.status === status ? item.updatedAt : now };
  });
  const base = { ...plan, workItems: normalized };
  const reserved = new Set<string>();
  const localReserved = { value: normalized.some(item => ['active', 'verifying'].includes(item.status) && ['integration', 'verification'].includes(item.kind)) };
  const launches = normalized.reduce<Launch[]>((all, item) => {
    if (item.status !== 'ready') return all;
    if (['integration', 'verification'].includes(item.kind)) {
      if (localReserved.value) return all;
      localReserved.value = true;
      return [...all, { item }];
    }
    const agent = eligibleAgent(item, base.agents, reserved);
    if (!agent) return all;
    reserved.add(agent.alias);
    return [...all, { item, agent }];
  }, []);
  const launchIds = new Set(launches.map(launch => launch.item.id));
  const assignments = new Map(launches.filter(launch => !!launch.agent).map(launch => [launch.agent!.alias, launch.item.id]));
  const itemAssignments = new Map(launches.filter(launch => !!launch.agent).map(launch => [launch.item.id, launch.agent!.alias]));
  const workItems = normalized.map(item => launchIds.has(item.id) ? {
    ...item,
    status: item.kind === 'verification' ? 'verifying' as const : 'active' as const,
    attempts: item.attempts + 1,
    startedAt: item.startedAt ?? now,
    updatedAt: now,
    ...(itemAssignments.has(item.id) ? { assignee: itemAssignments.get(item.id) } : {}),
  } : item);
  const agents = base.agents.map(agent => assignments.has(agent.alias) ? {
    ...agent, status: 'active' as const, workItemId: assignments.get(agent.alias), lastSeen: now,
  } : agent.status === 'recovering' ? { ...agent, status: 'idle' as const, restarts: agent.restarts + 1, lastSeen: now } : agent);
  const blocked = base.blockers.some(blocker => blocker.status !== 'resolved') || workItems.some(item => item.status === 'failed');
  const goalStatus = blocked ? 'blocked' as const : launches.length ? 'active' as const : base.goal.status;
  return { plan: { ...base, workItems, agents, goal: { ...base.goal, status: goalStatus, updatedAt: now } }, launches };
}

function finishPlan(plan: ManagedPlan, itemId: string, result: ExecutionResult, now: number, blockerId: string, approvalId: string): ManagedPlan {
  const current = plan.workItems.find(item => item.id === itemId);
  if (!current || !['active', 'verifying'].includes(current.status)) return plan;
  const safeSummary = sanitizeActivityText(result.summary, 4_000).trim();
  const retry = result.outcome !== 'completed' && current.attempts < current.maxAttempts;
  const correctionNumber = plan.workItems.filter(item => item.kind === 'corrective').length + 1;
  const correctiveAssignee = plan.agents.find(agent => !['failed', 'offline'].includes(agent.status))?.alias;
  if (result.outcome !== 'completed' && !retry && current.kind === 'verification' && correctionNumber <= 2 && correctiveAssignee) {
    const dependency = current.dependsOn[0]!;
    const correctiveId = `corrective-${correctionNumber}`;
    const integrationId = `integration-${correctionNumber}`;
    const verificationId = `verification-${correctionNumber}`;
    const corrective: WorkItem = { id: correctiveId, title: `Correct verification failure ${correctionNumber}`, detail: safeSummary,
      kind: 'corrective', status: 'queued', dependsOn: [dependency], assignee: correctiveAssignee, attempts: 0, maxAttempts: 2, createdAt: now, updatedAt: now, tests: [] };
    const integration: WorkItem = { id: integrationId, title: `Integrate corrective work ${correctionNumber}`, detail: 'Integrate the corrective peer commit locally.',
      kind: 'integration', status: 'queued', dependsOn: [correctiveId], attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now, tests: [] };
    const verification: WorkItem = { id: verificationId, title: `Verify corrective work ${correctionNumber}`, detail: 'Re-run standard verification after corrective integration.',
      kind: 'verification', status: 'queued', dependsOn: [integrationId], attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now, tests: [] };
    return { ...plan,
      workItems: [...plan.workItems.map(item => item.id === itemId ? { ...item, status: 'cancelled' as const, updatedAt: now, tests: result.tests ?? item.tests } : item), corrective, integration, verification],
      goal: { ...plan.goal, status: 'active', updatedAt: now },
    };
  }
  const status: WorkItem['status'] = result.outcome === 'completed' ? 'completed' : retry ? 'ready' : 'failed';
  const workItems = plan.workItems.map(item => item.id === itemId ? {
    ...item, status, updatedAt: now,
    ...(status === 'completed' ? { completedAt: now } : {}),
    ...(result.commit ? { commit: result.commit } : {}),
    tests: result.tests ?? item.tests,
    ...(retry ? { assignee: undefined } : {}),
  } : item);
  const agents = plan.agents.map(agent => agent.workItemId === itemId ? {
    ...agent, status: retry ? 'recovering' as const : result.outcome === 'completed' ? 'idle' as const : 'failed' as const,
    workItemId: undefined, lastSeen: now,
  } : agent);
  const failed = status === 'failed';
  const blockerExists = plan.blockers.some(blocker => blocker.workItemId === itemId && blocker.status !== 'resolved');
  const blockers = failed && !blockerExists ? [...plan.blockers, {
    id: blockerId, workItemId: itemId, kind: result.outcome === 'interrupted' ? 'agent' as const : 'unknown' as const,
    summary: safeSummary.slice(0, 240) || `Work item ${itemId} failed`, detail: safeSummary,
    status: 'open' as const, owner: current.assignee, createdAt: now,
  }] : plan.blockers;
  const activeItems = workItems.filter(item => !terminal(item));
  const blocked = workItems.some(item => item.status === 'failed') || blockers.some(blocker => blocker.status !== 'resolved');
  const goalStatus = blocked ? 'blocked' as const : activeItems.length ? plan.goal.status : 'ready' as const;
  const approvals = !activeItems.length && !workItems.some(item => item.status === 'failed') && !plan.approvals.some(approval => approval.kind === 'publish-pr')
    ? [...plan.approvals, { id: approvalId, kind: 'publish-pr' as const, status: 'required' as const, summary: `Publish integration branch pi-team/${plan.team}/integration and create a pull request`, requestedAt: now }]
    : plan.approvals;
  return { ...plan, workItems, agents, blockers, approvals, goal: { ...plan.goal, status: goalStatus, updatedAt: now } };
}

export class ManagedScheduler {
  private serial: Promise<unknown> = Promise.resolve();
  private running = new Set<string>();
  private stopped = false;
  private started = false;
  private ownerEpoch = 0;

  constructor(
    readonly team: string,
    readonly store: ManagedPlanStore,
    readonly journal: ActivityJournal,
    readonly runtime: SchedulerRuntime,
  ) {}

  private queue<T>(action: () => Promise<T>): Promise<T> {
    const work = this.serial.then(action);
    this.serial = work.catch(() => {});
    return work;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const now = this.runtime.now();
    try {
      await this.queue(async () => {
        await this.store.update(this.team, plan => ({
          ...plan,
          workItems: plan.workItems.map(item => ['active', 'verifying'].includes(item.status) ? { ...item, status: 'ready', attempts: Math.max(0, item.attempts - 1), updatedAt: now } : item),
          agents: plan.agents.map(agent => agent.status === 'active' ? { ...agent, status: 'idle', workItemId: undefined, restarts: agent.restarts + 1, lastSeen: now } : agent),
        }));
        await this.pump();
      });
    } catch (error) { this.started = false; throw error; }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ownerEpoch++;
  }

  async kick(): Promise<void> {
    await this.queue(() => this.pump());
  }

  async recordActivity(alias: string, input: ActivityInput): Promise<void> {
    if (this.stopped) return;
    await this.queue(() => this.stopped ? Promise.resolve() : this.appendActivity(alias, input));
  }

  private async appendActivity(alias: string, input: ActivityInput): Promise<void> {
    const now = this.runtime.now();
    const record = await this.store.update(this.team, plan => ({
      ...plan,
      agents: plan.agents.map(agent => agent.alias === alias ? { ...agent, activitySeq: agent.activitySeq + 1, lastSeen: now } : agent),
    }));
    const agent = record.payload.agents.find(candidate => candidate.alias === alias);
    if (!agent) return;
    await this.journal.append(this.team, { seq: agent.activitySeq, at: now, alias, ...input });
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    const epoch = this.ownerEpoch;
    const now = this.runtime.now();
    const updated = await this.store.update(this.team, plan => scheduleReady(plan, now).plan);
    if (this.stopped || epoch !== this.ownerEpoch) return;
    const launches = updated.payload.workItems
      .filter(item => ['active', 'verifying'].includes(item.status) && item.updatedAt === now && !this.running.has(item.id))
      .map(item => ({ item, agent: updated.payload.agents.find(agent => agent.workItemId === item.id) }));
    for (const launch of launches) {
      this.running.add(launch.item.id);
      if (launch.agent) await this.appendActivity(launch.agent.alias, { kind: 'assignment', summary: `Started ${launch.item.title}`, workItemId: launch.item.id });
    }
    for (const launch of launches) {
      if (this.stopped || epoch !== this.ownerEpoch) { this.running.delete(launch.item.id); continue; }
      void this.runtime.execute(updated.payload, launch.item, launch.agent)
        .then(result => this.queue(() => this.finish(launch, result, epoch)))
        .catch(error => this.queue(() => this.finish(launch, { outcome: 'failed', summary: error instanceof Error ? error.message : String(error) }, epoch)));
    }
  }

  private async finish(launch: Launch, result: ExecutionResult, epoch: number): Promise<void> {
    this.running.delete(launch.item.id);
    if (this.stopped || epoch !== this.ownerEpoch) return;
    const now = this.runtime.now();
    const blockerId = randomUUID();
    const approvalId = randomUUID();
    const updated = await this.store.update(this.team, plan => this.stopped || epoch !== this.ownerEpoch
      ? plan : finishPlan(plan, launch.item.id, result, now, blockerId, approvalId));
    if (this.stopped || epoch !== this.ownerEpoch) return;
    if (launch.agent) {
      const cancelled = updated.payload.workItems.find(item => item.id === launch.item.id)?.status === 'cancelled';
      await this.appendActivity(launch.agent.alias, {
        kind: cancelled ? 'lifecycle' : result.outcome === 'completed' ? 'result' : 'blocker',
        summary: cancelled ? `Stopped ${launch.item.title}; its late result was discarded` : result.summary,
        workItemId: launch.item.id,
      });
    }
    await this.pump();
  }

  async idle(): Promise<void> {
    await this.serial;
    if (this.running.size) {
      await new Promise(resolve => setTimeout(resolve, 10));
      return this.idle();
    }
    await this.serial;
  }
}
