import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { join } from 'node:path';
import { EntityIdSchema } from '../domain/team.ts';
import { TeamRuntime } from '../runtime/team-runtime.ts';
import { workerMembershipFromEnvironment } from '../runtime/membership.ts';
import { TeamPaths } from '../storage/paths.ts';
import { createWorkerBootstrap, type WorkerBootstrap } from '../supervisor/worker-bootstrap.ts';
import { DynamicStore } from './store.ts';
import { bounded, metadata, type Expert } from './domain.ts';

const WorkerRequestSchema = Type.Object({
  assignmentId: EntityIdSchema,
  generation: Type.Integer({ minimum: 1 }),
  ownerEpoch: Type.Integer({ minimum: 1 }),
  task: Type.String({ maxLength: 8192 }),
}, { additionalProperties: false });
type WorkerRequest = Static<typeof WorkerRequestSchema>;

export function parseWorkerRequest(body: string): WorkerRequest {
  bounded(body, 16 * 1024, 'Worker request');
  const value: unknown = JSON.parse(body);
  if (!Value.Check(WorkerRequestSchema, value)) throw new Error('Invalid Expert request body.');
  bounded(value.task, 8192, 'Worker task');
  return value;
}

/** Private supervised worker entry: no public Team commands or ambient orchestration. */
export function installExpertWorker(pi: ExtensionAPI): void {
  pi.registerFlag('team-store', { description: 'Private supervised Expert storage root', type: 'string' });
  const slot: { ctx?: ExtensionContext; runtime?: TeamRuntime; bootstrap?: WorkerBootstrap; expert?: Expert;
    request?: string; timer?: ReturnType<typeof setInterval>; closed: boolean; serial: Promise<unknown> } = { closed: false, serial: Promise.resolve() };
  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = slot.serial.then(action); slot.serial = next.catch(() => {}); return next;
  };
  const membership = workerMembershipFromEnvironment();
  if (!membership) throw new Error('Missing supervised Expert identity.');
  const failClosed = (): void => { slot.closed = true; slot.ctx?.abort(); slot.ctx?.shutdown(); };
  pi.registerTool({
    name: 'team_reply', label: 'Expert reply', description: 'Send one bounded evidence-based result for the current assignment; do not include secrets.',
    parameters: Type.Object({ summary: Type.String({ maxLength: 4096 }) }, { additionalProperties: false }),
    execute: async (_id, input, signal) => queue(async () => {
      if (slot.closed || !slot.request || !slot.runtime) throw new Error('No active Expert assignment.');
      bounded(input.summary, 4096);
      const result = await slot.runtime.requests.reply(membership, slot.request, metadata(input.summary), signal);
      if (!result.accepted) throw new Error('Assignment result rejected (terminal or fenced).');
      slot.request = undefined;
      slot.bootstrap?.ready();
      return { content: [{ type: 'text', text: 'Result durably recorded.' }], details: {}, terminate: true };
    }),
  });
  pi.on('tool_call', event => {
    if (slot.closed || !slot.request || (event.toolName !== 'team_reply' && !slot.expert?.policy.tools.some(name => name === event.toolName))) {
      return { block: true, reason: 'Outside the active Expert tool policy.' };
    }
  });
  pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\n\nYou are a persistent Team Expert, not the orchestrator.\nRole: ${slot.expert?.role}\n${slot.expert?.instructions ?? ''}\nBounded prior memory: ${slot.expert?.memory ?? ''}\nWork only on the current assignment. Finish with team_reply and evidence, never invented success. Tool access is not an OS sandbox. Do not expose credentials.` }));
  pi.on('session_start', async (_event, ctx) => {
    slot.ctx = ctx;
    const root = pi.getFlag('team-store');
    if (typeof root !== 'string') { failClosed(); return; }
    const store = new DynamicStore(root);
    const state = await store.read(membership.teamId);
    const expert = state?.experts.find(e => `e-${e.id}` === membership.alias && e.sessionRef === membership.sessionId);
    if (!expert || ctx.sessionManager.getSessionId() !== expert.sessionRef || expert.status !== 'busy') { failClosed(); return; }
    slot.expert = expert;
    pi.setActiveTools([...expert.policy.tools, 'team_reply']);
    const runtime = new TeamRuntime(new TeamPaths(join(root, 'transport')));
    slot.runtime = runtime;
    await runtime.memberships.assertOwner(membership);
    const bootstrap = createWorkerBootstrap();
    if (!bootstrap) { failClosed(); return; }
    slot.bootstrap = bootstrap; bootstrap.attach(ctx); await bootstrap.start(); bootstrap.ready();
    const renewed = { at: 0 };
    const poll = async (): Promise<void> => {
      if (slot.closed) return;
      if (Date.now() - renewed.at >= 10_000) {
        await runtime.memberships.heartbeat(membership);
        if (slot.request) await runtime.delivery.renew(membership, slot.request);
        renewed.at = Date.now();
      }
      if (slot.request) {
        if (await runtime.requests.isCancelled(membership, slot.request)) { ctx.abort(); slot.request = undefined; bootstrap.ready(); }
        return;
      }
      if (!ctx.isIdle()) return;
      await runtime.delivery.deliverNextRequest(membership, true, async message => {
        const input = parseWorkerRequest(message.body);
        const current = await store.read(membership.teamId);
        const assignment = current?.assignments.find(a => a.id === input.assignmentId && a.expertId === expert.id);
        const sender = await runtime.teams.readMember(membership.teamId, message.fromMemberId);
        if (!assignment || assignment.status !== 'running' || assignment.generation !== expert.generation ||
            input.generation !== assignment.generation || input.ownerEpoch !== assignment.ownerEpoch || input.task !== assignment.task ||
            current?.owner?.epoch !== assignment.ownerEpoch || current.owner.sessionId !== sender?.sessionId ||
            sender?.alias !== 'orchestrator' || sender.state !== 'active' || sender.generation !== message.senderGeneration ||
            current.runs.find(r => r.id === assignment.runId)?.status !== 'active') {
          throw new Error('Fenced Expert assignment.');
        }
        slot.request = message.messageId; bootstrap.busy(message.messageId);
        pi.sendUserMessage(`Team assignment ${assignment.id}:\n${assignment.task}\nReturn evidence using team_reply.`, { deliverAs: 'followUp' });
      });
    };
    slot.timer = setInterval(() => { void queue(poll).catch(failClosed); }, 500);
    slot.timer.unref();
  });
  pi.on('agent_end', async event => {
    const last = event.messages.filter(m => m.role === 'assistant').at(-1);
    if (last?.role === 'assistant' && ['error', 'aborted'].includes(last.stopReason) && slot.request && slot.runtime) {
      await slot.runtime.delivery.fail(membership, slot.request).catch(() => {});
      slot.request = undefined; slot.bootstrap?.ready();
    }
  });
  pi.on('session_shutdown', async () => {
    slot.closed = true;
    if (slot.timer) clearInterval(slot.timer);
    await slot.serial;
    if (slot.request && slot.runtime) await slot.runtime.delivery.fail(membership, slot.request).catch(() => {});
    slot.bootstrap?.dispose();
  });
}
