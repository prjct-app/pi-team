import { Type } from 'typebox';

const enumOf = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const id = Type.String({ minLength: 1, maxLength: 128 });
const name = Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$' });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const timestamp = Type.Number({ minimum: 0 });

export const GoalSchema = Type.Object({
  id,
  objective: Type.String({ minLength: 1, maxLength: 16_000 }),
  status: enumOf('planning', 'active', 'paused', 'blocked', 'verifying', 'ready', 'completed', 'failed'),
  repoRoot: path,
  baseBranch: Type.String({ minLength: 1, maxLength: 255 }),
  baseCommit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
  createdAt: timestamp,
  updatedAt: timestamp,
}, { additionalProperties: false });

export const WorkItemSchema = Type.Object({
  id,
  title: Type.String({ minLength: 1, maxLength: 160 }),
  detail: Type.String({ maxLength: 8_000 }),
  kind: enumOf('plan', 'implementation', 'review', 'verification', 'integration', 'corrective'),
  status: enumOf('queued', 'ready', 'active', 'blocked', 'waiting', 'verifying', 'completed', 'failed', 'cancelled'),
  dependsOn: Type.Array(id, { maxItems: 32 }),
  assignee: Type.Optional(name),
  attempts: Type.Integer({ minimum: 0, maximum: 20 }),
  maxAttempts: Type.Integer({ minimum: 1, maximum: 20 }),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: Type.Optional(timestamp),
  completedAt: Type.Optional(timestamp),
  commit: Type.Optional(Type.String({ minLength: 7, maxLength: 64 })),
  tests: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 50 }),
}, { additionalProperties: false });

export const BlockerSchema = Type.Object({
  id,
  workItemId: id,
  kind: enumOf('dependency', 'conflict', 'test', 'agent', 'approval', 'environment', 'unknown'),
  summary: Type.String({ minLength: 1, maxLength: 240 }),
  detail: Type.String({ maxLength: 4_000 }),
  status: enumOf('open', 'resolving', 'resolved'),
  owner: Type.Optional(name),
  createdAt: timestamp,
  resolvedAt: Type.Optional(timestamp),
}, { additionalProperties: false });

export const ApprovalSchema = Type.Object({
  id,
  kind: enumOf('publish-pr', 'ship'),
  status: enumOf('required', 'granted', 'denied', 'consumed'),
  summary: Type.String({ minLength: 1, maxLength: 240 }),
  requestedAt: timestamp,
  decidedAt: Type.Optional(timestamp),
  actor: Type.Optional(Type.Literal('user')),
  evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
}, { additionalProperties: false });

export const AgentStateSchema = Type.Object({
  alias: name,
  role: Type.String({ minLength: 1, maxLength: 80 }),
  status: enumOf('starting', 'idle', 'active', 'blocked', 'waiting', 'recovering', 'offline', 'completed', 'failed'),
  worktree: path,
  branch: Type.String({ minLength: 1, maxLength: 255 }),
  workItemId: Type.Optional(id),
  sessionFile: Type.Optional(path),
  lastSeen: timestamp,
  restarts: Type.Integer({ minimum: 0, maximum: 100 }),
  activitySeq: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const PeerCommunicationSchema = Type.Object({
  id,
  from: name,
  to: name,
  message: Type.String({ minLength: 1, maxLength: 1_000 }),
  workItemId: Type.Optional(id),
  at: timestamp,
}, { additionalProperties: false });

export const ControlEventSchema = Type.Object({
  id,
  action: enumOf('pause', 'resume', 'retry-work', 'reassign-work', 'cancel-work'),
  actor: Type.Literal('user'),
  target: Type.Optional(id),
  at: timestamp,
}, { additionalProperties: false });

export const WorkRequestSchema = Type.Object({
  id,
  objective: Type.String({ minLength: 1, maxLength: 8_000 }),
  status: enumOf('queued', 'dispatched'),
  requestedBy: id,
  createdAt: timestamp,
  dispatchedAt: Type.Optional(timestamp),
}, { additionalProperties: false });

export const ManagedPlanSchema = Type.Object({
  version: Type.Literal(1),
  team: name,
  leadSession: id,
  goal: GoalSchema,
  workItems: Type.Array(WorkItemSchema, { maxItems: 200 }),
  blockers: Type.Array(BlockerSchema, { maxItems: 200 }),
  approvals: Type.Array(ApprovalSchema, { maxItems: 20 }),
  agents: Type.Array(AgentStateSchema, { maxItems: 8 }),
  requests: Type.Optional(Type.Array(WorkRequestSchema, { maxItems: 100 })),
  controls: Type.Optional(Type.Array(ControlEventSchema, { maxItems: 200 })),
  communications: Type.Optional(Type.Array(PeerCommunicationSchema, { maxItems: 500 })),
}, { additionalProperties: false });

export const ActivityEventSchema = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  at: timestamp,
  alias: name,
  kind: enumOf('lifecycle', 'assignment', 'progress', 'communication', 'tool', 'commit', 'test', 'blocker', 'recovery', 'result'),
  summary: Type.String({ minLength: 1, maxLength: 240 }),
  detail: Type.Optional(Type.String({ maxLength: 2_000 })),
  workItemId: Type.Optional(id),
}, { additionalProperties: false });

