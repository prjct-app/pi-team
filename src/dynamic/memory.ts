/**
 * Project memory for an Expert, read by the orchestrator's process.
 *
 * An Expert starts without extensions, so it cannot open memory itself.
 * pi-memory publishes a read-only view on a well-known process symbol that
 * filters by stance: facts about the terrain reach everyone, decisions reach
 * only those who must obey them, and a reviewer gets rules and procedures only
 * so it judges from scratch. Absent pi-memory, an Expert simply starts without.
 */
export type ExpertStance = 'worker' | 'explorer' | 'reviewer';

const WRITE_TOOLS = ['edit', 'write', 'bash'];
const REVIEWING = /review|qa|audit|verif|critic|check|test/;

/**
 * Roles are free-form, so the stance is read from what the Expert may do.
 * A writer is a worker. A reader named for judging is a reviewer. Any other
 * reader is an explorer. Unsure falls to the stricter side: a reader.
 */
export function expertStance(role: string, tools: readonly string[]): ExpertStance {
  if (tools.some(tool => WRITE_TOOLS.includes(tool))) return 'worker';
  return REVIEWING.test(role.toLowerCase()) ? 'reviewer' : 'explorer';
}

type ChildMemoryView = (request: { role: ExpertStance; query?: string }) => Promise<{ text: string }>;
const MEMORY_KEY = Symbol.for('prjct.memory');
const DEADLINE_MS = 5_000;
export const MAX_MEMORY_BYTES = 4096;

/** The rendered memory for a stance and a task; '' when there is none, it fails, or it is slow. */
export async function expertMemory(stance: ExpertStance, query: string): Promise<string> {
  const host = (globalThis as unknown as Record<symbol, { childView?: ChildMemoryView } | undefined>)[MEMORY_KEY];
  if (typeof host?.childView !== 'function') return '';
  const timeout = new Promise<string>(resolve => { setTimeout(resolve, DEADLINE_MS, '').unref?.(); });
  const text = await Promise.race([host.childView({ role: stance, query: query.slice(0, 1000) })
    .then(view => view.text).catch(() => ''), timeout]);
  return Buffer.byteLength(text, 'utf8') <= MAX_MEMORY_BYTES ? text : '';
}
