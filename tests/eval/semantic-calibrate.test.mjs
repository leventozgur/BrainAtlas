// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calibrate } from '../../eval/semantic-calibrate.mjs';

test('grid calibrates fake scores, selects qualified simplest tie and dumps only identifiers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'calibrate-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const corpusDir = path.join(root, 'corpus'); await mkdir(corpusDir);
  await writeFile(path.join(corpusDir, 'one.md'), '# One\nfirst concept');
  await writeFile(path.join(corpusDir, 'two.md'), '# Two\nsecond concept');
  const first = path.join(root, 'first.json'), second = path.join(root, 'second.json');
  await writeFile(first, JSON.stringify([{ id: 'answer', query: 'query-one', relevant: ['one.md'], trToEn: true }]));
  await writeFile(second, JSON.stringify([{ id: 'unknown', query: 'query-none', abstain: true }]));
  const provider = { id: 'fake', dims: 2, embedDocuments: async (texts) => texts.map((x) => /first/.test(x) ? [1, 0] : [0, 1]), embedQuery: async (x) => x === 'query-one' ? [1, 0] : [0, 0] };
  const result = await calibrate({ corpusDir, casesFiles: [first, second], provider, dumpScores: true });
  assert.equal(result.combinations.length, 96);
  assert.equal(result.recommended.ndcgAt10, 1); assert.equal(result.recommended.abstainAccuracy, 1);
  assert.deepEqual(result.recommended.weights, [1, 1]); assert.equal(result.recommended.minMargin, null);
  assert.equal(result.recommended.crossLanguage.recallAt5, 1);
  assert.equal(result.scores[0].topCosine, 1); assert.equal(result.scores[1].margin, 0);
  assert.equal(JSON.stringify(result).includes('query-one'), false);
});

test('no unanswerable cases produces no recommendation and empty corpus is safe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'calibrate-empty-')); t.after(() => rm(root, { recursive: true, force: true }));
  const corpusDir = path.join(root, 'corpus'); await mkdir(corpusDir);
  const casesFile = path.join(root, 'cases.json'); await writeFile(casesFile, '[]');
  const result = await calibrate({ corpusDir, casesFiles: [casesFile], provider: { id: 'fake', dims: 2, embedDocuments: async () => [] }, dumpScores: true });
  assert.equal(result.recommended, null); assert.deepEqual(result.scores, []);
});

test('CLI emits JSON and a table with injected fetch', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(path.join(os.tmpdir(), 'calibrate-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus'); await mkdir(corpus); await writeFile(path.join(corpus, 'one.md'), '# One\nsynthetic');
  const cases = path.join(root, 'cases.json'); await writeFile(cases, JSON.stringify([{ id: 'x', query: 'sample', relevant: ['one.md'], category: 'xling-en2tr' }, { id: 'y', query: 'unknown', abstain: true }]));
  const fake = path.join(root, 'fake.mjs'); await writeFile(fake, `globalThis.fetch = async (_url, options) => ({ok: true, json: async () => ({embeddings: JSON.parse(options.body).input.map(x => x === 'unknown' ? [0,0] : [1,0])})});`);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root };
  const args = ['--import', fake, 'eval/semantic-calibrate.mjs', '--corpus', corpus, '--cases', cases, '--model', 'fake', '--base-url', 'http://example.com', '--dims', '2', '--dump-scores'];
  const json = spawnSync(process.execPath, [...args, '--json'], { env, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr); assert.equal(JSON.parse(json.stdout).recommended.crossLanguage.answerable, 1);
  const table = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.equal(table.status, 0, table.stderr); assert.match(table.stdout, /cross-recall@5/); assert.match(table.stdout, /Recommended:/); assert.doesNotMatch(table.stdout, /sample/);
});
