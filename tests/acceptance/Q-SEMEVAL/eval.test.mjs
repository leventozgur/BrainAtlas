// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSemanticEval } from '../../../eval/semantic-eval.mjs';
import { runEval } from '../../../eval/run-eval.mjs';

const rootDir = path.resolve('.');
const semanticCli = path.join(rootDir, 'eval/semantic-eval.mjs');
const evalCases = [
  { id: 'rank-c', query: 'quartz', relevant: ['c.md'], category: 'tr', trToEn: true },
  { id: 'abstain-case', query: 'no-matching-token', relevant: [], category: 'empty', abstain: true },
];
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'q-semeval-eval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus);
  await writeFile(path.join(corpus, 'a.md'), '# Note\nquartz aa');
  await writeFile(path.join(corpus, 'b.md'), '# Note\nquartz bb');
  await writeFile(path.join(corpus, 'c.md'), '# Note\nquartz cc');
  const cases = path.join(root, 'cases.json');
  await writeFile(cases, JSON.stringify(evalCases));
  return { root, corpus, cases };
}
const vectorForDocument = (text) => text.includes(' aa') ? [1, 0.1] : text.includes(' bb') ? [0.8, 0.6] : [0, 1];
function fakeProvider(calls = {}) {
  return {
    id: 'hand-fixture', dims: 2, fingerprint: 'hand-fingerprint', preprocessVersion: 'hand-v1',
    async embedDocuments(texts) { calls.documents = (calls.documents ?? 0) + 1; return texts.map(vectorForDocument); },
    async embed(texts) { calls.legacy = (calls.legacy ?? 0) + 1; return texts.map(vectorForDocument); },
    async embedQuery(query) { calls.queries = (calls.queries ?? 0) + 1; return query === 'quartz' ? [0, 1] : [0, 1]; },
  };
}

test('semantic evaluator returns hand-computed lexical, semantic and hybrid metrics', async (t) => {
  const f = await fixture(t);
  const calls = {};
  const result = await runSemanticEval({ corpusDir: f.corpus, casesFile: f.cases, provider: fakeProvider(calls) });
  const hand = {
    lexical: { recallAt5: 1, precisionAt5: 0.2, mrrAt10: 1 / 3, ndcgAt10: 0.5 },
    semantic: { recallAt5: 1, precisionAt5: 0.2, mrrAt10: 1, ndcgAt10: 1 },
    hybrid: { recallAt5: 1, precisionAt5: 0.2, mrrAt10: 0.5, ndcgAt10: 1 / Math.log2(3) },
  };
  for (const [mode, metrics] of Object.entries(hand)) {
    for (const [key, value] of Object.entries(metrics)) assert.ok(Math.abs(result[mode][key] - value) < 1e-12, `${mode}.${key}`);
    assert.deepEqual([result[mode].n, result[mode].answerable, result[mode].abstain], [2, 1, 1]);
    assert.equal(result[mode].byCategory.tr.n, 1);
    assert.equal(result[mode].byCategory.empty.answerable, 0);
  }
  assert.equal(result.lexical.trToEn.answerable, 1);
  assert.equal(result.lexical.trToEn.mrrAt10, 1 / 3);
  assert.ok(Math.abs(result.deltaVsLexical.mrrAt10 - (0.5 - 1 / 3)) < 1e-12);
  assert.ok(Math.abs(result.deltaVsLexical.ndcgAt10 - (1 / Math.log2(3) - 0.5)) < 1e-12);
  assert.equal(result.index.chunks, 3);
  assert.ok(Number.isInteger(result.index.jsonBytes) && result.index.jsonBytes > 0);
  assert.equal(result.index.dims, 2);
  assert.deepEqual(Object.keys(result.timing), ['indexBuildMs', 'embedDocsMs', 'queryEmbedMs', 'queryMs']);
  assert.equal(calls.documents, 1);
  assert.equal(calls.queries, evalCases.length);
  assert.equal(calls.legacy, undefined);
  for (const timing of [result.timing.queryEmbedMs, result.timing.queryMs]) {
    assert.ok(Number.isFinite(timing.p50) && timing.p50 >= 0);
    assert.ok(Number.isFinite(timing.p95) && timing.p95 >= timing.p50);
  }
  assert.ok(Number.isFinite(result.timing.indexBuildMs) && result.timing.indexBuildMs >= 0);
  assert.ok(Number.isFinite(result.timing.embedDocsMs) && result.timing.embedDocsMs >= 0);
});

test('semantic evaluator rejects malformed cases/configuration and keeps query, ID and corpus text out of metrics', async (t) => {
  const f = await fixture(t);
  const secret = ['sk', 'test' + 'z'.repeat(24)].join('-');
  const privateCorpus = path.join(f.root, 'private-corpus'); await mkdir(privateCorpus);
  await writeFile(path.join(privateCorpus, 'note.md'), `# Note\nquartz ${secret}`);
  const privateCases = path.join(f.root, 'private-cases.json');
  await writeFile(privateCases, JSON.stringify([{ id: secret, query: secret, relevant: ['note.md'], category: secret }]));
  const result = await runSemanticEval({ corpusDir: privateCorpus, casesFile: privateCases, provider: fakeProvider() });
  assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(runSemanticEval({ corpusDir: f.corpus, casesFile: f.cases, provider: null }));
  await assert.rejects(runSemanticEval({ corpusDir: f.corpus, casesFile: f.cases, provider: fakeProvider(), limit: 0 }));
  const malformed = path.join(f.root, 'malformed.json'); await writeFile(malformed, `{ "${secret}":`);
  await assert.rejects(runSemanticEval({ corpusDir: f.corpus, casesFile: malformed, provider: fakeProvider() }), (error) => !String(error.message + error.stack).includes(secret));
  const invalidCase = path.join(f.root, 'invalid-case.json'); await writeFile(invalidCase, JSON.stringify([{ query: 3, relevant: [] }]));
  await assert.rejects(runSemanticEval({ corpusDir: f.corpus, casesFile: invalidCase, provider: fakeProvider() }));
});

