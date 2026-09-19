import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandCompletions, parseTeamCommand } from '../src/commands/team-command.ts';
import { workerMembershipFromEnvironment } from '../src/runtime/membership.ts';

test('human Team command parser exposes lifecycle controls without prompt routing', () => {
  assert.deepEqual(parseTeamCommand(''), { action: 'status' });
  assert.deepEqual(parseTeamCommand('create shop lead'), { action: 'create', teamId: 'shop', alias: 'lead' });
  assert.deepEqual(parseTeamCommand('start backend /repo/backend'), { action: 'start', alias: 'backend', cwd: '/repo/backend' });
  assert.deepEqual(parseTeamCommand('purge old-shop'), { action: 'purge', teamId: 'old-shop' });
  assert.throws(() => parseTeamCommand('legacy inspect'), /Usage/);
  assert.throws(() => parseTeamCommand('migrate old-shop'), /Usage/);
  assert.throws(() => parseTeamCommand('plan this objective'), /Usage/);
  assert.deepEqual(commandCompletions('legacy i'), []);
});

test('supervised membership environment is all-or-nothing and bounded', () => {
  assert.equal(workerMembershipFromEnvironment({}, '/repo'), undefined);
  assert.throws(() => workerMembershipFromEnvironment({ PI_TEAM_TEAM_ID: 'shop' }, '/repo'), /Incomplete/);
  const membership = workerMembershipFromEnvironment({
    PI_TEAM_TEAM_ID: 'shop',
    PI_TEAM_MEMBER_ID: 'member-1',
    PI_TEAM_MEMBER_ALIAS: 'backend',
    PI_TEAM_MEMBER_SESSION: 'session-1',
    PI_TEAM_MEMBER_GENERATION: '2',
    PI_TEAM_MEMBER_LEASE_TOKEN: 'a'.repeat(64),
    PI_TEAM_MEMBER_LEASE_GENERATION: '3',
  }, '/repo/backend');
  assert.deepEqual(membership, {
    teamId: 'shop', memberId: 'member-1', alias: 'backend', sessionId: 'session-1',
    memberGeneration: 2, leaseToken: 'a'.repeat(64), leaseGeneration: 3,
    cwd: '/repo/backend', kind: 'supervised',
  });
});
