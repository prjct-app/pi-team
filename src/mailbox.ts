import * as nodeFs from 'node:fs';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { Value } from 'typebox/value';
import { ResultSchema, StateSchema } from './schema.ts';

export type Membership = { team: string; alias: string; session: string; token: string };
export type Member = Membership & { cwd: string; pid: number; seen: number; status: 'idle' | 'busy' | 'paused' | 'offline' };
export type Result = { outcome: 'completed' | 'failed' | 'interrupted'; body: string; files: string[]; tests: string[] };
export type Message = {
  id: string; team: string; from: string; to: string; subject: string; body: string;
  kind: 'request' | 'note' | 'result'; state: 'pending' | 'processing' | 'completed' | 'interrupted' | 'seen';
  created: number; rootId: string; parentId?: string; claim?: string; result?: Result;
};
export type Outgoing = { to: string; kind: 'request' | 'note'; subject: string; body: string; parentId?: string };
type State = { version: 1; members: Member[]; messages: Message[] };
export const LEASE_MS = 30_000;

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

export class Mailbox {
  constructor(readonly root: string) {}

  private path(team: string): string { return join(this.root, identifier(team)); }

  private async read(team: string): Promise<State> {
    const handle = await open(join(this.path(team), 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32_000_000 || (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe mailbox file');
      const data = JSON.parse(await handle.readFile('utf8')) as State;
      if (!Value.Check(StateSchema, data)) throw new Error('Invalid mailbox format; preserved for manual recovery');
      if (data.members.some(m => m.team !== team) || data.messages.some(m => m.team !== team)) throw new Error('Invalid mailbox format: team mismatch');
      return data;
    } finally { await handle.close(); }
  }

  private async write(team: string, state: State): Promise<void> {
    if (!Value.Check(StateSchema, state)) throw new Error('Invalid mailbox format; refusing to write');
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 32_000_000) throw new Error('Team storage limit exceeded');
    const path = join(this.path(team), `${randomUUID()}.tmp`);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(path, join(this.path(team), 'state.json'));
      const directory = await open(this.path(team), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await unlink(path).catch(() => {}); }
  }

  private async transaction<T>(team: string, action: (state: State) => T): Promise<T> {
    await privateDirectory(this.root);
    const dir = this.path(team);
    try { await lstat(dir); } catch { throw new Error(`Unknown team "${team}". Use /team list or /team create.`); }
    await privateDirectory(dir);
    let compromised = false;
    const release = await lockfile.lock(dir, {
      // A plain object avoids jiti/Bun module-proxy invariants when the lock
      // library caches mtime precision via a non-configurable Symbol property.
      fs: { ...nodeFs },
      stale: 10_000, update: 2_000,
      retries: { retries: 200, minTimeout: 10, maxTimeout: 100, randomize: true },
      onCompromised: () => { compromised = true; },
    });
    try {
      const state = await this.read(team);
      const before = JSON.stringify(state);
      for (const member of state.members) {
        let alive = true;
        try { process.kill(member.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (member.status !== 'offline' && (!alive || Date.now() - member.seen >= LEASE_MS)) {
          this.disconnect(state, member);
        }
      }
      const result = action(state);
      if (compromised) throw new Error('Mailbox lock lost; operation not committed');
      if (before !== JSON.stringify(state)) await this.write(team, state);
      return result;
    } finally { await release(); }
  }

  async create(team: string): Promise<void> {
    await privateDirectory(this.root);
    const dir = this.path(team);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Team "${team}" already exists`);
      throw error;
    }
    await this.write(team, { version: 1, members: [], messages: [] });
  }

  async teams(): Promise<string[]> {
    await privateDirectory(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && /^[a-z][a-z0-9-]{0,47}$/.test(e.name)).map(e => e.name).sort();
  }

  async join(team: string, alias: string, session: string, cwd: string): Promise<Membership> {
    identifier(alias);
    return this.transaction(team, state => {
      const existing = state.members.find(m => m.alias === alias);
      if (existing && existing.status !== 'offline' && Date.now() - existing.seen < LEASE_MS) {
        throw new Error(`Alias "${alias}" already in use. Choose another or leave from its terminal.`);
      }
      if (!existing && state.members.length >= 100) throw new Error('Team member limit reached (100)');
      const member: Member = { team, alias, session, token: randomUUID(), cwd, pid: process.pid, seen: Date.now(), status: 'idle' };
      state.members = state.members.filter(m => m.alias !== alias);
      state.members.push(member);
      return member;
    });
  }

  private owner(state: State, member: Membership): Member {
    const current = state.members.find(m => m.alias === member.alias && m.token === member.token);
    if (!current || current.status === 'offline') throw new Error('Membership expired or replaced. Rejoin the team.');
    return current;
  }

  async members(member: Membership): Promise<Member[]> {
    return this.transaction(member.team, state => {
      this.owner(state, member);
      return state.members.map(m => ({ ...m, status: Date.now() - m.seen >= LEASE_MS ? 'offline' : m.status }));
    });
  }

  async leave(member: Membership): Promise<void> {
    await this.transaction(member.team, state => { this.disconnect(state, this.owner(state, member)); });
  }
  async send(member: Membership, input: Outgoing): Promise<Message> {
    identifier(input.to);
    if (!['request', 'note'].includes(input.kind)) throw new Error('Invalid message kind');
    if (!input.subject.trim() || input.subject.length > 160 || !input.body.trim()) throw new Error('Subject and body required (subject up to 160 characters)');
    if (Buffer.byteLength(input.body, 'utf8') > 16_000) throw new Error('Message too large (maximum 16 KB)');
    if (Buffer.byteLength(JSON.stringify(input)) > 20_000) throw new Error('Serialized message too large (maximum 20 KB)');
    return this.transaction(member.team, state => {
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
    return this.transaction(member.team, state => {
      this.owner(state, member);
      const notes = state.messages.filter(m => m.to === member.alias && m.state === 'pending' && m.kind === 'note');
      for (const note of notes) note.state = 'seen';
      return notes;
    });
  }

  async receive(member: Membership, ready: boolean): Promise<Message | undefined> {
    if (!ready) return;
    return this.transaction(member.team, state => {
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
    await this.transaction(member.team, state => {
      this.owner(state, member);
      const message = state.messages.find(m => m.id === id && m.claim === member.token && m.state === 'processing');
      if (!message) throw new Error('Message not claimed by this session');
      message.state = 'pending'; delete message.claim;
    });
  }

  async complete(member: Membership, id: string, result: Result): Promise<void> {
    if (!Value.Check(ResultSchema, result) || Buffer.byteLength(JSON.stringify(result)) > 32000) throw new Error('Invalid or oversized result report');
    await this.transaction(member.team, state => {
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

  async heartbeat(member: Membership, status: 'idle' | 'busy' | 'paused'): Promise<void> {
    await this.transaction(member.team, state => {
      const current = this.owner(state, member);
      current.seen = Date.now();
      current.status = status;
    });
  }

  async history(member: Membership): Promise<Message[]> {
    return this.transaction(member.team, state => {
      this.owner(state, member);
      return state.messages.filter(m => m.from === member.alias || m.to === member.alias);
    });
  }

}
