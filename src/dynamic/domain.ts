import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { StringEnum } from '@earendil-works/pi-ai';
import { EntityIdSchema, TimestampSchema } from '../domain/team.ts';

export const LIMITS = { runs: 64, assignments: 128, experts: 16, history: 32, concurrent: 3, recordBytes: 2 * 1024 * 1024 } as const;
const text = (maxLength: number) => Type.String({ maxLength });
const strict = { additionalProperties: false } as const;
const tag = Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' });
export const PolicySchema = Type.Object({
  tools: Type.Array(StringEnum(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']), { maxItems: 7, uniqueItems: true }),
}, strict);
export const DispatchSchema = Type.Object({
  role: text(64), capabilities: Type.Array(text(64), { maxItems: 16, minItems: 1 }),
  task: text(8192), instructions: Type.Optional(text(4096)), policy: PolicySchema,
}, strict);
export type Dispatch = Static<typeof DispatchSchema>;
export type Policy = Static<typeof PolicySchema>;
export const ExpertSchema = Type.Object({
  id: EntityIdSchema, role: tag, capabilities: Type.Array(tag, { maxItems: 16, uniqueItems: true }),
  instructions: text(4096), policy: PolicySchema, sessionRef: EntityIdSchema,
  generation: Type.Integer({ minimum: 0 }), status: StringEnum(['idle', 'busy', 'blocked']),
  memory: text(4096), history: Type.Array(EntityIdSchema, { maxItems: LIMITS.history }),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}, strict);
export const RunSchema = Type.Object({
  id: EntityIdSchema, objective: text(8192), summary: text(4096),
  status: StringEnum(['queued', 'active', 'completed', 'cancelled', 'interrupted']),
  createdAt: TimestampSchema, updatedAt: TimestampSchema, startedAt: Type.Optional(TimestampSchema), endedAt: Type.Optional(TimestampSchema),
}, strict);
export const AssignmentSchema = Type.Object({
  id: EntityIdSchema, runId: EntityIdSchema, expertId: EntityIdSchema,
  generation: Type.Integer({ minimum: 0 }), ownerEpoch: Type.Integer({ minimum: 1 }),
  status: StringEnum(['queued', 'running', 'completed', 'failed', 'cancelled', 'cancelled_waiting']),
  task: text(8192), result: text(4096), error: text(512),
  createdAt: TimestampSchema, updatedAt: TimestampSchema, endedAt: Type.Optional(TimestampSchema),
}, strict);
export const OwnerSchema = Type.Object({
  sessionId: EntityIdSchema, instanceId: EntityIdSchema, epoch: Type.Integer({ minimum: 1 }),
  processPid: Type.Integer({ minimum: 2 }), processGroupId: Type.Integer({ minimum: 2 }), processStartToken: text(256),
}, strict);
export const StateSchema = Type.Object({
  schemaVersion: Type.Literal(1), teamId: Type.String({ pattern: '^p-[a-f0-9]{40}$' }), projectPath: text(4096),
  epoch: Type.Integer({ minimum: 0 }), owner: Type.Optional(OwnerSchema),
  orchestrator: Type.Object({ summary: text(4096), lastSessionId: Type.Optional(EntityIdSchema) }, strict),
  experts: Type.Array(ExpertSchema, { maxItems: LIMITS.experts }),
  runs: Type.Array(RunSchema, { maxItems: LIMITS.runs }),
  assignments: Type.Array(AssignmentSchema, { maxItems: LIMITS.assignments }),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}, strict);
export type Expert = Static<typeof ExpertSchema>;
export type Run = Static<typeof RunSchema>;
export type Assignment = Static<typeof AssignmentSchema>;
export type Owner = Static<typeof OwnerSchema>;
export type TeamState = Static<typeof StateSchema>;
export const terminalRun = (run: Run): boolean => !['active', 'queued'].includes(run.status);
export const terminalAssignment = (assignment: Assignment): boolean => !['running', 'queued'].includes(assignment.status);

export function bounded(value: string, bytes: number, label = 'text'): string {
  if (Buffer.byteLength(value, 'utf8') > bytes) throw new Error(`${label} exceeds ${bytes} UTF-8 bytes.`);
  return value;
}

// Metadata must never contain credentials. This is best-effort redaction, not a secret detector.
export function metadata(value: string, bytes = 4096): string {
  const safe = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[^\s]+|[a-f0-9]{64})\b/gi, '[redacted]')
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
  const chars: string[] = [];
  const size = { value: 0 };
  for (const char of safe) {
    size.value += Buffer.byteLength(char, 'utf8');
    if (size.value > bytes) break;
    chars.push(char);
  }
  return chars.join('');
}

export function normalizeTag(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(normalized)) throw new Error('Role/capability must normalize to a short lowercase tag.');
  return normalized;
}

export function assertState(value: unknown): asserts value is TeamState {
  if (!Value.Check(StateSchema, value)) throw new Error('Invalid dynamic Team record.');
  const state = value as TeamState;
  bounded(state.projectPath, 4096);
  bounded(state.orchestrator.summary, 4096);
  for (const expert of state.experts) { bounded(expert.instructions, 4096); bounded(expert.memory, 4096); }
  for (const run of state.runs) { bounded(run.objective, 8192); bounded(run.summary, 4096); }
  for (const a of state.assignments) { bounded(a.task, 8192); bounded(a.result, 4096); bounded(a.error, 512); }
  if (state.runs.filter(run => run.status === 'active').length > 1) throw new Error('Multiple active Runs.');
  for (const values of [state.runs, state.experts, state.assignments]) {
    if (new Set(values.map(value => value.id)).size !== values.length) throw new Error('Duplicate record identity.');
  }
  if (new Set(state.experts.map(expert => expert.role)).size !== state.experts.length) throw new Error('Duplicate role capacity.');
  if (state.assignments.filter(a => a.status === 'running').length > LIMITS.concurrent) throw new Error('Concurrency limit exceeded.');
  for (const a of state.assignments) {
    const expert = state.experts.find(e => e.id === a.expertId);
    const run = state.runs.find(r => r.id === a.runId);
    if (!expert || !run) throw new Error('Dangling assignment.');
    if (a.status === 'running' && (run.status !== 'active' || a.generation !== expert.generation || expert.status !== 'busy')) throw new Error('Invalid active assignment.');
  }
  for (const expert of state.experts) {
    if (state.assignments.filter(a => a.expertId === expert.id && a.status === 'running').length > 1) throw new Error('Expert is double booked.');
  }
}