export type Goal = {
  id: string; objective: string; status: 'planning' | 'active' | 'paused' | 'blocked' | 'verifying' | 'ready' | 'completed' | 'failed';
  repoRoot: string; baseBranch: string; baseCommit: string; createdAt: number; updatedAt: number;
};
export type WorkItem = {
  id: string; title: string; detail: string;
  kind: 'plan' | 'implementation' | 'review' | 'verification' | 'integration' | 'corrective';
  status: 'queued' | 'ready' | 'active' | 'blocked' | 'waiting' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  dependsOn: string[]; assignee?: string; attempts: number; maxAttempts: number;
  createdAt: number; updatedAt: number; startedAt?: number; completedAt?: number; commit?: string; tests: string[];
};
export type Blocker = {
  id: string; workItemId: string; kind: 'dependency' | 'conflict' | 'test' | 'agent' | 'approval' | 'environment' | 'unknown';
  summary: string; detail: string; status: 'open' | 'resolving' | 'resolved'; owner?: string; createdAt: number; resolvedAt?: number;
};
export type Approval = {
  id: string; kind: 'publish-pr' | 'ship'; status: 'required' | 'granted' | 'denied' | 'consumed';
  summary: string; requestedAt: number; decidedAt?: number; actor?: 'user'; evidence?: string;
};
export type ManagedAgentState = {
  alias: string; role: string; status: 'starting' | 'idle' | 'active' | 'blocked' | 'waiting' | 'recovering' | 'offline' | 'completed' | 'failed';
  worktree: string; branch: string; workItemId?: string; sessionFile?: string; lastSeen: number; restarts: number; activitySeq: number;
};
export type PeerCommunication = { id: string; from: string; to: string; message: string; workItemId?: string; at: number };
export type ControlEvent = { id: string; action: 'pause' | 'resume' | 'retry-work' | 'reassign-work' | 'cancel-work'; actor: 'user'; target?: string; at: number };
export type WorkRequest = { id: string; objective: string; status: 'queued' | 'dispatched'; requestedBy: string; createdAt: number; dispatchedAt?: number };
export type ManagedPlan = {
  version: 1; team: string; leadSession: string; goal: Goal; workItems: WorkItem[];
  blockers: Blocker[]; approvals: Approval[]; agents: ManagedAgentState[]; requests?: WorkRequest[]; controls?: ControlEvent[]; communications?: PeerCommunication[];
};
export type ActivityEvent = {
  seq: number; at: number; alias: string;
  kind: 'lifecycle' | 'assignment' | 'progress' | 'communication' | 'tool' | 'commit' | 'test' | 'blocker' | 'recovery' | 'result';
  summary: string; detail?: string; workItemId?: string;
};

export type Dependency = {
  from: string;
  to: string;
  status: 'waiting' | 'satisfied';
};

export type TeamViewSnapshot = {
  revision: number;
  team: string;
  goal: Goal;
  progress: { completed: number; total: number; percent: number };
  workItems: WorkItem[];
  dependencies: Dependency[];
  blockers: Blocker[];
  approvals: Approval[];
  agents: ManagedAgentState[];
  criticalPath: string[];
  requests?: WorkRequest[];
  controls?: ControlEvent[];
  communications?: PeerCommunication[];
  activity: Record<string, ActivityEvent[]>;
};
