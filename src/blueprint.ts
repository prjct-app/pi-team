import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type { ManagedPlan, WorkItem } from './managed-schema.ts';
import type { ManagedWorktree, RepositoryState } from './worktrees.ts';

const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const id = Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' });
const alias = Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$' });

export const TeamBlueprintSchema = Type.Object({
  agents: Type.Array(Type.Object({
    alias,
    role: Type.String({ minLength: 1, maxLength: 80 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
  workItems: Type.Array(Type.Object({
    id,
    title: Type.String({ minLength: 1, maxLength: 160 }),
    detail: Type.String({ maxLength: 8_000 }),
    kind: enumOf('plan', 'implementation', 'review', 'corrective'),
    dependsOn: Type.Array(id, { maxItems: 32 }),
    assignee: alias,
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
}, { additionalProperties: false });

export type TeamBlueprint = {
  agents: { alias: string; role: string }[];
  workItems: {
    id: string; title: string; detail: string; kind: 'plan' | 'implementation' | 'review' | 'corrective';
    dependsOn: string[]; assignee: string; maxAttempts?: number;
  }[];
};

export function managedTeamName(leadSession: string, objective = ''): string {
  return `team-${createHash('sha256').update(`${leadSession}\0${objective}`).digest('hex').slice(0, 12)}`;
}

export function createPlanningPlan(team: string, leadSession: string, objective: string, repository: RepositoryState, now = Date.now()): ManagedPlan {
  return {
    version: 1,
    team,
    leadSession,
    goal: {
      id: randomUUID(), objective: objective.slice(0, 16_000), status: 'planning', repoRoot: repository.root,
      baseBranch: repository.branch, baseCommit: repository.head, createdAt: now, updatedAt: now,
    },
    workItems: [], blockers: [], approvals: [], agents: [],
  };
}

export function assertBlueprint(value: unknown): asserts value is TeamBlueprint {
  if (!Value.Check(TeamBlueprintSchema, value)) throw new Error('Invalid managed team blueprint');
  const blueprint = value as TeamBlueprint;
  const aliases = blueprint.agents.map(agent => agent.alias);
  const ids = blueprint.workItems.map(item => item.id);
  if (new Set(aliases).size !== aliases.length) throw new Error('Managed peer aliases must be unique');
  if (new Set(ids).size !== ids.length) throw new Error('Managed work item ids must be unique');
  if (ids.some(item => ['integration', 'verification'].includes(item))) throw new Error('integration and verification are reserved work item ids');
  if (blueprint.workItems.some(item => !aliases.includes(item.assignee))) throw new Error('Every peer work item must name a declared assignee');
  const known = new Set(ids);
  if (blueprint.workItems.some(item => item.dependsOn.includes(item.id) || item.dependsOn.some(dependency => !known.has(dependency)))) {
    throw new Error('Blueprint dependencies must reference other work items');
  }
  const byId = new Map(blueprint.workItems.map(item => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(itemId: string): void {
    if (visiting.has(itemId)) throw new Error('Blueprint dependency graph must be acyclic');
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const dependency of byId.get(itemId)!.dependsOn) visit(dependency);
    visiting.delete(itemId);
    visited.add(itemId);
  }
  for (const itemId of ids) visit(itemId);
}

export function applyBlueprint(plan: ManagedPlan, value: unknown, worktrees: ManagedWorktree[], now = Date.now()): ManagedPlan {
  assertBlueprint(value);
  const blueprint = value as TeamBlueprint;
  const byAlias = new Map(worktrees.map(worktree => [worktree.alias, worktree]));
  if (blueprint.agents.some(agent => !byAlias.has(agent.alias))) throw new Error('Every managed peer requires an allocated worktree');
  const workItems: WorkItem[] = blueprint.workItems.map(item => ({
    id: item.id, title: item.title, detail: item.detail, kind: item.kind, status: 'queued', dependsOn: [...item.dependsOn],
    assignee: item.assignee, attempts: 0, maxAttempts: item.maxAttempts ?? 2, createdAt: now, updatedAt: now, tests: [],
  }));
  const integration: WorkItem = {
    id: 'integration', title: 'Integrate completed work', detail: 'Cherry-pick completed peer commits into the dedicated local integration worktree.',
    kind: 'integration', status: 'queued', dependsOn: workItems.map(item => item.id), attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now, tests: [],
  };
  const verification: WorkItem = {
    id: 'verification', title: 'Verify integrated result', detail: 'Run the repository standard verification scripts in the integration worktree.',
    kind: 'verification', status: 'queued', dependsOn: ['integration'], attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now, tests: [],
  };
  return {
    ...plan,
    goal: { ...plan.goal, status: 'active', updatedAt: now },
    workItems: [...workItems, integration, verification],
    agents: blueprint.agents.map(agent => {
      const worktree = byAlias.get(agent.alias)!;
      return {
        alias: agent.alias, role: agent.role, status: 'idle', worktree: worktree.path, branch: worktree.branch,
        lastSeen: now, restarts: 0, activitySeq: 0,
      };
    }),
  };
}