test('semantic CLI help lists recommended prefixes and fake-provider JSON is one clean document', async (t) => {
  const f = await fixture(t);
  const preload = path.join(f.root, 'fake-fetch.mjs');
  const calls = path.join(f.root, 'calls.jsonl');
  await writeFile(calls, '');
  await writeFile(preload, `
    import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      const request = { url: String(url), body: JSON.parse(options.body) };
      fs.appendFileSync(process.env.SEMANTIC_FAKE_CALLS, JSON.stringify(request) + '\\n');
      if (process.env.SEMANTIC_FAKE_MODE === 'reject') throw new Error(process.env.SEMANTIC_FAKE_ERROR);
      return { ok: true, json: async () => ({ embeddings: request.body.input.map(() => [1]) }) };
    };
  `);
  const env = { ...process.env, HOME: f.root, TMPDIR: f.root, SEMANTIC_FAKE_CALLS: calls };
  const cli = (...args) => spawnSync(process.execPath, ['--import', preload, semanticCli, ...args], { cwd: rootDir, env, encoding: 'utf8' });

  const help = spawnSync(process.execPath, [semanticCli, '--help'], { cwd: rootDir, env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const model of ['embeddinggemma', 'multilingual-e5-small', 'qwen3-embedding']) assert.ok(help.stdout.includes(model));
  for (const prefix of ['task: search result | query: ', 'passage: ', 'Query: ']) assert.ok(help.stdout.includes(prefix));

  const before = (await readdir(f.root)).sort();
  const result = cli('--corpus', f.corpus, '--cases', f.cases, '--model', 'embeddinggemma', '--dims', '1', '--base-url', 'http://127.0.0.1:1', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.lexical && report.semantic && report.hybrid && report.deltaVsLexical);
  assert.match(result.stderr, /Warning: no prefixes supplied/u);
  const requests = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(requests.length, 1 + evalCases.length);
  assert.equal(requests[0].url, 'http://127.0.0.1:1/api/embed');
  assert.ok(requests.every(({ body }) => body.model === 'embeddinggemma'));
  assert.deepEqual((await readdir(f.root)).sort(), before, 'CLI left files in HOME/TMPDIR');
});

test('semantic CLI provider failure is concise, nonzero, and excludes prompt, URL and secret', async (t) => {
  const f = await fixture(t);
  const secret = ['sk', 'test' + 'y'.repeat(24)].join('-');
  const casesFile = path.join(f.root, 'failure-cases.json');
  await writeFile(casesFile, JSON.stringify([{ id: 'failure', query: secret, relevant: ['a.md'] }]));
  const calls = path.join(f.root, 'calls.jsonl'); await writeFile(calls, '');
  const preload = path.join(f.root, 'failure-fetch.mjs');
  await writeFile(preload, `
    import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      fs.appendFileSync(process.env.SEMANTIC_FAKE_CALLS, String(url) + '\\n');
      throw new Error(process.env.SEMANTIC_FAKE_ERROR);
    };
  `);
  const env = { ...process.env, HOME: f.root, TMPDIR: f.root, SEMANTIC_FAKE_CALLS: calls, SEMANTIC_FAKE_ERROR: secret };
  const result = spawnSync(process.execPath, ['--import', preload, semanticCli, '--corpus', f.corpus, '--cases', casesFile, '--model', 'local', '--dims', '1', '--base-url', 'http://127.0.0.1:1/private-path', '--json'], { cwd: rootDir, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /^Embedding failed: Ollama unavailable or request rejected;/u);
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes('private-path'));
  assert.equal((await readFile(calls, 'utf8')).trim(), 'http://127.0.0.1:1/private-path/api/embed');
});

test('legacy run-eval keeps dev output keys and golden metrics; natural dev remains stable at threshold zero', () => {
  const old = runEval({ corpusDir: path.join(rootDir, 'eval/corpus'), casesFile: path.join(rootDir, 'eval/dev/cases.json'), repeat: 1 });
  assert.deepEqual(Object.keys(old), ['recallAt5', 'precisionAt5', 'abstainAccuracy', 'trToEnRecallAt5', 'n', 'abstainThreshold', 'mrrAt10', 'ndcgAt10', 'latencyMs', 'indexBuildMs', 'byCategory', 'falsePositives']);
  assert.deepEqual([old.recallAt5, old.precisionAt5, old.abstainAccuracy, old.trToEnRecallAt5, old.n], [1, 0.2000000000000001, 1, 1, 46]);

  const natural = runEval({ corpusDir: path.join(rootDir, 'eval/corpus-natural'), casesFile: path.join(rootDir, 'eval/dev/natural-cases.json'), repeat: 1, abstainThreshold: 0 });
  assert.ok(Math.abs(natural.recallAt5 - 72/95) <= 1e-9, `expected natural recallAt5 72/95 (0.7579, PM correction: brief value 0.758 was rounded) ± 1e-9, got ${natural.recallAt5}`);
  // PM update (BA-03, 2026-11-11): identifier-aware retrieval improves natural MRR (0.687 → 0.694); guard against regression.
  assert.ok(natural.mrrAt10 >= 0.687 - 1e-3, `natural mrrAt10 regressed: ${natural.mrrAt10}`);
  assert.equal(natural.n, 100);
});
