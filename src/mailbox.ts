import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { ResultSchema, StateSchema } from './schema.ts';
import { envelope, publish, readRecord, readRecordCached, writeAtomic, type Record as StoreRecord } from './store.ts';

export type Membership = { team: string; alias: string; session: string; token: string };
export type Member = Membership & { cwd: string; pid: number; seen: number; status: 'idle' | 'busy' | 'paused' | 'offline' };
export type Result = { outcome: 'completed' | 'failed' | 'interrupted'; body: string; files: string[]; tests: string[] };
export type Message = {
  id: string; team: string; from: string; to: string; subject: string; body: string;
  kind: 'request' | 'note' | 'result'; state: 'pending' | 'processing' | 'completed' | 'interrupted' | 'seen';
  created: number; rootId: string; parentId?: string; claim?: string; result?: Result;
};
export type Outgoing = { to: string; kind: 'request' | 'note'; subject: string; body: string; parentId?: string };
export type FlowItem = Pick<Message, 'id' | 'from' | 'to' | 'subject' | 'state' | 'created'>;
export type Snapshot = { revision: number; members: Member[]; messages: Message[]; flow: FlowItem[] };
type State = { version: 1; members: Member[]; messages: Message[] };
type Presence = { token: string; status: 'idle' | 'busy' | 'paused'; seen: number };
export const LEASE_MS = 30_000;
const MAX_BYTES = 32_000_000;
const MAX_ATTEMPTS = 100;
/** Preallocated attempt sequence: a retry counter without a mutable binding. */
const ATTEMPTS = Array.from({ length: MAX_ATTEMPTS }, (_, index) => index);

function parseMailbox(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new Error('Invalid mailbox format; preserved for manual recovery'); }
}

