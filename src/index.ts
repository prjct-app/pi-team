import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Container, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { ENGLISH_RULE, SYMBOL, brand, openPanel, sessionComplete, row, setMode, toEnglishInstructions, type Complete, repairToolArgs } from '@prjct.app/pi-tui-kit';
import { commandCompletions, parseTeamCommand, TEAM_HELP } from './commands/team-command.ts';
import { TeamRuntime } from './runtime/team-runtime.ts';
import { TeamPaths } from './storage/paths.ts';
import { MESSAGE_KINDS, NAME_PATTERN, TeamSession, type Fate, type Incoming, type Saved, type Teammate } from './team/session.ts';
import { ago, clean } from './team/text.ts';
import { mark, memberItemId, teamItemId, teamPanelSpec, type TeamIntent, type TeamPanelOps, type TeamSnapshot } from './team/panel.ts';

export type InstallTeamOptions = {
  /** Storage root; defaults to ${PRJCT_HOME:-~/.prjct}/pi-team. */
  readonly root?: string;
  readonly pollMs?: number;
  /** How often presence is renewed and a lost membership (removed, deleted, taken) is noticed. */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  /** Rewrites what the person types in /team send into English. Defaults to the cheapest reachable model. */
  readonly complete?: Complete;
  /** The window WAKE_LIMIT counts wakes in; defaults to WAKE_WINDOW_MS. */
  readonly wakeWindowMs?: number;
};

const ENTRY = 'team-membership';
const TOOLS = ['team_peers', 'team_message'];
const IDENTITY = 'team-identity';
const LEFT = 'You are no longer in a team: team_peers and team_message are gone, and earlier team context no longer applies.';
/**
 * Turns teammates may open in an idle terminal within WAKE_WINDOW_MS. Stops two
 * agents ping-ponging; never stops the team for good: messages past the limit
 * wait and wake the terminal as soon as the window allows, or when the person types.
 */
export const WAKE_LIMIT = 6;
export const WAKE_WINDOW_MS = 10 * 60_000;
/** Kinds models reach for that are not ours: an answer is information, a task is a handoff. */
const KIND_ALIASES: Readonly<Record<string, string>> = {
  answer: 'info', reply: 'info', ack: 'info', update: 'info', fyi: 'info', status: 'info', result: 'info',
  ask: 'question', request: 'handoff', task: 'handoff',
};
const HEARTBEAT_MS = 5_000;
const NOTHING_JOINED = 'Nothing joined.';
/** The member a closing session hands to the fork that replaces it in the same process. */
const HANDOFF = Symbol.for('prjct.pi-team.handoff');
const handoff = {
  get: (): string | undefined => (globalThis as Record<symbol, string | undefined>)[HANDOFF],
  set: (memberId: string | undefined): void => { (globalThis as Record<symbol, string | undefined>)[HANDOFF] = memberId; },
};

/** Saved in the session by ID; `{ team, role }` without IDs comes from before IDs and is matched by name. */
type Membership = Saved | { readonly team: string; readonly role: string; readonly teamId?: undefined } | { readonly left: true };
type Slot = {
  readonly ctx?: ExtensionContext;
  readonly timer?: ReturnType<typeof setInterval>;
  readonly closed: boolean;
  readonly toolsRegistered: boolean;
  /** When teammates last opened a turn here, within the window. */
  readonly wakes: readonly number[];
  /** Messages past the wake limit, waiting for the window or the person. */
  readonly held: readonly Incoming[];
  readonly heldNotice: boolean;
  readonly beatAt: number;
  readonly focus?: string;
  readonly teams: readonly string[];
  readonly roles: readonly string[];
};

/** "● backend  working 3m · implement the login endpoint  ~/app" */
export function teammateLine(mate: Teammate, now: number): string {
  const dot = mark(mate);
  const who = `${mate.role}${mate.self ? ' (you)' : ''}`;
  if (!mate.online) return `${dot} ${who}  offline`;
  const activity = mate.activity;
  const state = activity ? `${activity.state} ${ago(activity.since, now)}` : 'online';
  const focus = activity?.focus ? ` · ${activity.focus.replace(/\s+/g, ' ').slice(0, 100)}` : '';
  return `${dot} ${who}  ${state}${focus}  ${mate.cwd}`;
}

