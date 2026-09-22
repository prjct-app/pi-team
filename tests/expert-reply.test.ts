import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expertReply } from '../src/dynamic/worker.ts';

test('an Expert result is typed data rendered the same way every time', () => {
  const text = expertReply({
    kind: 'diagnosis',
    cause: 'The importer drops rows with a BOM',
    evidence: [{ path: 'src/import.ts', line: 42, fact: 'split runs before the BOM is stripped' }],
    fix: { status: 'proposed', files: ['src/import.ts'] },
  });
  assert.equal(text, [
    'kind: diagnosis',
    'cause: The importer drops rows with a BOM',
    '  src/import.ts:42 — split runs before the BOM is stripped',
    'fix: proposed · src/import.ts',
  ].join('\n'));
});

test('a malformed result goes back to the Expert; its content is never censored', () => {
  assert.throws(() => expertReply({ summary: 'All done, looks good' }), /kind: must be one of/);
  assert.throws(() => expertReply({ kind: 'change', checks: [], pending: [] }), /Not recorded/);
  assert.match(expertReply({ kind: 'needs_input', question: 'Keep the v1 importer?', options: ['keep', 'drop'] }), /Keep the v1 importer\?/);
  assert.match(expertReply({ kind: 'answer', answer: 'In a.ts', refs: [], explanation: 'Because…' }), /Because…/);
});
