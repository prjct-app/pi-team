const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const config = require('./config.cjs');
const { validatePromotion } = require('./validate-promotion.cjs');

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

test('develop is checked while semantic-release publishes only main', () => {
  const checkWorkflow = readFileSync(require.resolve('../workflows/check.yml'), 'utf8');
  const releaseWorkflow = readFileSync(require.resolve('../workflows/release.yml'), 'utf8');
  assert.match(checkWorkflow, /push:\n    branches: \[main, develop\]/);
  assert.match(releaseWorkflow, /push:\n    branches: \[main\]/);
  assert.match(releaseWorkflow, /node \.github\/release\/validate-promotion\.cjs/);
  assert.deepEqual(config.branches, ['main']);
});

test('only the repository develop branch can promote into main', () => {
  const repository = 'prjct-app/pi-team';
  assert.doesNotThrow(() => validatePromotion({
    baseRef: 'main', headRef: 'develop', repository, headRepository: repository,
  }));
  assert.throws(() => validatePromotion({
    baseRef: 'main', headRef: 'feature', repository, headRepository: repository,
  }), /must promote the repository develop branch/);
  assert.throws(() => validatePromotion({
    baseRef: 'main', headRef: 'develop', repository, headRepository: 'fork/pi-team',
  }), /must promote the repository develop branch/);
});

test('individual changes may target develop', () => {
  assert.doesNotThrow(() => validatePromotion({
    baseRef: 'develop', headRef: 'feature', repository: 'prjct-app/pi-team', headRepository: 'fork/pi-team',
  }));
});
