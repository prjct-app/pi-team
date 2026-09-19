import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expertWorkspace, isGitCheckout } from '../src/dynamic/workspace.ts';

test('each write-capable Expert gets its own persistent Git worktree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-ws-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  await writeFile(join(project, 'README.md'), '# probe\n');
  execFileSync('git', ['-C', project, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qam', 'init', '--allow-empty']);
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'readme']);
  assert.equal(await isGitCheckout(project), true);
  assert.equal(await isGitCheckout(root), false);
  const store = join(root, 'store');
  const teamId = `p-${'a'.repeat(40)}`;
  const a = await expertWorkspace({ root: store, teamId, expertId: 'expert-a', projectPath: project });
  const b = await expertWorkspace({ root: store, teamId, expertId: 'expert-b', projectPath: project });
  assert.notEqual(a, b);
  execFileSync('git', ['-C', a, 'checkout', '-qb', 'feature/a']);
  assert.equal(execFileSync('git', ['-C', b, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(), 'HEAD', 'another Expert\'s branch never moves this one');
  assert.equal(execFileSync('git', ['-C', project, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(), 'main', 'nor the person\'s checkout');
  assert.equal(await expertWorkspace({ root: store, teamId, expertId: 'expert-a', projectPath: project }), a, 'reused across assignments');
});
