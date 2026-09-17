import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { StateSchema } from '../schema.ts';

export type LegacyMailboxSummary = {
  readonly members: number;
  readonly messages: number;
  /** Historical PID fields are evidence only, not proof of a live process. */
  readonly possibleRuntimeMetadata: boolean;
};

/** Validate old records without importing the old store or probing its PIDs. */
export function summarizeMailbox(bytes: Buffer, team: string): LegacyMailboxSummary {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  const record = object(parsed);
  const payload = (() => {
    if (record.schemaVersion !== 1) return record;
    if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
      throw new Error('Invalid legacy revision.');
    }
    const serialized = JSON.stringify(record.payload);
    if (serialized === undefined || record.contentHash !== createHash('sha256').update(serialized).digest('hex')) {
      throw new Error('Invalid legacy content hash.');
    }
    return object(record.payload);
  })();
  if (!Value.Check(StateSchema, payload)) throw new Error('Unsupported legacy mailbox.');
  const members = payload.members as { team: string }[];
  const messages = payload.messages as { team: string }[];
  if ([...members, ...messages].some(item => item.team !== team)) throw new Error('Legacy team mismatch.');
  return { members: members.length, messages: messages.length, possibleRuntimeMetadata: members.length > 0 };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid legacy record.');
  return value as Record<string, unknown>;
}
