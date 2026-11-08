// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOllamaProvider, markdownChunks, readSemanticIndex, updateSemanticIndex } from '../../../modules/semantic/src/index.mjs';
import { defaultConfig, setConfigValue, validateConfig } from '../../../packages/core/src/config/index.mjs';

test('provider refuses remote endpoints without opt-in and never echoes input', () => {
  assert.throws(() => createOllamaProvider({ model: 'fake', baseUrl: 'https://example.com/private' }), e => e.code === 'E_SEMANTIC_PROVIDER' && !e.message.includes('example.com'));
  assert.doesNotThrow(() => createOllamaProvider({ model: 'fake', baseUrl: 'https://example.com', allowRemote: true }));
});

test('semantic config defaults, legacy config and validation', () => {
  const legacy = defaultConfig('custom'); delete legacy.semantic;
  assert.equal(validateConfig(legacy).ok, true);
  const enabled = setConfigValue(legacy, 'semantic.enabled', true);
  assert.equal(enabled.semantic.minScore, 0.45);
  assert.equal(validateConfig({ ...enabled, semantic: { ...enabled.semantic, baseUrl: 'https://example.com' } }).ok, false);
  assert.equal(validateConfig({ ...enabled, semantic: { ...enabled.semantic, dims: 0 } }).ok, false);
});

test('incremental rebuilds, deletion, corruption, fingerprint and simultaneous updates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'semantic-wire-')); t.after(() => rm(root, { recursive: true, force: true }));
  const corpusDir = join(root, 'corpus'), stateDir = join(root, 'state'); await mkdir(corpusDir);
  await writeFile(join(corpusDir, 'one.md'), '# One\nfirst'); await writeFile(join(corpusDir, 'two.md'), '# Two\nsecond');
  let embedded = 0;
  const provider = { id: 'fake', dims: 2, fingerprint: 'a', async embedDocuments(texts) { embedded += texts.length; return texts.map(() => [1, 0]); } };
  const opts = { corpusDir, stateDir, provider, chunkMarkdown: markdownChunks };
  await Promise.all([updateSemanticIndex(opts), updateSemanticIndex(opts)]); assert.equal(embedded, 2);
  await writeFile(join(corpusDir, 'one.md'), '# One\nchanged'); await updateSemanticIndex(opts); assert.equal(embedded, 3);
  await unlink(join(corpusDir, 'two.md')); await updateSemanticIndex(opts); assert.equal((await readSemanticIndex(stateDir)).entries.length, 1); assert.equal(embedded, 3);
  provider.fingerprint = 'b'; await updateSemanticIndex(opts); assert.equal(embedded, 4);
  await writeFile(join(stateDir, 'semantic/index.json'), '{'); await updateSemanticIndex(opts); assert.equal(embedded, 5);
});
