// Opt-in only: synthetic data, real Codex auth/API; no workspace resources/tools.
// Usage: node live-smoke.mjs <codex-model-id>
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import codexCompaction from './index.ts';

const modelId = process.argv[2];
if (!modelId) throw new Error('Pass a Codex model ID explicitly. This test makes real API calls.');
const root = mkdtempSync(join(tmpdir(), 'pi-native-compaction-smoke-'));
const agentDir = join(root, 'agent');
mkdirSync(agentDir);
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const model = runtime.getModel('openai-codex', modelId);
assert(model, 'Model must exist in the local catalog');
const expected = `ORCHID-${randomUUID().slice(0, 8)}`;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let manager = SessionManager.create(root, root);
for (let i = 0; i < 8; i++) {
  manager.appendMessage({ role: 'user', content: `Synthetic fixture step ${i}. Record the assistant's results for later recall.`, timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: i === 0 ? `The pilot's assigned code is ${expected}. Preserve it for later recall.` : `Fixture step ${i} completed. ` + 'Synthetic non-sensitive filler. '.repeat(160) }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: Date.now() });
}
let replayCount = 0;
async function open(sm) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false }, transport: 'sse' });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => 'You are a concise assistant participating in a synthetic memory test. Preserve exact fixture facts.',
    extensionFactories: [codexCompaction, (pi) => pi.on('before_provider_request', (event) => {
      const input = event.payload.input;
      assert.equal(input.filter((item) => item.type === 'compaction').length, 1);
      assert(!JSON.stringify(input).includes('native compaction checkpoint'));
      // The answer must come from the opaque checkpoint, not retained plaintext.
      assert(!JSON.stringify(input).includes(expected));
      replayCount++;
    })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, thinkingLevel: 'low', noTools: 'all', resourceLoader: loader, sessionManager: sm, settingsManager });
  await session.bindExtensions({ mode: 'print', onError: (error) => { throw new Error(error.error); } });
  return session;
}
let session = await open(manager);
const timeout = setTimeout(() => { console.error('Smoke test timed out'); process.exit(1); }, 180_000);
try {
  await session.compact();
  const file = manager.getSessionFile();
  assert(file);
  const checkpoint = manager.getBranch().findLast((entry) => entry.type === 'compaction');
  assert.equal(checkpoint.details.kind, 'openai-codex-native-compaction');
  assert.equal(session.messages.length, 1, 'Pi retains only the local marker');
  session.dispose();
  manager = SessionManager.open(file);
  session = await open(manager);
  await session.prompt('What exact pilot code was assigned in the fixture? Respond only with the code.');
  const answer = session.messages.findLast((message) => message.role === 'assistant');
  assert.equal(answer.stopReason, 'stop', answer.errorMessage);
  assert(answer.content.some((block) => block.type === 'text' && block.text.includes(expected)), 'Fact must survive native compaction and restart');
  await session.compact();
  session.dispose();
  manager = SessionManager.open(file);
  session = await open(manager);
  await session.prompt('Repeat the exact pilot code. Respond only with the code.');
  const second = session.messages.findLast((message) => message.role === 'assistant');
  assert.equal(second.stopReason, 'stop', second.errorMessage);
  assert(second.content.some((block) => block.type === 'text' && block.text.includes(expected)));
  assert.equal(replayCount, 2);
  console.log(JSON.stringify({ ok: true, model: modelId, compactions: 2, resumedFactChecks: 2, syntheticSession: file }));
} finally {
  clearTimeout(timeout);
  session.dispose();
}
