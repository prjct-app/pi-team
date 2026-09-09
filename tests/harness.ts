import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installTeam } from '../src/index.ts';

type Handler = (event: any, ctx: any) => unknown;
export function harness(root: string, session: string, saved: any[] = []) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const entries: any[] = [...saved];
  const received: any[] = [];
  const notices: string[] = [];
  const renderers = new Map<string, any>();
  let idle = true;
  let pending = false;
  let editor = '';
  let model: unknown = { id: 'simulated-model' };
  const ctx = {
    cwd: `/worktrees/${session}`, mode: 'tui', hasUI: true,
    get model() { return model; },
    isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => session, getBranch: () => entries },
    ui: { notify: (s: string) => notices.push(s), getEditorText: () => editor,
      setWidget: () => {}, setWorkingMessage: () => {},
    },
  } as unknown as ExtensionContext;
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
  installTeam(api, { root, pollMs: 20 });
  return {
    received, notices, entries, tools, commands, renderers,
    async emit(name: string, event: unknown = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    async command(text: string) { await commands.get('team').handler(text, ctx); },
    async send(input: unknown) { return tools.get('team_send').execute('test-call', input, undefined, undefined, ctx); },
    busy(value: boolean) { idle = !value; },
    pending(value: boolean) { pending = value; },
    editor(value: string) { editor = value; },
    modelAvailable(value: boolean) { model = value ? { id: 'simulated-model' } : undefined; },
  };
}
export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for observable behavior');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
