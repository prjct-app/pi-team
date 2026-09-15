/**
 * Optional bridge to pi-subagents.
 *
 * Pi loads each package through its own jiti module graph, so importing the
 * other package would create a second copy of its module state. A well-known
 * symbol on globalThis is the one process-wide object both loaders can share.
 */
type AgentsRegistry = {
  /** The team request under which a new subagent job is born. */
  activeRoot?: () => string | undefined;
  /** Owned by pi-subagents; retained here so the shared shape is explicit. */
  handle?: { lines: () => string[] };
};

const KEY = Symbol.for('prjct.agents');

function registry(): AgentsRegistry {
  const space = globalThis as unknown as Record<symbol, AgentsRegistry | undefined>;
  const found = space[KEY];
  if (found) return found;
  const created: AgentsRegistry = {};
  space[KEY] = created;
  return created;
}

/** A subagent launched during a team request inherits that request's root id. */
export function publishActiveRoot(activeRoot: () => string | undefined): void {
  registry().activeRoot = activeRoot;
}