export function identifier(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(value)) {
    throw new Error('Use 1–48 lowercase letters, digits or hyphens, starting with a letter.');
  }
  return value;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Unsafe directory: ${path}. Expected a private directory owned by this user.`);
  }
}

/**
 * Team mailbox on top of the single-record store. Reads are lock-free; writes
 * compare-and-swap on the record revision and retry against a fresh read, so
 * teammates can write concurrently instead of waiting for a team-wide lock.
 * Presence lives in per-member files outside the record: heartbeats never
 * touch shared state.
 */
export class Mailbox {
  constructor(readonly root: string) {}

  private path(team: string): string { return join(this.root, identifier(team)); }
  private recordPath(team: string): string { return join(this.path(team), 'state.json'); }
  private presencePath(team: string, alias: string): string {
    return join(this.path(team), 'presence', `${identifier(alias)}.json`);
  }

  /** Parse either an envelope record or a pre-envelope mailbox. */
  private parse(raw: string): StoreRecord<State> {
    const parsed = parseMailbox(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === 1) {
      return envelope<State>(raw);
    }
    // Legacy mailbox without an envelope: accepted once as revision 0 and
    // rewritten as an envelope record on the next publication.
    if (!Value.Check(StateSchema, parsed)) throw new Error('Invalid mailbox format; preserved for manual recovery');
    return { revision: 0, payload: parsed as State };
  }

  /** Envelope records plus transparent migration of pre-envelope mailboxes. */
  private normalize(team: string) {
    return (raw: string): StoreRecord<State> => {
      const record = this.parse(raw);
      const state = record.payload;
      if (!Value.Check(StateSchema, state)) throw new Error('Invalid mailbox format; preserved for manual recovery');
      if (state.members.some(m => m.team !== team) || state.messages.some(m => m.team !== team)) {
        throw new Error('Invalid mailbox format: team mismatch');
      }
      return record;
    };
  }

  private async readState(team: string, cached = false): Promise<StoreRecord<State>> {
    const read = cached ? readRecordCached : readRecord;
    const record = await read(this.recordPath(team), this.normalize(team), MAX_BYTES);
    if (record) return record;
    try { await lstat(this.path(team)); }
    catch { throw new Error(`Unknown team "${team}". Use /team list or /team create.`); }
    throw new Error(`Mailbox record for team "${team}" is missing; recovery required.`);
  }

  private async readPresence(team: string): Promise<Map<string, Presence>> {
    const names = await readdir(join(this.path(team), 'presence')).catch(() => [] as string[]);
    const entries = await Promise.all(names.map(async (name): Promise<[string, Presence] | undefined> => {
      if (!/^[a-z][a-z0-9-]{0,47}\.json$/.test(name)) return undefined;
      try {
        const raw = await readFile(join(this.path(team), 'presence', name), 'utf8');
        if (raw.length > 4096) return undefined;
        const presence = JSON.parse(raw) as Presence;
        if (typeof presence?.seen === 'number' && typeof presence?.token === 'string' &&
            ['idle', 'busy', 'paused'].includes(presence?.status)) {
          return [name.slice(0, -'.json'.length), presence];
        }
      } catch { /* A presence file may be replaced or removed mid-read. */ }
      return undefined;
    }));
    return new Map(entries.filter(entry => !!entry));
  }

  private alive(member: Member, presence: Map<string, Presence>): boolean {
    const current = presence.get(member.alias);
    const seen = current?.token === member.token ? current.seen : member.seen;
    if (Date.now() - seen >= LEASE_MS) return false;
    try { process.kill(member.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }

  private withStatus(member: Member, presence: Map<string, Presence>): Member {
    if (member.status === 'offline' || !this.alive(member, presence)) return { ...member, status: 'offline' };
    const current = presence.get(member.alias);
    return { ...member, status: current?.token === member.token ? current.status : member.status };
  }

  /**
   * Optimistic mutation: read lock-free, sweep disconnected members, apply the
   * action, and compare-and-swap the record. Conflicts retry against a fresh
   * read; business errors thrown by the action abort immediately.
   */
  private async mutate<T>(team: string, action: (state: State) => T): Promise<T> {
    await privateDirectory(this.root);
    try { await lstat(this.path(team)); }
    catch { throw new Error(`Unknown team "${team}". Use /team list or /team create.`); }
    await privateDirectory(this.path(team));
    for (const attempt of ATTEMPTS) {
      const record = await this.readState(team);
      const state = record.payload;
      const before = JSON.stringify(state);
      const presence = await this.readPresence(team);
      const swept = state.members.filter(member => member.status !== 'offline' && !this.alive(member, presence));
      for (const member of swept) this.disconnect(state, member);
      const result = action(state);
      if (before === JSON.stringify(state)) return result;
      if (!Value.Check(StateSchema, state)) throw new Error('Invalid mailbox format; refusing to write');
      try {
        await publish(this.recordPath(team), record.revision, state, this.normalize(team), { maxBytes: MAX_BYTES });
        await Promise.all(swept.map(member => unlink(this.presencePath(team, member.alias)).catch(() => {})));
        return result;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'STALE_REVISION' && code !== 'RECORD_LOCKED') throw error;
        await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * Math.min(95, 5 + attempt * 5)));
      }
    }
    throw new Error('Mailbox is busy; try again.');
  }

  async create(team: string): Promise<void> {
    await privateDirectory(this.root);
    try { await mkdir(this.path(team), { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Team "${team}" already exists`);
      throw error;
    }
    await publish(this.recordPath(team), 0, { version: 1, members: [], messages: [] } satisfies State,
      this.normalize(team), { maxBytes: MAX_BYTES });
  }

  async teams(): Promise<string[]> {
    await privateDirectory(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && /^[a-z][a-z0-9-]{0,47}$/.test(e.name)).map(e => e.name).sort();
  }

  async join(team: string, alias: string, session: string, cwd: string): Promise<Membership> {
    identifier(alias);
    const member = await this.mutate(team, state => {
      const existing = state.members.find(m => m.alias === alias);
      if (existing && existing.status !== 'offline' && Date.now() - existing.seen < LEASE_MS) {
        throw new Error(`Alias "${alias}" already in use. Choose another or leave from its terminal.`);
      }
      if (!existing && state.members.length >= 100) throw new Error('Team member limit reached (100)');
      const joined: Member = { team, alias, session, token: randomUUID(), cwd, pid: process.pid, seen: Date.now(), status: 'idle' };
      state.members = state.members.filter(m => m.alias !== alias);
      state.members.push(joined);
      return joined;
    });
    await this.writePresence(member, 'idle');
    return member;
  }

  private owner(state: State, member: Membership): Member {
    const current = state.members.find(m => m.alias === member.alias && m.token === member.token);
    if (!current || current.status === 'offline') throw new Error('Membership expired or replaced. Rejoin the team.');
    return current;
  }

  private async writePresence(member: Membership, status: 'idle' | 'busy' | 'paused'): Promise<void> {
    const text = JSON.stringify({ token: member.token, status, seen: Date.now() } satisfies Presence);
    await writeAtomic(this.presencePath(member.team, member.alias), text, 'light');
  }

  /** Lock-free heartbeat: touches only this member's own presence file. */
  async heartbeat(member: Membership, status: 'idle' | 'busy' | 'paused'): Promise<void> {
    const record = await this.readState(member.team, true);
    const current = record.payload.members.find(m => m.alias === member.alias && m.token === member.token);
    if (!current || current.status === 'offline') throw new Error('Membership expired or replaced. Rejoin the team.');
    await this.writePresence(member, status);
  }

  /** Lock-free consistent view of the record with presence-based statuses. */
  async snapshot(member: Membership): Promise<Snapshot> {
    const record = await this.readState(member.team, true);
    this.owner(record.payload, member);
    const presence = await this.readPresence(member.team);
    return {
      revision: record.revision,
      members: record.payload.members.map(m => this.withStatus(m, presence)),
      messages: record.payload.messages.filter(m => m.from === member.alias || m.to === member.alias),
      // Expose only the metadata needed to understand team-wide request flow;
      // message bodies remain limited to the sender and recipient.
      flow: record.payload.messages
        .filter(m => m.kind === 'request' && (m.state === 'pending' || m.state === 'processing'))
        .map(({ id, from, to, subject, state, created }) => ({ id, from, to, subject, state, created })),
    };
  }

  async members(member: Membership): Promise<Member[]> {
    return (await this.snapshot(member)).members;
  }

  async history(member: Membership): Promise<Message[]> {
    return (await this.snapshot(member)).messages;
  }

  /** Sweep disconnected members (interrupting their claimed work) on demand. */
  async sweep(member: Membership): Promise<void> {
    await this.mutate(member.team, state => { this.owner(state, member); });
  }

  async leave(member: Membership): Promise<void> {
    await this.mutate(member.team, state => { this.disconnect(state, this.owner(state, member)); });
    await unlink(this.presencePath(member.team, member.alias)).catch(() => {});
  }

  async send(member: Membership, input: Outgoing): Promise<Message> {
    identifier(input.to);
    if (!['request', 'note'].includes(input.kind)) throw new Error('Invalid message kind');
    if (!input.subject.trim() || input.subject.length > 160 || !input.body.trim()) throw new Error('Subject and body required (subject up to 160 characters)');
    if (Buffer.byteLength(input.body, 'utf8') > 16_000) throw new Error('Message too large (maximum 16 KB)');
    if (Buffer.byteLength(JSON.stringify(input)) > 20_000) throw new Error('Serialized message too large (maximum 20 KB)');
    return this.mutate(member.team, state => {
      this.owner(state, member);
      if (input.to === member.alias) throw new Error('Cannot send a message to yourself');
      if (!state.members.some(m => m.alias === input.to)) throw new Error(`Unknown teammate "${input.to}"`);
      const parent = input.parentId ? state.messages.find(m => m.id === input.parentId && (m.to === member.alias || m.from === member.alias)) : undefined;
      if (input.parentId && !parent) throw new Error('Unknown parent message');
      if (input.kind === 'request' && parent?.result && parent.result.outcome !== 'completed') throw new Error('Ask the user before starting more work from a failed or interrupted result.');
      if (parent && state.messages.filter(m => m.rootId === parent.rootId && m.kind !== 'result').length >= 8) throw new Error('Conversation limit reached. Ask the user to continue.');
      if (state.messages.some(m => m.from === member.alias && m.to === input.to && m.subject === input.subject && m.body === input.body && Date.now() - m.created < 60_000)) throw new Error('Duplicate message within one minute; do not resend.');
      const unsettled = state.messages.filter(m => ['pending', 'processing'].includes(m.state));
      // Admitted deliveries keep their slot until settled (including a released
      // claim). Every outstanding request also reserves its sender's result slot.
      const occupiedSlots = (alias: string) => unsettled.filter(m => m.to === alias || (m.kind === 'request' && m.from === alias)).length;
      if (occupiedSlots(input.to) >= 50) throw new Error('Recipient inbox full (including reserved results)');
      if (input.kind === 'request' && occupiedSlots(member.alias) >= 50) throw new Error('Sender inbox full; no room to reserve the automatic result');
      // Reserve room for one automatic result per outstanding request.
      const reserved = unsettled.filter(m => m.kind === 'request').length;
      if (state.messages.length + reserved + (input.kind === 'request' ? 2 : 1) > 500) throw new Error('Team history full (500 records). Create a new team.');
      const id = randomUUID();
      const message: Message = {
        id, team: member.team, from: member.alias, to: input.to, subject: input.subject,
        body: input.body, kind: input.kind, state: 'pending', created: Date.now(), rootId: parent?.rootId ?? id, parentId: parent?.id,
      };
      state.messages.push(message);
      return message;
    });
  }

  async notes(member: Membership): Promise<Message[]> {
    return this.mutate(member.team, state => {
      this.owner(state, member);
      const notes = state.messages.filter(m => m.to === member.alias && m.state === 'pending' && m.kind === 'note');
      for (const note of notes) note.state = 'seen';
      return notes;
    });
  }

  async receive(member: Membership, ready: boolean): Promise<Message | undefined> {
    if (!ready) return;
    return this.mutate(member.team, state => {
      this.owner(state, member);
      if (state.messages.some(m => m.to === member.alias && m.state === 'processing')) return;
      const message = state.messages.find(m => m.to === member.alias && m.state === 'pending' && m.kind !== 'note');
      if (!message) return;
      message.state = 'processing';
      message.claim = member.token;
      return message;
    });
  }

  async release(member: Membership, id: string): Promise<void> {
    await this.mutate(member.team, state => {
      this.owner(state, member);
      const message = state.messages.find(m => m.id === id && m.claim === member.token && m.state === 'processing');
      if (!message) throw new Error('Message not claimed by this session');
      message.state = 'pending'; delete message.claim;
    });
  }

  async complete(member: Membership, id: string, result: Result): Promise<void> {
    if (!Value.Check(ResultSchema, result) || Buffer.byteLength(JSON.stringify(result)) > 32000) throw new Error('Invalid or oversized result report');
    await this.mutate(member.team, state => {
      this.owner(state, member);
      const message = state.messages.find(m => m.id === id && m.to === member.alias && m.claim === member.token);
      if (!message) throw new Error('Message not claimed by this session');
      if (message.state !== 'processing') return;
      this.finish(state, message, result);
    });
  }

  private finish(state: State, message: Message, result: Result): void {
    message.state = result.outcome === 'interrupted' ? 'interrupted' : 'completed';
    if (message.kind !== 'request') return;
    state.messages.push({
      id: randomUUID(), team: message.team, from: message.to, to: message.from,
      subject: message.subject, body: result.body, kind: 'result', state: 'pending',
      created: Date.now(), rootId: message.rootId, parentId: message.id, result,
    });
  }

  private disconnect(state: State, member: Member): void {
    member.status = 'offline';
    for (const message of state.messages) {
      if (message.to === member.alias && message.claim === member.token && message.state === 'processing') {
        this.finish(state, message, { outcome: 'interrupted', body: 'Session disconnected. Work may be partially applied and was not automatically retried. Review before continuing.', files: [], tests: [] });
      }
    }
  }
}
