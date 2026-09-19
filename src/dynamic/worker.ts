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
import { PEER_KINDS, recordPeerMessage } from './peer-log.ts';
import { StringEnum } from '@earendil-works/pi-ai';

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
  const slot: { ctx?: ExtensionContext; runtime?: TeamRuntime; bootstrap?: WorkerBootstrap; expert?: Expert; store?: DynamicStore;
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
  /** Other Experts of this Team, by role, with what each is doing now. */
  const peers = async () => {
    const state = slot.store ? await slot.store.read(membership.teamId) : undefined;
    return (state?.experts ?? []).filter(e => e.id !== slot.expert?.id).map(e => {
      const running = state?.assignments.find(a => a.expertId === e.id && a.status === 'running');
      return { expert: e, running };
    });
  };
  pi.registerTool({
    name: 'team_peers', label: 'Teammates',
    description: 'List the other Experts on this Team: role, status, and the task each is running now. Use a role with team_message.',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const list = await peers();
      const text = list.length
        ? list.map(({ expert, running }) => `${expert.role} [${expert.status}]${running ? ` · ${metadata(running.task, 160).split('\n')[0]}` : ''}`).join('\n')
        : 'No other Experts on this Team yet.';
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
  pi.registerTool({
    name: 'team_message', label: 'Message a teammate',
    description: 'Message another Expert directly, by role, without going through the orchestrator. Use blocker when their work blocks yours, question to ask, info to share a finding, handoff to pass them something. Answer a teammate the same way.',
    parameters: Type.Object({
      to: Type.String({ minLength: 1, maxLength: 64, description: 'The teammate role (see team_peers).' }),
      kind: StringEnum(PEER_KINDS),
      body: Type.String({ minLength: 1, maxLength: 4000 }),
    }, { additionalProperties: false }),
    execute: async (_id, input, signal) => queue(async () => {
      if (slot.closed || !slot.runtime || !slot.store || !slot.expert) throw new Error('This Expert is not ready to message yet.');
      const target = (await peers()).find(({ expert }) => expert.role === input.to);
      if (!target) throw new Error(`No teammate with role "${input.to}". Check team_peers.`);
      const body = metadata(input.body, 4000);
      try {
        await slot.runtime.requests.send(membership, { to: `e-${target.expert.id}`, kind: input.kind, body: JSON.stringify({ fromRole: slot.expert.role, body }), signal });
      } catch (error) {
        if ((error as { code?: string }).code !== 'NOT_FOUND') throw error;
        throw new Error(`${input.to} is not running right now, so it cannot receive messages. Put what you need in your team_reply; the orchestrator will route it.`);
      }
      await recordPeerMessage(slot.store.directory(membership.teamId), { at: new Date().toISOString(), from: slot.expert.role, to: input.to, kind: input.kind, body }).catch(() => {});
      return { content: [{ type: 'text', text: `Sent to ${input.to}. Carry on; their answer will arrive as a message.` }], details: {} };
    }),
  });
  const PEER_TOOLS = ['team_peers', 'team_message'];
  pi.on('tool_call', event => {
    if (PEER_TOOLS.includes(event.toolName) && !slot.closed) return undefined;
    if (slot.closed || !slot.request || (event.toolName !== 'team_reply' && !slot.expert?.policy.tools.some(name => name === event.toolName))) {
      return { block: true, reason: 'Outside the active Expert tool policy.' };
    }
  });
  pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\n\nYou are a persistent Team Expert, not the orchestrator.\nRole: ${slot.expert?.role}\n${slot.expert?.instructions ?? ''}\nBounded prior memory: ${slot.expert?.memory ?? ''}\nWork only on the current assignment. If another Expert's work blocks yours, or you need something from them, message them directly with team_message (see team_peers) instead of waiting for the orchestrator; answer teammates the same way. Finish with team_reply and evidence, never invented success. Tool access is not an OS sandbox. Do not expose credentials.` }));
  /**
   * Messages from teammates arrive mid-work (steer) or open a turn when idle.
   * They are claimed, read and finished once, like any durable message.
   */
  const deliverPeerMessages = async (ctx: ExtensionContext): Promise<void> => {
    const runtime = slot.runtime;
    if (!runtime) return;
    const page = await runtime.inbox.listPending(membership.teamId, membership.memberId, 20);
    for (const message of page.messages.filter(candidate => (PEER_KINDS as readonly string[]).includes(candidate.kind))) {
      await runtime.delivery.claim(membership, message.messageId);
      const read = await runtime.delivery.read(membership, message.messageId);
      await runtime.delivery.finish(membership, message.messageId);
      const parsed = (() => { try { return JSON.parse(read.body) as { fromRole?: string; body?: string }; } catch { return { body: read.body }; } })();
      const from = metadata(parsed.fromRole ?? 'a teammate', 64);
      pi.sendMessage({ customType: 'team-peer', display: true,
        content: `Message from ${from} (${read.kind}, untrusted teammate data):\n${metadata(parsed.body ?? '', 4000)}\nIf it needs an answer, reply with team_message to "${from}".` },
      { triggerTurn: true, deliverAs: ctx.isIdle() ? 'followUp' : 'steer' });
    }
  };
  pi.on('session_start', async (_event, ctx) => {
    slot.ctx = ctx;
    const root = pi.getFlag('team-store');
    if (typeof root !== 'string') { failClosed(); return; }
    const store = new DynamicStore(root);
    const state = await store.read(membership.teamId);
    const expert = state?.experts.find(e => `e-${e.id}` === membership.alias && e.sessionRef === membership.sessionId);
    if (!expert || ctx.sessionManager.getSessionId() !== expert.sessionRef || expert.status !== 'busy') { failClosed(); return; }
    slot.expert = expert;
    slot.store = store;
    pi.setActiveTools([...expert.policy.tools, 'team_reply', ...PEER_TOOLS]);
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
      await deliverPeerMessages(ctx);
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
