import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { installTeam } from '../src/index.ts';
import { TeamSession } from '../src/team/session.ts';
import { TeamRuntime } from '../src/runtime/team-runtime.ts';
import { TeamPaths } from '../src/storage/paths.ts';

const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Recipient needed human input instead of continuing autonomously');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('public Pi SDK receives answers, batches, and busy steering without a typed recipient prompt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-team-sdk-'));
  const captures: string[] = [];
  const errors: unknown[] = [];
  const gate: { release?: () => void; used?: boolean } = {};
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('team-fixture', { name: 'Team fixture', api: 'team-fixture-api', apiKey: 'fixture',
    baseUrl: 'http://127.0.0.1.invalid', models: [{ id: 'offline', name: 'Offline', api: 'team-fixture-api', reasoning: true,
      input: ['text'], contextWindow: 100_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const text = JSON.stringify(context.messages); captures.push(text);
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = { role: 'assistant', api: model.api, model: model.id, provider: model.provider,
        content: [{ type: 'text', text: 'Received and continued.' }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const finish = () => { stream.push({ type: 'start', partial: output }); stream.push({ type: 'done', reason: 'stop', message: output }); stream.end(); };
      if (text.includes('HOLD_BUSY') && !gate.used) { gate.used = true; gate.release = finish; options?.signal?.addEventListener('abort', finish, { once: true }); }
      else queueMicrotask(finish);
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({ packages: [], extensions: ['-builtin:mcp'], compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: settings,
    noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [pi => installTeam(pi, { root: join(root, 'team'), pollMs: 150 })] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), modelRuntime: runtime,
    model: runtime.getModel('team-fixture', 'offline')!, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.inMemory(root), thinkingLevel: 'high' });
  const sender = new TeamSession(new TeamRuntime(new TeamPaths(join(root, 'team'))));
  t.after(async () => {
    gate.release?.(); await session.abort();
    await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await sender.disconnect(); await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
  await session.prompt('/team join sdk-team receiver');
  await sender.join({ team: 'sdk-team', role: 'sender', sessionId: 'sdk-sender', cwd: root });
  assert.equal(captures.length, 0);
  for (const index of Array.from({ length: 9 }, (_, i) => i)) {
    await sender.send('receiver', 'info', `ANSWER_${index}`);
    await until(() => captures.some(text => text.includes(`ANSWER_${index}`)) && session.isIdle);
  }
  assert.match(captures[0]!, /You are .*receiver.*sdk-team/);
  await Promise.all(['BATCH_FIRST', 'BATCH_MIDDLE', 'BATCH_LAST'].map(body => sender.send('receiver', 'handoff', body)));
  await until(() => captures.some(text => ['BATCH_FIRST', 'BATCH_MIDDLE', 'BATCH_LAST'].every(body => text.includes(body))) && session.isIdle);
  await sender.send('receiver', 'question', 'HOLD_BUSY');
  await until(() => !!gate.release);
  await sender.send('receiver', 'info', 'BUSY_ANSWER');
  await sender.send('receiver', 'handoff', 'BUSY_HANDOFF');
  await until(() => session.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'team-membership'));
  await new Promise(resolve => setTimeout(resolve, 350));
  gate.release!();
  await until(() => captures.some(text => text.includes('BUSY_ANSWER') && text.includes('BUSY_HANDOFF')) && session.isIdle);
  assert.deepEqual(errors, []);
  assert.equal(session.pendingMessageCount, 0);
});
