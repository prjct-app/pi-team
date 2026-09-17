import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { parseTeamCommand, commandCompletions, TEAM_HELP } from './commands/team-command.ts';
import type { Envelope } from './domain/message.ts';
import { assertTeamId, type Team } from './domain/team.ts';
import { TeamRuntime } from './runtime/team-runtime.ts';
import { purgeClosedTeam } from './runtime/purge.ts';
import { registerTeamTool, teamSystemPrompt, type TeamToolRuntime } from './runtime/team-tool.ts';
import { workerMembershipFromEnvironment, type Membership } from './runtime/membership.ts';
import { TeamSupervisor, type SupervisorHandoff } from './supervisor/supervisor.ts';
import { createWorkerBootstrap, type WorkerBootstrap } from './supervisor/worker-bootstrap.ts';
import { ownerProcessNonce } from './supervisor/supervisor.ts';
import { loadDashboardSnapshot, openTeamDashboard } from './ui/team-dashboard.ts';
import { detectLegacyRoot, TeamPaths } from './storage/paths.ts';
import { inspectLegacy } from './legacy/inspect.ts';
import { migrateLegacyTeam } from './legacy/migrate.ts';

const RELOAD_STATE = Symbol.for('prjct.pi-team.reload-state.v2');
const HEARTBEAT_MS = 10_000;
const DELIVERY_POLL_MS = 1_000;
const RELOAD_TTL_MS = 20_000;
// The compiled local build (scripts/build-pi.mjs) ships index.js; source runs keep index.ts.
const EXTENSION_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url));

export type InstallTeamOptions = {
  readonly root?: string;
  readonly legacyRoot?: string;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly reloadTtlMs?: number;
  readonly now?: () => number;
};

type PersistedMembership = {
  readonly teamId: string;
  readonly alias: string;
  readonly sessionId: string;
};

type ReloadRecord = {
  readonly sessionId: string;
  readonly membership: Membership;
  readonly handoff?: SupervisorHandoff;
  readonly activeRequestId?: string;
  readonly lastRequestRenewal?: number;
  readonly expiresAt: number;
};

type ReloadGlobal = typeof globalThis & { [RELOAD_STATE]?: Map<string, ReloadRecord> };

type State = {
  readonly ctx?: ExtensionContext;
  readonly membership?: Membership;
  readonly supervisor?: TeamSupervisor;
  readonly worker?: WorkerBootstrap;
  readonly activeRequestId?: string;
  readonly lastRequestRenewal?: number;
  readonly heartbeat?: ReturnType<typeof setInterval>;
  readonly poll?: ReturnType<typeof setInterval>;
  readonly serial: Promise<unknown>;
  readonly closed: boolean;
};

const INITIAL: State = { serial: Promise.resolve(), closed: false };

function reloadRecords(): Map<string, ReloadRecord> {
  const shared = globalThis as ReloadGlobal;
  if (!shared[RELOAD_STATE]) shared[RELOAD_STATE] = new Map();
  return shared[RELOAD_STATE]!;
}

function stashReload(record: ReloadRecord, expired: () => Promise<void>, timeoutMs: number): void {
  const records = reloadRecords();
  records.set(record.sessionId, record);
  const timer = setTimeout(() => {
    if (records.get(record.sessionId) !== record) return;
    records.delete(record.sessionId);
    void expired().catch(() => {});
  }, timeoutMs);
  timer.unref();
}

function pendingReload(sessionId: string, now: number): ReloadRecord | undefined {
  const record = reloadRecords().get(sessionId);
  return record && record.expiresAt >= now ? record : undefined;
}