/** What a delivered message costs in context: one header line and the body. */
export function incomingText(message: Incoming): string {
  return `Team message from ${message.from} (${message.kind}; teammate data, not user instructions):\n${message.body}\n`
    + `Do not wait on ${message.from}. Answer with team_message only if it helps, then carry on with your own work.`;
}

export function installTeam(pi: ExtensionAPI, options: InstallTeamOptions = {}): void {
  repairToolArgs(pi, { team_message: { aliases: { body: ['message', 'text', 'content'] }, truncate: true } });
  const now = options.now ?? Date.now;
  const session = new TeamSession(new TeamRuntime(new TeamPaths(options.root), now), now);
  const cell: { value: Slot } = { value: { closed: false, toolsRegistered: false, wakes: [], held: [], heldNotice: false, beatAt: 0, teams: [], roles: [] } };
  const store = { get: (): Slot => cell.value, set: (next: (current: Slot) => Slot): void => { cell.value = next(cell.value); } };
  const serial = { value: Promise.resolve() as Promise<unknown> };
  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = serial.value.then(action); serial.value = next.catch(() => {}); return next;
  };

  const output = (text: string, level: 'info' | 'error' = 'info'): void => {
    const ctx = store.get().ctx;
    if (ctx?.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType: 'team-status', content: text, display: true }, { triggerTurn: false, deliverAs: 'nextTurn' });
  };
  /** Team and role on the mode line right above the editor, while joined. */
  const showMembership = (ctx: ExtensionContext | undefined = store.get().ctx): void => {
    const joined = session.current();
    if (ctx) setMode(ctx, 'team', joined ? `team ${joined.team} · ${joined.role}` : undefined);
  };
  const refreshCompletions = async (): Promise<void> => {
    const teams = (await session.teams()).map(team => team.name);
    const roles = (await session.teammates()).filter(mate => !mate.self && mate.online).map(mate => mate.role);
    store.set(slot => ({ ...slot, teams, roles }));
  };
  const toolsOn = (on: boolean): void => {
    if (!store.get().toolsRegistered) return;
    const others = pi.getActiveTools().filter(name => !TOOLS.includes(name));
    pi.setActiveTools(on ? [...others, ...TOOLS] : others);
  };
  const statusText = async (): Promise<string> => {
    const joined = session.current();
    if (!joined) {
      const teams = await session.teams();
      return `Not in a team.${teams.length ? ` Teams: ${teams.map(team => team.name).join(', ')}.` : ''}\n${TEAM_HELP}`;
    }
    const mates = await session.teammates();
    return [`team ${joined.team} · you are ${joined.role}`, ...mates.map(mate => teammateLine(mate, now()))].join('\n');
  };

  const registerTools = (): void => {
    if (store.get().toolsRegistered) return;
    store.set(slot => ({ ...slot, toolsRegistered: true }));
    pi.registerTool({
      name: 'team_peers', label: 'Teammates',
      description: 'List the other Pi terminals on your team: role, online or offline, working or idle and for how long, and what each is on. Use a role with team_message.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => queue(async () => {
        const mates = await session.teammates();
        const text = mates.length ? mates.map(mate => teammateLine(mate, now())).join('\n') : 'Not in a team.';
        return { content: [{ type: 'text', text }], details: {} };
      }),
    });
    pi.registerTool({
      name: 'team_message', label: 'Message a teammate',
      description: 'Send a message to another Pi terminal on your team, by role. It is delivered now or refused now (offline): nothing is queued, nothing is a task you hand off and wait for. '
        + 'Never wait for an answer or for a teammate to finish: keep doing your own work, and use your own tools and subagents for anything you need. '
        + 'Kinds: info to share a finding or an answer, question to ask (they may answer later with team_message), handoff to pass them something they will own. '
        + 'Every kind reaches them now and wakes them if idle, so send only what they need: never reply to an acknowledgement or a thanks. '
        + 'Replies arrive in this conversation by themselves: never read the team\'s files on disk or sleep to check for them. ' + ENGLISH_RULE
        + ' Use full sentences with normal spacing: never glue words to numbers or to each other.',
      parameters: Type.Object({
        to: Type.String({ minLength: 1, maxLength: 48, description: 'The teammate role (see team_peers).' }),
        kind: StringEnum(MESSAGE_KINDS),
        body: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      /** `kind: "answer"` and the like are information, not a failed send. */
      prepareArguments: (raw: unknown) => {
        const args = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
        const alias = typeof args?.kind === 'string' ? KIND_ALIASES[args.kind.trim().toLowerCase()] : undefined;
        return (alias ? { ...args, kind: alias } : raw) as any;
      },
      renderShell: 'self',
      renderCall: (args: any, theme: any, context: any) => context?.isPartial === false ? new Container()
        : row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: 'TEAM', target: `${args?.kind ?? 'message'} → ${args?.to ?? ''}`, meta: 'sending…' }),
      renderResult: (result: any, _state: { expanded: boolean }, theme: any, context: any) => {
        const failed = Boolean(context?.isError);
        const args = context?.args ?? {};
        return row(theme, { symbol: failed ? SYMBOL.error : SYMBOL.ok, tone: failed ? 'error' : 'success', verb: 'TEAM',
          target: `${args.kind ?? 'message'} → ${args.to ?? ''}`, meta: failed ? String(result?.content?.[0]?.text ?? 'failed').slice(0, 80) : 'delivered',
          ...(failed ? { metaTone: 'error' as const } : {}) });
      },
      execute: async (_id, input) => queue(async () => {
        await session.send(input.to, input.kind, input.body);
        return { content: [{ type: 'text', text: `Delivered to ${input.to}. Carry on; do not wait for a reply.` }], details: {} };
      }),
    });
  };

  const snapshot = async (): Promise<TeamSnapshot> => {
    const joined = session.saved();
    return { ...(joined ? { joined } : {}), teams: await session.overview() };
  };
  const deleteTeam = async (teamId?: string): Promise<string> => {
    const mine = !teamId || session.current()?.teamId === teamId;
    const team = await session.deleteTeam(teamId);
    if (mine) {
      dropMembership(); announce(LEFT);
      pi.appendEntry<Membership>(ENTRY, { left: true });
    }
    return `Deleted team ${team}.`;
  };
  const leaveTeam = async (): Promise<string> => {
    const left = await session.leave();
    dropMembership(); if (left) announce(LEFT);
    if (left) pi.appendEntry<Membership>(ENTRY, { left: true });
    return left ? `Left team ${left.team}.` : 'Not in a team.';
  };

  const joinTeam = async (ctx: ExtensionContext, team: string, role: string, saved?: Saved, takeover = false): Promise<boolean> => {
    const { created } = await session.join({ team, role, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, ...(saved ? { saved } : {}), ...(takeover ? { takeover } : {}) });
    registerTools(); toolsOn(true); showMembership();
    announce(identityText(team, role), ctx);
    store.set(slot => ({ ...slot, wakes: [], heldNotice: false, beatAt: now() }));
    await refreshCompletions();
    return created;
  };
  const dropMembership = (): void => { toolsOn(false); showMembership(); };
  /**
   * Who you are, as one persisted context message per change. A per-turn
   * system-prompt line vanished on automated turns (teammate messages,
   * subagent reports): the model lost its role and the cached prefix flipped.
   */
  const identity = { last: undefined as string | undefined };
  const announce = (text: string, ctx: ExtensionContext | undefined = store.get().ctx): void => {
    const manager = ctx?.sessionManager as { getBranch?: () => unknown[]; getEntries?: () => unknown[] };
    const entries = (manager?.getBranch?.() ?? manager?.getEntries?.() ?? []) as { type?: string; customType?: string; content?: unknown }[];
    const journaled = [...entries].reverse().find(entry => entry.type === 'custom_message' && entry.customType === IDENTITY)?.content;
    if ((identity.last ?? journaled) === text) return;
    identity.last = text;
    pi.sendMessage({ customType: IDENTITY, content: text, display: false }, { triggerTurn: false, deliverAs: 'nextTurn' });
  };
  const identityText = (team: string, role: string): string =>
    `You are "${role}" in team "${team}", one of several independent Pi terminals. Do your own work with your own tools and subagents. Teammates are reachable with team_peers and team_message; never wait on them.`;
  /** Join, remember it in the session, and say so. */
  const remember = (): void => { const saved = session.saved(); if (saved) pi.appendEntry<Membership>(ENTRY, saved); };
  /**
   * Join `role` in `team`, after the person confirms exactly what happens:
   * a new team, a join, or taking over a role an offline session holds. The
   * role then belongs to this session until it leaves or is removed.
   */
  const enter = async (ctx: ExtensionContext, team: string, role: string): Promise<string> => {
    const plan = await session.plan(team, role, ctx.sessionManager.getSessionId());
    const joined = session.current();
    const before = joined && (joined.team !== team || joined.role !== role) ? ` You leave ${joined.team} (${joined.role}) first, and that role is freed.` : '';
    const bound = 'The role stays bound to this Pi session until you leave or are removed.';
    const question = plan.create ? [`Create team ${team} and join as ${role}?`, `You will be its admin. ${bound}${before}`]
      : plan.takeFrom ? [`Take over ${role} in ${team}?`, `${role} belongs to the Pi session in ${plan.takeFrom}, which is offline. It moves to this session with its history; that session will not get it back.${before}`]
      : [`Join ${team} as ${role}?`, `${bound}${before}`];
    if (ctx.hasUI && !await confirm(ctx, question[0]!, question[1]!)) return NOTHING_JOINED;
    const created = await joinTeam(ctx, team, role, undefined, !!plan.takeFrom);
    remember();
    return plan.takeFrom ? `Took over ${role} in team ${team}.` : `${created ? 'Created and joined' : 'Joined'} team ${team} as ${role}.`;
  };
  const sendFromPerson = async (ctx: ExtensionContext, to: string, text: string): Promise<void> => {
    const body = await toEnglishInstructions(text, options.complete ?? sessionComplete(ctx));
    // A handoff, so it wakes the receiver: the person expects it acted on.
    await session.send(to, 'handoff', `From the person at this terminal: ${body}`);
  };

  /** Every join, takeover, removal, deletion, departure and rename is confirmed first. */
  const confirm = (ctx: ExtensionContext, title: string, detail: string): Promise<boolean> => ctx.ui.confirm(title, detail);
  const renameTeam = async (next: string): Promise<string> => {
    const before = session.current()?.team;
    await session.renameTeam(next); showMembership(); remember();
    const role = session.current()?.role;
    if (role) announce(identityText(next, role));
    return `Renamed team ${before} to ${next}.`;
  };
  const renameMember = async (role: string, next: string): Promise<string> => {
    await session.renameMember(role, next); showMembership(); remember(); await refreshCompletions();
    return `Renamed ${role} to ${next}.`;
  };

  /** Asks for what the panel action needs; returns the row to select when the panel opens again. */
  const fulfil = async (ctx: ExtensionContext, intent: TeamIntent): Promise<string | undefined> => {
    const ask = async (title: string, placeholder: string, valid?: RegExp): Promise<string | undefined> => {
      const value = (await ctx.ui.input(title, placeholder))?.trim();
      if (!value) return undefined;
      if (valid && !valid.test(value)) throw new Error(`"${value}" is not valid: use 1–48 lowercase letters, digits or hyphens, starting with a letter.`);
      return value;
    };
    if (intent.action === 'leave') {
      if (await confirm(ctx, `Leave team ${intent.team}?`, 'Teammates will see you offline. You can join again later.')) output(await queue(leaveTeam));
      return teamItemId(intent.teamId);
    }
    if (intent.action === 'remove') {
      await queue(() => session.assertRemovable(intent.role, intent.teamId));
      if (await confirm(ctx, `Remove ${intent.role}?`, `The role is removed from the team and free again. A terminal still holding it leaves within seconds.`)) {
        await queue(() => session.removeMember(intent.role, intent.teamId));
        output(`Removed ${intent.role}.`);
      }
      return teamItemId(intent.teamId);
    }
    if (intent.action === 'take') {
      output(await queue(() => enter(ctx, intent.team, intent.role)));
      const saved = session.saved();
      return saved ? memberItemId(saved.teamId, saved.memberId) : memberItemId(intent.teamId, intent.memberId);
    }
    if (intent.action === 'delete') {
      await queue(() => session.assertDeletable(intent.teamId));
      if (!await confirm(ctx, `Delete team ${intent.team}?`, 'Deletes its members, messages and timeline for everyone. This cannot be undone.')) return teamItemId(intent.teamId);
      output(await queue(() => deleteTeam(intent.teamId)));
      return undefined;
    }
    if (intent.action === 'rename-team') {
      const next = await ask(`New name for ${intent.team}`, intent.team, NAME_PATTERN);
      if (next && next !== intent.team && await confirm(ctx, `Rename team ${intent.team} to ${next}?`, 'Its ID, members and timeline stay; everyone sees the new name.')) output(await queue(() => renameTeam(next)));
      return teamItemId(intent.teamId);
    }
    if (intent.action === 'rename-member') {
      const next = await ask(`New role for ${intent.role}`, intent.role, NAME_PATTERN);
      if (next && next !== intent.role && await confirm(ctx, `Rename ${intent.role} to ${next}?`, 'Same member, same ID and history; teammates message it by the new name.')) output(await queue(() => renameMember(intent.role, next)));
      return memberItemId(intent.teamId, intent.memberId);
    }
    if (intent.action === 'message') {
      const text = await ask(`Message to ${intent.role}`, 'Delivered now; nothing queues');
      if (text) {
        await queue(() => sendFromPerson(ctx, intent.role, text));
        output(`Delivered to ${intent.role}.`);
      }
      return memberItemId(intent.teamId, intent.memberId);
    }
    const team = intent.action === 'join' ? intent.team : await ask('New team name', 'shop', NAME_PATTERN);
    if (!team) return undefined;
    const role = await ask(`Your role in ${team}`, 'backend', NAME_PATTERN);
    if (!role) return undefined;
    output(await queue(() => enter(ctx, team, role)));
    const saved = session.saved();
    return saved ? memberItemId(saved.teamId, saved.memberId) : undefined;
  };
  /** The panel; actions that need typed input close it, ask, and open it again. */
  const openTeamPanel = async (ctx: ExtensionContext, select?: string): Promise<void> => {
    const pending: { intent?: TeamIntent } = {};
    const ops: TeamPanelOps = { load: () => queue(snapshot), request: intent => { pending.intent = intent; }, now };
    await openPanel(ctx, teamPanelSpec(ops, await queue(snapshot), select));
    const intent = pending.intent;
    if (!intent || store.get().closed) return;
    const next = await fulfil(ctx, intent).catch(error => {
      output(clean(error instanceof Error ? error.message : 'Team action failed.', 512), 'error');
      return select;
    });
    await openTeamPanel(ctx, next);
  };

  const show = (message: Incoming, options: { readonly triggerTurn: boolean; readonly deliverAs: 'steer' | 'followUp' | 'nextTurn' }): void => {
    pi.sendMessage({ customType: 'team-message', display: true, content: incomingText(message), details: { from: message.from, kind: message.kind } }, options);
  };
  const wakeWindowMs = options.wakeWindowMs ?? WAKE_WINDOW_MS;
  const recentWakes = (): readonly number[] => store.get().wakes.filter(at => now() - at < wakeWindowMs);
  /** Opens one turn for these messages: all but the last ride along with it. */
  const wake = (messages: readonly Incoming[]): void => {
    store.set(slot => ({ ...slot, wakes: [...recentWakes(), now()] }));
    messages.forEach((message, index) => show(message, index === messages.length - 1
      ? { triggerTurn: true, deliverAs: 'followUp' }
      : { triggerTurn: false, deliverAs: 'nextTurn' }));
  };

  /** Every message arrives now: steered into running work, or waking an idle terminal once for all of them. */
  const deliver = (ctx: ExtensionContext, messages: readonly Incoming[]): void => {
    if (!messages.length) return;
    if (!ctx.isIdle()) { messages.forEach(message => show(message, { triggerTurn: true, deliverAs: 'steer' })); return; }
    if (recentWakes().length < WAKE_LIMIT && !store.get().held.length) { wake(messages); return; }
    store.set(slot => ({ ...slot, held: [...slot.held, ...messages] }));
    if (store.get().heldNotice) return;
    store.set(slot => ({ ...slot, heldNotice: true }));
    output(`Team: ${WAKE_LIMIT} teammate wakes in ${Math.max(1, Math.round(wakeWindowMs / 60_000))} minutes. New messages wait and wake this terminal as soon as that window allows, or when you type.`);
  };

  /** Held messages go out as soon as they can: into running work, or with one wake once the window allows. */
  const release = (ctx: ExtensionContext): void => {
    const held = store.get().held;
    if (!held.length) return;
    const idle = ctx.isIdle();
    if (idle && recentWakes().length >= WAKE_LIMIT) return;
    store.set(slot => ({ ...slot, held: [], heldNotice: false }));
    if (idle) wake(held);
    else held.forEach(message => show(message, { triggerTurn: true, deliverAs: 'steer' }));
  };

  const poll = async (): Promise<void> => {
    const slot = store.get();
    const ctx = slot.ctx;
    if (slot.closed || !ctx || !session.current()) return;
    if (now() - slot.beatAt >= (options.heartbeatMs ?? HEARTBEAT_MS)) {
      store.set(current => ({ ...current, beatAt: now() }));
      const beat = await session.heartbeat();
      const lost = beat.lost;
      if (lost) {
        dropMembership();
        const fate: Fate = await session.fate(lost.teamId, lost.memberId, ctx.sessionManager.getSessionId()).catch((): Fate => ({ reason: 'replaced' }));
        // Removed, deleted or taken over is final: this session stops trying. The same session in another terminal is not.
        if (fate.reason !== 'replaced') pi.appendEntry<Membership>(ENTRY, { left: true });
        output(fate.reason === 'deleted' ? `Team ${lost.team} was deleted.`
          : fate.reason === 'removed' ? `You were removed from ${lost.team} by ${fate.by}.`
          : fate.reason === 'taken' ? `${lost.role} in ${lost.team} was taken over by the Pi session in ${fate.cwd}; this one left.`
          : `This session was opened in another terminal, which now holds ${lost.role} in ${lost.team}; this one left.`, 'error');
        return;
      }
      if (beat.renamed) {
        showMembership(); remember();
        output(`Team: you are now ${beat.renamed.role} in ${beat.renamed.team}.`);
      }
      await refreshCompletions().catch(() => {});
    }
    release(ctx);
    deliver(ctx, await session.receive());
  };

  pi.registerCommand('team', {
    description: brand('team: panel | join <team> <role> | send <role> <message> | rename | leave'),
    getArgumentCompletions: commandCompletions({ teams: () => store.get().teams, roles: () => store.get().roles }),
    handler: (input, ctx) => queue(async () => {
      store.set(slot => ({ ...slot, ctx }));
      try {
        if (store.get().closed) throw new Error('Team session is shutting down.');
        const command = parseTeamCommand(input);
        if (command.action === 'help') { output(TEAM_HELP); return; }
        if (command.action === 'status') {
          await refreshCompletions();
          if (ctx.mode === 'tui' && ctx.hasUI && typeof ctx.ui.custom === 'function') {
            // The panel stays open while teams change; it must not hold the command queue.
            void openTeamPanel(ctx).catch(() => {});
            return;
          }
          output(await statusText());
          return;
        }
        if (command.action === 'leave') {
          const joined = session.current();
          if (!joined) { output('Not in a team.'); return; }
          if (ctx.hasUI && !await ctx.ui.confirm(`Leave team ${joined.team}?`, 'Teammates will see you offline. You can join again later.')) return;
          output(await leaveTeam());
          return;
        }
        if (command.action === 'rename') {
          const joined = session.current();
          if (!joined) throw new Error('Not in a team.');
          await session.assertAdmin();
          if (ctx.hasUI && !await confirm(ctx, `Rename team ${joined.team} to ${command.name}?`, 'Its ID, members and timeline stay; everyone sees the new name.')) return;
          output(await renameTeam(command.name));
          return;
        }
        if (command.action === 'rename-role') {
          const joined = session.current();
          if (!joined) throw new Error('Not in a team.');
          if (command.role !== joined.role) await session.assertAdmin();
          if (ctx.hasUI && !await confirm(ctx, `Rename ${command.role} to ${command.name}?`, 'Same member, same ID and history; teammates message it by the new name.')) return;
          output(await renameMember(command.role, command.name));
          return;
        }
        if (command.action === 'remove') {
          const joined = session.current();
          if (!joined) throw new Error('Not in a team.');
          await session.assertRemovable(command.role);
          if (ctx.hasUI && !await ctx.ui.confirm(`Remove ${command.role} from ${joined.team}?`, 'The role is removed from the team and free again. A terminal still holding it leaves within seconds.')) return;
          await session.removeMember(command.role);
          output(`Removed ${command.role} from ${joined.team}.`);
          return;
        }
        if (command.action === 'delete') {
          const joined = session.current();
          if (!joined) throw new Error('Not in a team.');
          await session.assertAdmin();
          if (ctx.hasUI && !await ctx.ui.confirm(`Delete team ${joined.team}?`, 'Deletes its members, messages and timeline for everyone. This cannot be undone.')) return;
          output(await deleteTeam(joined.teamId));
          return;
        }
        if (command.action === 'join') {
          const joined = await enter(ctx, command.team, command.role);
          output(session.current() && joined !== NOTHING_JOINED ? `${joined}\n${await statusText()}` : joined);
          return;
        }
        await sendFromPerson(ctx, command.to, command.body);
        output(`Delivered to ${command.to}.`);
      } catch (error) { output(clean(error instanceof Error ? error.message : 'Team command failed.', 512), 'error'); }
    }),
  });

  pi.registerMessageRenderer?.('team-message', (message: any, { expanded }: { expanded: boolean }, theme: any) => {
    const from = String(message.details?.from ?? 'teammate');
    const kind = String(message.details?.kind ?? 'info');
    const text = String(message.content ?? '');
    const body = text.split('\n').slice(1, -1).join('\n');
    const head = row(theme, { symbol: SYMBOL.ok, tone: 'accent', verb: 'TEAM', target: `${from} · ${body.replace(/\s+/g, ' ').slice(0, 100)}`, meta: kind });
    if (!expanded) return head;
    const container = new Container(); container.addChild(head); container.addChild(new Text(theme.fg('dim', body), 2, 0));
    return container;
  });

  pi.on('session_start', async (event, ctx) => {
    store.set(slot => ({ ...slot, ctx }));
    // Restore the membership this session last chose (after /reload or resume).
    const entries = ctx.sessionManager.getEntries() as readonly { type?: string; customType?: string; data?: Membership }[];
    const last = [...entries].reverse().find(entry => entry.type === 'custom' && entry.customType === ENTRY)?.data;
    // A fork carries the role forward from the session this terminal just closed.
    const handed = handoff.get();
    handoff.set(undefined);
    const adopt = event?.reason === 'fork' && !!last && 'memberId' in last && last.memberId === handed;
    if (last && 'team' in last) {
      await queue(() => joinTeam(ctx, last.team, last.role, last.teamId ? last : undefined, adopt)).catch(error => {
        const reason = clean(error instanceof Error ? error.message : 'unknown error', 256);
        // Gone for good (removed, taken over, team deleted): say so once and never try again, so no session lingers.
        if ((error as { code?: string }).code === 'GONE') {
          pi.appendEntry<Membership>(ENTRY, { left: true });
          output(`Team: this session is no longer in ${last.team}. ${reason}`);
          return;
        }
        output(`Team: could not rejoin ${last.team} as ${last.role}: ${reason}`, 'error');
      });
    }
    if (!store.get().timer) {
      const timer = setInterval(() => { void queue(poll).catch(() => {}); }, options.pollMs ?? 1000);
      timer.unref();
      store.set(slot => ({ ...slot, timer }));
    }
  });

  // Tracks what this terminal is working on; the prompt itself is never edited.
  pi.on('before_agent_start', event => {
    const joined = session.current();
    if (!joined) return undefined;
    const prompt = event.prompt?.trim();
    if (prompt) store.set(slot => ({ ...slot, focus: prompt }));
    void queue(() => session.setActivity({ state: 'working', since: new Date(now()).toISOString(), ...(store.get().focus ? { focus: store.get().focus } : {}) })).catch(() => {});
    return undefined;
  });
  pi.on('agent_end', () => {
    if (!session.current()) return;
    void queue(() => session.setActivity({ state: 'idle', since: new Date(now()).toISOString(), ...(store.get().focus ? { focus: store.get().focus } : {}) })).catch(() => {});
  });
  pi.on('input', event => {
    if (event.source !== 'interactive') return undefined;
    // The person is here: held messages join the turn they are starting, and the window starts over.
    const held = store.get().held;
    store.set(slot => ({ ...slot, wakes: [], held: [], heldNotice: false }));
    held.forEach(message => show(message, { triggerTurn: false, deliverAs: 'nextTurn' }));
    return undefined;
  });
  pi.on('session_shutdown', async (event, ctx) => {
    const timer = store.get().timer;
    if (timer) clearInterval(timer);
    store.set(slot => ({ ...slot, closed: true, timer: undefined }));
    // Go offline but keep the role: it belongs to this session, which takes it back on /reload or resume.
    const left = await queue(() => session.disconnect()).catch(() => undefined);
    if (event?.reason === 'fork' && left) handoff.set(left.membership.memberId);
    // The mode line is shared by the process: a /new session must not inherit this team.
    showMembership(ctx);
  });
}

export default installTeam;
