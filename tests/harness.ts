import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installTeam } from '../src/index.ts';

type Handler = (event: any, ctx: any) => unknown;
type CompactionCall = { customInstructions?: string; onComplete?: () => void; onError?: (error: Error) => void };
export function harness(root: string, session: string, saved: any[] = [], options: { reviewMs?: number; agingMs?: number; holdCompaction?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const entries: any[] = [...saved];
  const received: any[] = [];
  const notices: string[] = [];
  const renderers = new Map<string, any>();
  const widgets = new Map<string, string[]>();
  const compactions: CompactionCall[] = [];
  const heldCompactions: CompactionCall[] = [];
  let idle = true;
  let pending = false;
  let editor = '';
  let model: unknown = { id: 'simulated-model' };
  // A fresh object each time: Pi hands the extension a new ExtensionContext on
  // session start, and code that caches per-context state must notice.
  const makeContext = () => ({
    cwd: `/worktrees/${session}`, mode: 'tui', hasUI: true,
    get model() { return model; },
    isIdle: () => idle, hasPendingMessages: () => pending,
    compact: (call: CompactionCall) => {
      compactions.push(call);
      if (options.holdCompaction) heldCompactions.push(call);
      else queueMicrotask(() => call.onComplete?.());
    },
    sessionManager: { getSessionId: () => session, getBranch: () => entries },
    ui: { notify: (s: string) => notices.push(s), getEditorText: () => editor,
      setWidget: (name: string, value: undefined | string[] | ((tui: unknown, theme: unknown) => { render(width: number): string[] })) => {
        if (!value) widgets.delete(name);
        else if (Array.isArray(value)) widgets.set(name, value);
        else widgets.set(name, value({}, {}).render(200));
      },
      setWorkingMessage: () => {},
    },
  } as unknown as ExtensionContext);
  const context = { current: makeContext() };
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: (name: string, renderer: unknown) => renderers.set(name, renderer),
    registerEntryRenderer: (name: string, renderer: unknown) => renderers.set(name, renderer),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    sendMessage: (message: unknown, options: { triggerTurn?: boolean }) => {
      received.push(message);
      if (options.triggerTurn) idle = false;
    },
  } as unknown as ExtensionAPI;
  installTeam(api, { root, pollMs: 20, reviewMs: options.reviewMs ?? 60_000, agingMs: options.agingMs ?? 300_000 });
  return {
    received, notices, entries, tools, commands, renderers, widgets, compactions,
    async emit(name: string, event: unknown = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context.current));
      return results;
    },
    async command(text: string) { await commands.get('team').handler(text, context.current); },
    /** Simulate the new ExtensionContext Pi supplies on a session reload. */
    renewContext() { context.current = makeContext(); },
    async send(input: unknown) { return tools.get('team_send').execute('test-call', input, undefined, undefined, context.current); },
    busy(value: boolean) { idle = !value; },
    pending(value: boolean) { pending = value; },
    editor(value: string) { editor = value; },
    modelAvailable(value: boolean) { model = value ? { id: 'simulated-model' } : undefined; },
    completeCompaction(error?: Error) {
      const call = heldCompactions.shift();
      if (!call) throw new Error('No held compaction');
      if (error) call.onError?.(error);
      else call.onComplete?.();
    },
  };
}
export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for observable behavior');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
