import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTeamCommand, commandCompletions } from '../src/commands/team-command.ts';
test('explicit objective and bounded administrative commands', () => {
  assert.deepEqual(parseTeamCommand('Ship login validation'), { action: 'objective', objective: 'Ship login validation' });
  assert.deepEqual(parseTeamCommand(''), { action: 'status' });
  assert.deepEqual(parseTeamCommand('cancel run-id'), { action: 'cancel', runId: 'run-id' });
  for (const command of ['create t a', 'join t a', 'migrate t', 'legacy inspect', 'start qa /tmp', 'purge t']) assert.throws(() => parseTeamCommand(command));
  assert.throws(() => parseTeamCommand('😀'.repeat(3000)));
  assert.equal(commandCompletions('create'), null);
  assert.deepEqual(parseTeamCommand('Create three independent files in parallel'), { action: 'objective', objective: 'Create three independent files in parallel' });
  assert.deepEqual(parseTeamCommand('start the migration and stop the old worker'), { action: 'objective', objective: 'start the migration and stop the old worker' });
  assert.deepEqual(commandCompletions('s'), [{ value: 'status', label: 'status', description: 'p · panel of Runs and Experts' }]);
});