function takeReload(sessionId: string, now: number): ReloadRecord | undefined {
  const records = reloadRecords();
  const record = pendingReload(sessionId, now);
  if (record) records.delete(sessionId);
  return record;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plain(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

function persisted(context: ExtensionContext): PersistedMembership | undefined {
  const entry = context.sessionManager.getBranch()
    .filter(candidate => candidate.type === 'custom' && candidate.customType === 'team-v2-membership')
    .at(-1);
  if (!entry || entry.type !== 'custom' || !entry.data) return undefined;
  const value = entry.data as Partial<PersistedMembership>;
  return typeof value.teamId === 'string' && typeof value.alias === 'string' &&
    value.sessionId === context.sessionManager.getSessionId()
    ? { teamId: value.teamId, alias: value.alias, sessionId: value.sessionId }
    : undefined;
}

function containsPath(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function overlapsPath(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

function workerCommand(sessionId: string, alias: string): readonly [string, ...string[]] {
  const executable: readonly [string, ...string[]] = process.argv[1]
    ? [process.execPath, process.argv[1]]
    : ['pi'];
  return [
    ...executable,
    '--no-extensions',
    '--extension', EXTENSION_ENTRY,
    '--session-id', sessionId,
    '--name', `team:${alias}`,
  ];
}

async function safeCwd(value: string): Promise<string> {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
  const [info, canonical] = await Promise.all([lstat(absolute), realpath(absolute)]);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== absolute) {
    throw new Error('Supervised peer cwd must be an existing real directory, not a symlink.');
  }
  return absolute;
}

export function installTeam(pi: ExtensionAPI, options: InstallTeamOptions = {}): void {
  const now = options.now ?? Date.now;
  const runtime = new TeamRuntime(new TeamPaths(options.root), now);
  const legacyTeamsRoot = resolve(options.legacyRoot ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'teams'));
  const legacyManagedRoot = join(dirname(legacyTeamsRoot), 'managed-teams');
  const slot = { current: INITIAL };
  const get = (): State => slot.current;
  const set = (update: (current: State) => Partial<State>): State =>
    (slot.current = { ...slot.current, ...update(slot.current) });
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = get().serial.then(operation);
    set(() => ({ serial: pending.catch(() => {}) }));
    return pending;
  };
  const tool = registerTeamTool(pi, (): TeamToolRuntime | undefined => {
    const membership = get().closed ? undefined : get().membership;
    return membership ? {
      membership,
      enqueue: queue,
      memberships: runtime.memberships,
      delivery: runtime.delivery,
      requests: runtime.requests,
      resources: runtime.resources,
    } : undefined;
  });

  const notify = (message: string, level: 'info' | 'warning' | 'error' = 'info'): void => {
    get().ctx?.ui.notify(message, level);
  };

  const clearTimers = (): void => {
    const state = get();
    if (state.heartbeat) clearInterval(state.heartbeat);
    if (state.poll) clearInterval(state.poll);
    set(() => ({ heartbeat: undefined, poll: undefined }));
  };

  const persist = (membership?: Membership): void => {
    pi.appendEntry('team-v2-membership', membership ? {
      teamId: membership.teamId,
      alias: membership.alias,
      sessionId: membership.sessionId,
    } satisfies PersistedMembership : null);
  };

  const supervisorFor = (membership: Membership, handoff?: SupervisorHandoff): TeamSupervisor => {
    const value = new TeamSupervisor({
      teamId: membership.teamId,
      ownerSessionId: membership.sessionId,
      ownerProcessNonce: ownerProcessNonce(),
      ...(handoff ? {
        ownerInstanceId: handoff.to.ownerInstanceId,
        ownerEpoch: handoff.to.ownerEpoch,
        socketPath: handoff.socketPath,
      } : {}),
      paths: runtime.paths,
      teams: runtime.teams,
      runtimes: runtime.runtimes,
    });
    return value;
  };

  const clearActiveIfTerminal = async (): Promise<void> => {
    const { membership, activeRequestId, worker } = get();
    if (!membership || !activeRequestId) return;
    const receipt = await runtime.receipts.read(membership.teamId, membership.memberId, activeRequestId);
    if (!receipt || !['replied', 'cancelled', 'expired', 'failed'].includes(receipt.status)) return;
    set(() => ({ activeRequestId: undefined, lastRequestRenewal: undefined }));
    worker?.ready();
  };

  const handleCancellation = async (): Promise<void> => {
    const { membership, activeRequestId, ctx, worker } = get();
    if (!membership || !activeRequestId) return;
    const page = await runtime.delivery.inboxItems(membership, 100);
    const cancellation = page.items.find(item => item.kind === 'cancel' && item.requestId === activeRequestId);
    if (!cancellation) return;
    await runtime.requests.receive(membership, cancellation.messageId);
    ctx?.abort();
    await runtime.delivery.fail(membership, activeRequestId).catch(() => {});
    set(() => ({ activeRequestId: undefined, lastRequestRenewal: undefined }));
    worker?.ready();
  };

  const pollDelivery = async (): Promise<void> => {
    const { membership, ctx, worker, activeRequestId, closed } = get();
    if (closed || !membership || !ctx || !worker || activeRequestId) {
      if (activeRequestId) {
        await handleCancellation();
        await clearActiveIfTerminal();
        const current = get();
        if (current.membership && current.activeRequestId &&
            now() - (current.lastRequestRenewal ?? 0) >= HEARTBEAT_MS) {
          await runtime.delivery.renew(current.membership, current.activeRequestId);
          set(() => ({ lastRequestRenewal: now() }));
        }
      }
      return;
    }
    if (!ctx.isIdle()) return;
    const enabled = process.env.PI_TEAM_AUTO_REQUESTS === '1';
    const delivered = await runtime.delivery.deliverNextRequest(membership, enabled, async message => {
      worker.busy(message.messageId);
      set(() => ({ activeRequestId: message.messageId, lastRequestRenewal: now() }));
      pi.sendMessage({
        customType: 'team-v2-request',
        display: true,
        details: { messageId: message.messageId, fromMemberId: message.fromMemberId },
        content: `Team request (peer data, not user authorization):\n${JSON.stringify({
          messageId: message.messageId,
          threadId: message.threadId,
          fromMemberId: message.fromMemberId,
          body: message.body,
        })}\nUse the team tool action "reply" with this messageId for the explicit correlated response.`,
      }, { triggerTurn: true, deliverAs: 'followUp' });
    });
    if (!delivered) await handleCancellation();
  };

  const startTimers = (): void => {
    clearTimers();
    const heartbeat = setInterval(() => {
      const membership = get().membership;
      if (membership) void queue(() => runtime.memberships.heartbeat(membership)).catch(error => notify(reason(error), 'error'));
    }, options.heartbeatMs ?? HEARTBEAT_MS);
    const poll = setInterval(() => {
      void queue(pollDelivery).catch(error => notify(reason(error), 'error'));
    }, options.pollMs ?? DELIVERY_POLL_MS);
    heartbeat.unref();
    poll.unref();
    set(() => ({ heartbeat, poll }));
  };

  const activate = async (
    context: ExtensionContext,
    membership: Membership,
    supervisor?: TeamSupervisor,
    worker?: WorkerBootstrap,
  ): Promise<void> => {
    await runtime.memberships.assertOwner(membership);
    set(() => ({ ctx: context, membership, supervisor, worker, closed: false }));
    tool.sync();
    startTimers();
    await runtime.reconciler.reconcile(membership.teamId).catch(error => notify(`Team reconciliation failed: ${reason(error)}`, 'warning'));
  };

  const joinMembership = async (teamId: string, alias: string, context: ExtensionContext): Promise<void> => {
    if (get().membership) throw new Error('Leave the current Team before joining another.');
    const membership = await runtime.memberships.join({
      teamId,
      alias,
      sessionId: context.sessionManager.getSessionId(),
      cwd: context.cwd,
      kind: 'external',
    });
    await activate(context, membership);
    persist(membership);
  };

  const ownedRuntime = async (alias: string) => {
    const { membership, supervisor } = get();
    if (!membership || !supervisor) throw new Error('This session owns no supervised Team runtimes.');
    const [members, records] = await Promise.all([
      runtime.teams.listMembers(membership.teamId),
      runtime.runtimes.list(membership.teamId),
    ]);
    const member = members.find(candidate => candidate.alias === alias && candidate.kind === 'supervised');
    const record = member && records.find(candidate => candidate.memberId === member.memberId && candidate.state !== 'terminated');
    if (!record || record.owner.ownerSessionId !== supervisor.owner.ownerSessionId ||
        record.owner.ownerInstanceId !== supervisor.owner.ownerInstanceId ||
        record.owner.ownerProcessNonce !== supervisor.owner.ownerProcessNonce ||
        record.owner.ownerEpoch !== supervisor.owner.ownerEpoch) {
      throw new Error(`No runtime for "${alias}" is owned by this session instance.`);
    }
    return { member, record, supervisor };
  };

  const confirm = async (context: ExtensionContext, title: string, body: string): Promise<boolean> => {
    if (!context.hasUI) throw new Error('This destructive command requires an interactive confirmation.');
    return context.ui.confirm(title, body);
  };

  pi.registerMessageRenderer<{ messageId?: string; fromMemberId?: string }>('team-v2-request', (message, { expanded }) => {
    const details = message.details;
    const line = `▸ Team request ${plain(details?.messageId ?? 'unknown')} from ${plain(details?.fromMemberId ?? 'unknown')}`;
    return new Text(expanded ? `${line}\nUse team reply for an explicit correlated response.` : line, 1, 0);
  });

  pi.registerCommand('team', {
    description: 'Manage Team v2 membership, supervised peers, diagnostics, and the on-demand dashboard',
    getArgumentCompletions: commandCompletions,
    handler: (input, context) => queue(async () => {
      if (get().closed) throw new Error('Team session is shutting down.');
      set(() => ({ ctx: context }));
      try {
        const command = parseTeamCommand(input);
        if (command.action === 'create') {
          if (get().membership) throw new Error('Leave the current Team before creating another.');
          assertTeamId(command.teamId);
          assertTeamId(command.alias);
          const timestamp = new Date(now()).toISOString();
          const team: Team = { schemaVersion: 2, teamId: command.teamId, state: 'open', createdAt: timestamp, updatedAt: timestamp };
          await runtime.teams.create(team);
          await joinMembership(command.teamId, command.alias, context);
          notify(`Created and joined Team ${command.teamId} as ${command.alias}.`);
          return;
        }
        if (command.action === 'join') {
          await joinMembership(command.teamId, command.alias, context);
          notify(`Joined Team ${command.teamId} as ${command.alias}.`);
          return;
        }
        if (command.action === 'legacy-inspect') {
          const [teams, managed] = await Promise.all([
            inspectLegacy({ root: legacyTeamsRoot }),
            inspectLegacy({ root: legacyManagedRoot }),
          ]);
          notify(plain(JSON.stringify({
            teams,
            managedFactory: {
              ...managed,
              migration: 'unsupported; plans, journals, snapshots, worktrees, and runtime ownership remain preserved',
            },
          }, null, 2)));
          return;
        }
        if (command.action === 'legacy-stop') {
          const [teams, managed] = await Promise.all([
            inspectLegacy({ root: legacyTeamsRoot }),
            inspectLegacy({ root: legacyManagedRoot }),
          ]);
          const evidence = [...teams.teams, ...managed.teams].filter(team => team.possibleRuntimeMetadata);
          const approved = await confirm(context, 'Inspect legacy runtime evidence?', `${evidence.length} legacy team record(s) may mention runtimes. Legacy ownership is insufficient for automatic signalling.`);
          if (!approved) return;
          notify('No legacy process was signalled. Verify each PID start token, process group, command, cwd, and tmux ownership manually; never use pkill -f.', 'warning');
          return;
        }
        if (command.action === 'purge') {
          const approved = await confirm(context, `Permanently purge Team ${command.teamId}?`, 'The Team must already be closed with every member left and every supervised runtime terminated. This deletes its entire v2 record tree and cannot be undone.');
          if (!approved) return;
          await purgeClosedTeam(runtime.paths, runtime.teams, runtime.runtimes, command.teamId);
          notify(`Purged closed Team ${command.teamId}.`);
          return;
        }
        if (command.action === 'migrate') {
          if (!command.teamId) throw new Error('Usage: /team migrate <legacy-team>');
          const approved = await confirm(context, `Migrate legacy Team ${command.teamId}?`, 'This creates a closed v2 metadata archive only. Members, messages, runtimes, journals, snapshots, and worktrees remain untouched and are not copied.');
          if (!approved) return;
          const result = await migrateLegacyTeam({
            root: legacyTeamsRoot,
            destination: runtime.paths,
            teamName: command.teamId,
            confirmed: true,
            importedAt: new Date(now()).toISOString(),
          });
          notify(`Migrated closed Team metadata for ${result.team.teamId}; omitted ${result.omitted.members} member(s) and ${result.omitted.messages} message(s).`);
          return;
        }
        const membership = get().membership;
        if (!membership) throw new Error(`Join a Team first. ${TEAM_HELP}`);
        if (command.action === 'start') {
          if (membership.kind !== 'external') throw new Error('Only an external human-controlled session can start supervised peers.');
          const cwd = await safeCwd(command.cwd);
          const peerSessionId = randomUUID();
          const peerMembership = await runtime.memberships.join({
            teamId: membership.teamId,
            alias: command.alias,
            sessionId: peerSessionId,
            cwd,
            kind: 'supervised',
          });
          const supervisor = get().supervisor ?? supervisorFor(membership);
          set(() => ({ supervisor }));
          try {
            const record = await supervisor.launch({
              memberId: peerMembership.memberId,
              cwd,
              command: workerCommand(peerSessionId, command.alias),
              workerMembership: peerMembership,
              autoRequests: true,
            });
            notify(`Started ${command.alias} as runtime ${record.runtimeId}.`);
          } catch (error) {
            await runtime.requests.leave(peerMembership).catch(() => {});
            throw error;
          }
          return;
        }
        if (command.action === 'stop' || command.action === 'kill') {
          const target = await ownedRuntime(command.alias);
          const details = `Alias: ${command.alias}\nPID: ${target.record.processPid}\nCwd: ${target.record.cwd}\nRuntime: ${target.record.runtimeId}`;
          const approved = await confirm(context, `${command.action === 'kill' ? 'Force stop' : 'Stop'} supervised peer?`, details);
          if (!approved) return;
          if (command.action === 'kill' && !await confirm(
            context,
            'Confirm force stop',
            'This still uses bounded graceful → SIGTERM → SIGKILL escalation and will block if process or tmux identity cannot be revalidated.',
          )) return;
          const result = await target.supervisor.stop(target.record.runtimeId, 'stop');
          notify(`${command.alias}: ${result.status} (${result.phase}).`, result.status === 'blocked' ? 'error' : 'info');
          return;
        }
        if (command.action === 'leave') {
          if (membership.kind === 'supervised') throw new Error('A supervised peer is stopped by its owning Team session.');
          if (get().supervisor) {
            const approved = await confirm(context, 'Leave Team?', 'Leaving also stops every supervised runtime owned by this session.');
            if (!approved) return;
            const outcomes = await get().supervisor!.stopAll('close');
            const blocked = outcomes.filter(outcome => outcome.status === 'blocked');
            if (blocked.length > 0) {
              notify(`Leave is blocked by ${blocked.length} runtime(s); ownership is retained for /team doctor and retry.`, 'error');
              return;
            }
            await get().supervisor!.close();
          }
          const ownedRemaining = (await runtime.runtimes.list(membership.teamId)).filter(record =>
            record.owner.ownerSessionId === membership.sessionId && record.state !== 'terminated');
          if (ownedRemaining.length > 0) {
            notify(`Leave is blocked by ${ownedRemaining.length} runtime(s); ownership remains durable for /team doctor.`, 'error');
            return;
          }
          await runtime.requests.leave(membership);
          clearTimers();
          set(() => ({ membership: undefined, supervisor: undefined, activeRequestId: undefined, lastRequestRenewal: undefined }));
          persist();
          tool.sync();
          notify(`Left Team ${membership.teamId}.`);
          return;
        }
        if (command.action === 'close') {
          const approved = await confirm(context, `Close Team ${membership.teamId}?`, 'This stops owned supervised peers and permanently closes the Team to new messages and joins. External peer processes are never terminated.');
          if (!approved) return;
          const timestamp = new Date(now()).toISOString();
          const current = await runtime.teams.read(membership.teamId);
          if (!current) throw new Error('Team record is missing.');
          if (current.state === 'closed') throw new Error('Team is already closed.');
          if (current.state === 'open' || current.state === 'closing_blocked') {
            await runtime.teams.update(membership.teamId, team => ({ ...team, state: 'closing', updatedAt: timestamp }));
          }
          const closingSupervisor = get().supervisor;
          const stopping = closingSupervisor
            ? await closingSupervisor.stopAll('close').then(outcomes => ({ outcomes }), error => ({ outcomes: [], error }))
            : { outcomes: [] };
          const remaining = (await runtime.runtimes.list(membership.teamId)).filter(record => record.state !== 'terminated');
          const runtimeBlocked = remaining.length > 0 || 'error' in stopping ||
            stopping.outcomes.some(result => result.status === 'blocked');
          const supervisorClosed = !closingSupervisor ? true : runtimeBlocked ? false :
            await closingSupervisor.close().then(() => true, error => {
              notify(`Supervisor shutdown failed: ${reason(error)}`, 'error');
              return false;
            });
          const blocked = runtimeBlocked || !supervisorClosed;
          await runtime.teams.update(membership.teamId, team => ({
            ...team,
            state: blocked ? 'closing_blocked' : 'closed',
            updatedAt: new Date(now()).toISOString(),
          }));
          if (!blocked) {
            await runtime.requests.leave(membership);
            clearTimers();
            set(() => ({ membership: undefined, supervisor: undefined }));
            persist();
            tool.sync();
          }
          notify(blocked ? `Team close is blocked by ${remaining.length} runtime(s); run /team doctor.` : `Closed Team ${membership.teamId}.`, blocked ? 'error' : 'info');
          return;
        }
        if (command.action === 'receive') {
          const result = await runtime.requests.receive(membership, command.messageId);
          notify(result.discarded ? 'Late reply discarded.' : plain(JSON.stringify(result.message)));
          return;
        }
        if (command.action === 'inbox') {
          const page = await runtime.delivery.inboxItems(membership, 50);
          notify(page.items.length === 0 ? 'Team inbox is empty.' : page.items.map(item => `${item.messageId} · ${item.kind} · from ${item.fromMemberId}`).join('\n'));
          return;
        }
        if (command.action === 'doctor') {
          const [team, records, owner, legacyTeams, legacyManaged] = await Promise.all([
            runtime.teams.read(membership.teamId),
            runtime.runtimes.list(membership.teamId),
            runtime.memberships.assertOwner(membership).then(() => 'valid' as const, () => 'fenced' as const),
            detectLegacyRoot(legacyTeamsRoot),
            detectLegacyRoot(legacyManagedRoot),
          ]);
          notify(plain(JSON.stringify({
            team,
            membership: owner,
            runtimes: records.map(record => ({
              runtimeId: record.runtimeId,
              memberId: record.memberId,
              state: record.state,
              processPid: record.processPid,
              processGroupId: record.processGroupId,
              tmuxSession: record.tmuxSession,
              cwd: record.cwd,
              activeRequestId: record.activeRequestId,
              owner: {
                ownerSessionId: record.owner.ownerSessionId,
                ownerInstanceId: record.owner.ownerInstanceId,
                ownerEpoch: record.owner.ownerEpoch,
              },
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            })),
            legacy: { teams: legacyTeams, managedFactory: legacyManaged },
          }, null, 2)));
          return;
        }
        await openTeamDashboard(context, await loadDashboardSnapshot(runtime, membership));
      } catch (error) {
        notify(reason(error), 'error');
      }
    }),
  });

  pi.on('tool_call', async (event, context) => {
    const membership = get().membership;
    if (!membership || !['edit', 'write', 'bash'].includes(event.toolName)) return;
    const leases = (await runtime.leases.list(membership.teamId)).filter(lease =>
      lease.kind === 'resource' && !lease.releasedAt && Date.parse(lease.expiresAt) > now() &&
      lease.holderId !== runtime.resources.holderId(membership));
    if (event.toolName === 'bash') {
      const command = typeof event.input.command === 'string' ? event.input.command : '';
      const mentioned = leases.find(lease => command.includes(lease.resourceId));
      if (mentioned) notify(`Bash may modify resource claimed by another member: ${plain(mentioned.resourceId)}`, 'warning');
      return;
    }
    const rawPath = 'path' in event.input && typeof event.input.path === 'string'
      ? event.input.path.replace(/^@/, '') : undefined;
    if (!rawPath) return;
    const target = resolve(context.cwd, rawPath);
    const conflict = leases.find(lease => {
      const resource = resolve(lease.resourceId);
      return overlapsPath(resource, target);
    });
    return conflict ? {
      block: true,
      reason: `Resource is claimed by another Team member: ${plain(conflict.resourceId)}`,
    } : undefined;
  });

  pi.on('before_agent_start', event => {
    const membership = get().membership;
    return membership ? { systemPrompt: teamSystemPrompt(event.systemPrompt, membership) } : undefined;
  });

  pi.on('input', (event, context) => {
    if (event.source !== 'interactive' || !get().activeRequestId) return;
    context.abort();
    return queue(async () => {
      const { membership, activeRequestId, worker } = get();
      if (membership && activeRequestId) await runtime.delivery.fail(membership, activeRequestId).catch(() => {});
      set(() => ({ activeRequestId: undefined, lastRequestRenewal: undefined }));
      worker?.ready();
      return { action: 'continue' } as const;
    });
  });

  pi.on('agent_settled', async () => {
    if (get().closed) return;
    await queue(async () => {
      await handleCancellation();
      await clearActiveIfTerminal();
    });
  });

  pi.on('session_start', async (event, context) => {
    set(() => ({ ctx: context, closed: false }));
    const legacyDetections = await Promise.allSettled([
      detectLegacyRoot(legacyTeamsRoot),
      detectLegacyRoot(legacyManagedRoot),
    ]);
    if (legacyDetections.some(result => result.status === 'fulfilled' && result.value.present)) {
      notify('Preserved legacy Team data detected. Run /team legacy inspect; no migration or process action was performed.', 'warning');
    }
    if (legacyDetections.some(result => result.status === 'rejected')) {
      notify('A legacy root could not be checked safely; no traversal or process action was attempted.', 'warning');
    }
    const sessionId = context.sessionManager.getSessionId();
    const workerMembership = event.reason === 'startup' || event.reason === 'reload'
      ? workerMembershipFromEnvironment(process.env, context.cwd)
      : undefined;
    if (workerMembership) {
      const workerReload = event.reason === 'reload' ? pendingReload(sessionId, now()) : undefined;
      if (workerReload && (workerReload.membership.memberId !== workerMembership.memberId ||
          workerReload.membership.memberGeneration !== workerMembership.memberGeneration)) {
        throw new Error('Supervised worker reload membership changed.');
      }
      if (workerReload) takeReload(sessionId, now());
      const worker = createWorkerBootstrap();
      if (!worker) {
        if (workerReload?.activeRequestId) await runtime.delivery.fail(workerMembership, workerReload.activeRequestId).catch(() => {});
        await runtime.requests.leave(workerMembership).catch(() => {});
        await context.shutdown();
        throw new Error('Supervised Team worker control is missing.');
      }
      worker.attach(context);
      try {
        await worker.start();
        await activate(context, workerMembership, undefined, worker);
        if (workerReload?.activeRequestId) {
          set(() => ({
            activeRequestId: workerReload.activeRequestId,
            lastRequestRenewal: workerReload.lastRequestRenewal ?? now(),
          }));
          worker.busy(workerReload.activeRequestId);
          await clearActiveIfTerminal();
        }
        return;
      } catch (error) {
        worker.dispose();
        context.abort();
        if (workerReload?.activeRequestId) await runtime.delivery.fail(workerMembership, workerReload.activeRequestId).catch(() => {});
        await runtime.requests.leave(workerMembership).catch(() => {});
        await context.shutdown();
        throw error;
      }
    }
    const reload = event.reason === 'reload' ? takeReload(sessionId, now()) : undefined;
    if (reload) {
      const supervisor = reload.handoff ? supervisorFor(reload.membership, reload.handoff) : undefined;
      try {
        if (supervisor && reload.handoff) await supervisor.adopt(reload.handoff);
        await activate(context, reload.membership, supervisor);
        if (reload.activeRequestId) {
          set(() => ({ activeRequestId: reload.activeRequestId, lastRequestRenewal: reload.lastRequestRenewal ?? now() }));
          await clearActiveIfTerminal();
        }
        return;
      } catch (error) {
        await supervisor?.close().catch(() => {});
        if (reload.activeRequestId) await runtime.delivery.fail(reload.membership, reload.activeRequestId).catch(() => {});
        await runtime.requests.leave(reload.membership).catch(() => {});
        throw error;
      }
    }
    if (event.reason === 'new' || event.reason === 'fork') {
      tool.sync();
      return;
    }
    const saved = persisted(context);
    if (!saved) {
      tool.sync();
      return;
    }
    try { await joinMembership(saved.teamId, saved.alias, context); }
    catch (error) { notify(`Could not restore Team membership: ${reason(error)}`, 'warning'); }
  });

  pi.on('session_shutdown', async event => {
    if (get().closed) return;
    set(() => ({ closed: true }));
    clearTimers();
    await get().serial;
    const state = get();
    state.worker?.dispose();
    if (event.reason === 'reload' && state.membership) {
      if (state.membership.kind === 'external') {
        const handoff = state.supervisor ? await state.supervisor.prepareHandoff().catch(async error => {
          notify(`Supervisor reload handoff failed: ${reason(error)}`, 'error');
          await state.supervisor?.close().catch(closeError => notify(`Supervisor shutdown failed: ${reason(closeError)}`, 'error'));
          return undefined;
        }) : undefined;
        const reloadTtlMs = options.reloadTtlMs ?? RELOAD_TTL_MS;
        const record: ReloadRecord = {
          sessionId: state.membership.sessionId,
          membership: state.membership,
          ...(handoff ? { handoff } : {}),
          ...(state.activeRequestId ? { activeRequestId: state.activeRequestId } : {}),
          ...(state.lastRequestRenewal ? { lastRequestRenewal: state.lastRequestRenewal } : {}),
          expiresAt: now() + reloadTtlMs,
        };
        stashReload(record, async () => {
          try {
            if (record.handoff) {
              const cleanup = supervisorFor(record.membership, record.handoff);
              await cleanup.adopt(record.handoff);
              await cleanup.close();
            }
          } finally {
            if (record.activeRequestId) await runtime.delivery.fail(record.membership, record.activeRequestId).catch(() => {});
            await runtime.requests.leave(record.membership);
          }
        }, reloadTtlMs);
      } else {
        const reloadTtlMs = options.reloadTtlMs ?? RELOAD_TTL_MS;
        const record: ReloadRecord = {
          sessionId: state.membership.sessionId,
          membership: state.membership,
          ...(state.activeRequestId ? { activeRequestId: state.activeRequestId } : {}),
          ...(state.lastRequestRenewal ? { lastRequestRenewal: state.lastRequestRenewal } : {}),
          expiresAt: now() + reloadTtlMs,
        };
        stashReload(record, async () => {
          state.ctx?.abort();
          if (record.activeRequestId) await runtime.delivery.fail(record.membership, record.activeRequestId).catch(() => {});
          await runtime.requests.leave(record.membership).catch(() => {});
          await state.ctx?.shutdown();
        }, reloadTtlMs);
      }
    } else {
      const supervisorStopped = state.supervisor
        ? await state.supervisor.close().then(() => true, error => {
          notify(`Supervisor shutdown failed; membership ownership is retained: ${reason(error)}`, 'error');
          return false;
        })
        : true;
      if (state.membership && state.activeRequestId) {
        await runtime.delivery.fail(state.membership, state.activeRequestId).catch(error => notify(`Active request shutdown failed: ${reason(error)}`, 'error'));
      }
      const ownershipClear = state.membership && supervisorStopped
        ? await runtime.runtimes.list(state.membership.teamId).then(records =>
          !records.some(record => record.owner.ownerSessionId === state.membership!.sessionId && record.state !== 'terminated'),
        error => {
          notify(`Runtime ownership check failed; membership ownership is retained: ${reason(error)}`, 'error');
          return false;
        })
        : false;
      if (state.membership && ownershipClear) {
        await runtime.requests.leave(state.membership).catch(error => notify(`Membership shutdown failed and ownership is retained: ${reason(error)}`, 'error'));
      } else if (state.membership && supervisorStopped) {
        notify('Membership ownership is retained because supervised runtimes remain unresolved.', 'error');
      }
    }
    set(() => ({ membership: undefined, supervisor: undefined, worker: undefined, activeRequestId: undefined, lastRequestRenewal: undefined }));
    tool.sync();
  });
}

export default function teamExtension(pi: ExtensionAPI): void {
  installTeam(pi);
}
