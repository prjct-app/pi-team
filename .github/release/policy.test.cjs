const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('./config.cjs');

async function releaseType(messages) {
  const { analyzeCommits } = await import(require.resolve('@semantic-release/commit-analyzer'));
  return analyzeCommits(config.plugins[0][1], {
    commits: messages.map((message, index) => ({ message, hash: String(index).padStart(40, '0') })),
    logger: { log() {} }
  });
}

for (const [message, expected] of [
  ['fix: repair image preview', 'patch'],
  ['perf: reduce redraws', 'patch'],
  ['feat: add a workflow command', 'minor'],
  ['feat!: replace the command interface', 'major'],
  ['fix: change behavior\n\nBREAKING CHANGE: remove the previous option', 'major'],
  ['docs!: change the supported setup', 'major'],
  ['docs: update the npm description', 'patch'],
  ['ci(release): enable trusted publishing', 'patch'],
  ['chore(deps): update runtime dependencies', 'patch'],
  ['test: add a regression case', null],
  ['chore(release): 0.1.4 [skip ci]', null]
]) {
  test(message.split('\n')[0], async () => {
    assert.equal(await releaseType([message]), expected);
  });
}

test('the highest required bump wins across merged commits', async () => {
  assert.equal(await releaseType(['fix: one', 'feat: two', 'docs: three']), 'minor');
});
