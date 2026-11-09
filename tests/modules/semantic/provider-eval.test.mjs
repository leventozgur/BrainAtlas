// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOllamaProvider, buildSemanticIndex, readSemanticIndex, markdownChunks, searchHybrid } from '../../../modules/semantic/src/index.mjs';

test('prefixes, batching, and model configuration fingerprints', async () => {
  const inputs = [];
  const fake = async (_url, options) => { const { input } = JSON.parse(options.body); inputs.push(input); return { ok: true, json: async () => ({ embeddings: input.map(() => [1, 0]) }) }; };
  const options = { model: 'model', dims: 2, queryPrefix: 'query: ', documentPrefix: 'doc: ', batchSize: 2, fetchImpl: fake };
  const provider = createOllamaProvider(options);
  await provider.embedDocuments(['a', 'b', 'c']);
  await provider.embedQuery('d');
  await provider.embed(['e']);
  assert.deepEqual(inputs, [['doc: a', 'doc: b'], ['doc: c'], ['query: d'], ['e']]);
  assert.match(provider.fingerprint, /^[0-9a-f]{16}$/u);
  assert.notEqual(provider.fingerprint, createOllamaProvider({ ...options, model: 'other' }).fingerprint);
  assert.notEqual(provider.fingerprint, createOllamaProvider({ ...options, queryPrefix: 'other' }).fingerprint);
  assert.notEqual(provider.fingerprint, createOllamaProvider({ ...options, documentPrefix: 'other' }).fingerprint);
});

test('timeout aborts safely even when fetch ignores cancellation', async () => {
  let signal;
  const provider = createOllamaProvider({ model: 'model', dims: 2, timeoutMs: 10, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(provider.embed(['private prompt']), (error) => error.code === 'E_SEMANTIC_PROVIDER' && !error.message.includes('private'));
  assert.equal(signal.aborted, true);
});

test('index metadata and legacy index mismatch prevent semantic calls', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpusDir = path.join(root, 'corpus'); await mkdir(corpusDir);
  await writeFile(path.join(corpusDir, 'a.md'), '# A\nvehicle content');
  let docs = 0, queries = 0;
  const provider = { id: 'fake', dims: 2, fingerprint: 'new', preprocessVersion: '1', embedDocuments: async (texts) => { docs++; return texts.map(() => [1, 0]); }, embedQuery: async () => { queries++; return [1, 0]; } };
  const index = await buildSemanticIndex({ corpusDir, stateDir: root, provider, chunkMarkdown: markdownChunks });
  assert.equal(docs, 1); assert.equal(index.providerFingerprint, 'new'); assert.equal(index.preprocessVersion, '1');
  const pages = [{ path: 'a.md', title: 'A', aliases: [], keywords: [], headings: [], body: 'vehicle content', frontmatter: {} }];
  const legacy = { ...index }; delete legacy.providerFingerprint;
  await writeFile(path.join(root, 'semantic', 'index.json'), JSON.stringify(legacy));
  const read = await readSemanticIndex(root); assert.ok(read);
  for (const meta of [read, { providerFingerprint: 'old' }]) {
    const result = await searchHybrid({ query: 'vehicle', pages, entries: index.entries, provider, indexMeta: meta });
    assert.equal(result.fallbackReason, 'fingerprint-mismatch'); assert.equal(result[0].path, 'a.md');
  }
  assert.equal(queries, 0);
  const result = await searchHybrid({ query: 'unmatched', pages, entries: index.entries, provider, indexMeta: index });
  assert.equal(queries, 1); assert.equal(result[0].snippet, 'vehicle content'); assert.equal(result[0].headingPath, 'A');
  const failed = await searchHybrid({ query: 'vehicle', pages, entries: index.entries, provider: { embed: async () => { throw new Error('private'); } } });
  assert.equal(failed.fallbackReason, 'provider-error');
});
