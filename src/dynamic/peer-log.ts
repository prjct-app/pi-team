import { appendFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { metadata } from './domain.ts';

/** Kinds an Expert may send another Expert directly. */
export const PEER_KINDS = ['blocker', 'question', 'info', 'handoff'] as const;
export type PeerKind = (typeof PEER_KINDS)[number];

/** One Expert-to-Expert message, as the orchestrator and /team show it. */
export type PeerEntry = { readonly at: string; readonly from: string; readonly to: string; readonly kind: PeerKind; readonly body: string };

const LOG = 'peer-messages.jsonl';
const KEEP = 200;

/**
 * Append-only record of direct messages, so the person (and the orchestrator)
 * can see who talked to whom. The message itself travels through the durable
 * inbox; this is only the trace. Private to the user (0600).
 */
export async function recordPeerMessage(directory: string, entry: PeerEntry): Promise<void> {
  const path = join(directory, LOG);
  const line = JSON.stringify({ ...entry, body: metadata(entry.body, 600) });
  await appendFile(path, `${line}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

/** The most recent direct messages, newest last. */
export async function recentPeerMessages(directory: string, limit = 20): Promise<PeerEntry[]> {
  const text = await readFile(join(directory, LOG), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).slice(-KEEP).flatMap(line => {
    try {
      const value = JSON.parse(line) as PeerEntry;
      return typeof value.from === 'string' && typeof value.to === 'string' && (PEER_KINDS as readonly string[]).includes(value.kind) ? [value] : [];
    } catch { return []; }
  }).slice(-limit);
}

/** "fty-4 → fty-26 blocker: needs the /api/demo route merged first" */
export const peerLine = (entry: PeerEntry): string => `${entry.from} → ${entry.to} ${entry.kind}: ${entry.body.replace(/\s+/g, ' ').slice(0, 200)}`;
