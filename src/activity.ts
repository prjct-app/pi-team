import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Value } from 'typebox/value';
import { identifier } from './mailbox.ts';
import { ActivityEventSchema, type ActivityEvent } from './managed-schema.ts';
import { withFileLock } from './store.ts';

const MAX_FILE_BYTES = 512_000;
const MAX_LINE_BYTES = 16_000;
const MAX_READ_EVENTS = 200;

function stripControls(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** Redact common credential shapes before activity reaches disk or the TUI. */
export function sanitizeActivityText(text: string, limit: number): string {
  return stripControls(text)
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, limit);
}

export function sanitizeActivityEvent(event: ActivityEvent): ActivityEvent {
  const summary = sanitizeActivityText(event.summary, 240).replace(/\s+/g, ' ').trim();
  const detail = event.detail === undefined ? undefined : sanitizeActivityText(event.detail, 2_000);
  const safe = { ...event, summary: summary || 'Activity update', ...(detail === undefined ? {} : { detail }) };
  if (!Value.Check(ActivityEventSchema, safe)) throw new Error('Invalid activity event');
  return safe;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe activity directory: ${path}. Expected a private directory owned by this user.`);
  }
}

async function readSafe(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES || (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())) throw new Error(`Unsafe activity journal: ${path}`);
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseLines(text: string | undefined, alias: string): ActivityEvent[] {
  if (!text) return [];
  return text.split('\n').filter(Boolean).flatMap(line => {
    try {
      const value = JSON.parse(line) as unknown;
      return Value.Check(ActivityEventSchema, value) && (value as ActivityEvent).alias === alias ? [value as ActivityEvent] : [];
    } catch { return []; }
  });
}

export class ActivityJournal {
  constructor(readonly root: string) {}

  private directory(team: string): string { return join(this.root, identifier(team), 'activity'); }
  private path(team: string, alias: string): string { return join(this.directory(team), `${identifier(alias)}.jsonl`); }
  private previousPath(team: string, alias: string): string { return join(this.directory(team), `${identifier(alias)}.1.jsonl`); }
  private lockPath(team: string, alias: string): string { return join(this.root, '.locks', `${identifier(team)}-${identifier(alias)}-activity.lock`); }

  async append(team: string, event: ActivityEvent): Promise<ActivityEvent> {
    identifier(team);
    if (event.alias !== identifier(event.alias)) throw new Error('Invalid activity alias');
    const safe = sanitizeActivityEvent(event);
    const line = `${JSON.stringify(safe)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Activity event is too large');
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, '.locks'));
    await privateDirectory(join(this.root, identifier(team)));
    await privateDirectory(this.directory(team));
    return withFileLock(this.lockPath(team, event.alias), async () => {
      const previous = await readSafe(this.previousPath(team, event.alias));
      const existing = await readSafe(this.path(team, event.alias));
      const last = [...parseLines(previous, event.alias), ...parseLines(existing, event.alias)].at(-1);
      if (last && safe.seq <= last.seq) throw new Error('Activity sequence must increase');
      const size = await stat(this.path(team, event.alias)).then(info => info.size, error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      });
      if (size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
        await unlink(this.previousPath(team, event.alias)).catch(() => {});
        await rename(this.path(team, event.alias), this.previousPath(team, event.alias)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      const handle = await open(this.path(team, event.alias), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(line, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      return safe;
    });
  }

  async read(team: string, alias: string, limit = 50): Promise<ActivityEvent[]> {
    const boundedLimit = Math.max(1, Math.min(MAX_READ_EVENTS, limit));
    const older = parseLines(await readSafe(this.previousPath(team, alias)), alias);
    const current = parseLines(await readSafe(this.path(team, alias)), alias);
    const ordered = [...older, ...current].sort((a, b) => a.seq - b.seq || a.at - b.at);
    const unique = [...new Map(ordered.map(event => [event.seq, event])).values()];
    return unique.slice(-boundedLimit);
  }

  async readTeam(team: string, aliases: string[], limit = 50): Promise<Record<string, ActivityEvent[]>> {
    const entries = await Promise.all(aliases.map(async alias => [alias, await this.read(team, alias, limit)] as const));
    return Object.fromEntries(entries);
  }
}
