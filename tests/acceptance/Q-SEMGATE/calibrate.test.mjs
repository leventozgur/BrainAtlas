// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { calibrate } from '../../../eval/semantic-calibrate.mjs';

const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'eval/semantic-calibrate.mjs');
const makeSecret = () => ['sk', 'test' + 'y'.repeat(24)].join('-');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'q-sem-gate-calibration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus);
  await writeFile(path.join(corpus, 'a-distractor.md'), '# Distractor\nqueryword lure lure');
  await writeFile(path.join(corpus, 'z-target.md'), '# Target\ntarget vectorized proof');
  const answerable = path.join(root, 'answerable.json');
  const unanswerable = path.join(root, 'unanswerable.json');
  await writeFile(answerable, JSON.stringify([{ id: 'answer-case', query: 'answerable queryword', relevant: ['z-target.md'], trToEn: true }]));
  await writeFile(unanswerable, JSON.stringify([{ id: 'empty-case', query: 'unanswerable queryword', relevant: [], abstain: true }]));
  return { root, corpus, answerable, unanswerable };
}

function fakeProvider(seen = []) {
  return {
    id: 'calibration-fixture', dims: 2,
    async embedDocuments(texts) {
      seen.push(...texts);
      return texts.map((text) => text.includes('target vectorized') ? [1, 0] : [0, 1]);
    },
    async embedQuery(query) { return query.startsWith('answerable') ? [1, 0] : [-1, 0]; },
  };
}

test('calibrator enumerates the full grid and selects the hand-computed qualified optimum', async (t) => {
  const f = await fixture(t);
  const oldHome = process.env.HOME;
  const oldTmp = process.env.TMPDIR;
  const oldTmp2 = process.env.TMP;
  const oldTemp = process.env.TEMP;
  process.env.HOME = f.root;
  process.env.TMPDIR = f.root;
  process.env.TMP = f.root;
  process.env.TEMP = f.root;
  const before = (await readdir(f.root)).sort();
  const seen = [];
  let result;
  try {
    result = await calibrate({ corpusDir: f.corpus, casesFiles: [f.answerable, f.unanswerable], provider: fakeProvider(seen), dumpScores: true });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    if (oldTmp2 === undefined) delete process.env.TMP; else process.env.TMP = oldTmp2;
    if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp;
  }

  assert.equal(result.combinations.length, 96);
  assert.deepEqual(new Set(result.combinations.map(({ mode }) => mode)), new Set(['rrf', 'semantic-primary']));
  assert.deepEqual(new Set(result.combinations.map(({ weights }) => weights.join(':'))), new Set(['1:1', '1:2', '1:3']));
  assert.deepEqual(new Set(result.combinations.map(({ minSemanticScore }) => minSemanticScore)), new Set([null, 0.3, 0.5, 0.7]));
  assert.deepEqual(new Set(result.combinations.map(({ minMargin }) => minMargin)), new Set([null, 0.02, 0.05, 0.1]));
  const basic = result.combinations.find(({ mode, weights, minSemanticScore, minMargin }) => mode === 'rrf' && weights.join(':') === '1:1' && minSemanticScore === null && minMargin === null);
  assert.equal(basic.abstainAccuracy, 0);
  assert.equal(basic.recallAt5, 1);
  assert.equal(basic.mrrAt10, 0.5);
  assert.ok(Math.abs(basic.ndcgAt10 - 1 / Math.log2(3)) < 1e-12);
  const optimum = result.recommended;
  assert.equal(optimum.mode, 'semantic-primary');
  assert.deepEqual(optimum.weights, [1, 1]);
  assert.equal(optimum.minSemanticScore, 0.3);
  assert.equal(optimum.minMargin, null);
  assert.equal(optimum.abstainAccuracy, 1);
  assert.equal(optimum.falseAnswerRate, 0);
  assert.equal(optimum.recallAt5, 1);
  assert.equal(optimum.mrrAt10, 1);
  assert.equal(optimum.ndcgAt10, 1);
  assert.equal(optimum.crossLanguage.ndcgAt10, 1);
  assert.equal(optimum.crossLanguage.answerable, 1);
  assert.ok(result.combinations.filter(({ unanswerable, abstainAccuracy }) => unanswerable > 0 && abstainAccuracy >= 0.8)
    .every(({ ndcgAt10 }) => ndcgAt10 <= optimum.ndcgAt10));
  assert.deepEqual(result.scores.map(({ id }) => id), ['answer-case', 'empty-case']);
  assert.deepEqual(Object.keys(result.scores[0]).sort(), ['id', 'margin', 'topCosine']);
  assert.ok(result.scores.every(({ topCosine, margin }) => Number.isFinite(topCosine) && Number.isFinite(margin)));
  assert.ok(!JSON.stringify(result).includes('answerable queryword'));
  assert.ok(!JSON.stringify(result).includes('target vectorized proof'));
  assert.ok(seen.every((text) => !text.includes('answerable queryword')));
  assert.deepEqual((await readdir(f.root)).sort(), before, 'temporary index files are removed and HOME is untouched');
});

test('calibrator uses the simplicity tie-break and validates empty, malformed, and invalid cases', async (t) => {
  const f = await fixture(t);
  const oneAnswer = path.join(f.root, 'one-answer.json');
  const oneEmpty = path.join(f.root, 'one-empty.json');
  await writeFile(oneAnswer, JSON.stringify([{ id: 'answer-case', query: 'answerable retrieval', relevant: ['z-target.md'] }]));
  // This query is deliberately orthogonal to both documents, so the default
  // configuration already abstains without adding either calibration threshold.
  const provider = {
    id: 'tie-fixture', dims: 2,
    async embedDocuments(texts) { return texts.map((text) => text.includes('target vectorized') ? [1, 0] : [0, 1]); },
    async embedQuery() { return [1, 0]; },
  };
  await writeFile(oneEmpty, JSON.stringify([{ id: 'empty-case', query: 'no matching tokens', relevant: [], abstain: true }]));
  // Use a second provider for the empty query so its cosine is 0 for both docs;
  // semantic candidates are filtered as non-positive and lexical search has no hit.
  const tieProvider = { ...provider, async embedQuery(query) { return query.startsWith('answerable') ? [1, 0] : [-1, 0]; } };
  const tie = await calibrate({ corpusDir: f.corpus, casesFiles: [oneAnswer, oneEmpty], provider: tieProvider });
  assert.deepEqual(tie.recommended.weights, [1, 1]);
  assert.equal(tie.recommended.mode, 'rrf');
  assert.equal(tie.recommended.minSemanticScore, null);
  assert.equal(tie.recommended.minMargin, null);
  const answerOnly = await calibrate({ corpusDir: f.corpus, casesFiles: [oneAnswer], provider });
  assert.equal(answerOnly.recommended, null, 'without unanswerable cases no configuration qualifies');

  await assert.rejects(calibrate({ corpusDir: f.corpus, casesFiles: [], provider }), TypeError);
  const malformed = path.join(f.root, 'malformed.json');
  await writeFile(malformed, '{broken');
  await assert.rejects(calibrate({ corpusDir: f.corpus, casesFiles: [malformed], provider }));
  const badCases = path.join(f.root, 'bad-cases.json');
  await writeFile(badCases, JSON.stringify([{ query: 42, relevant: 'not-an-array' }]));
  await assert.rejects(calibrate({ corpusDir: f.corpus, casesFiles: [badCases], provider }), /Invalid calibration cases/u);
});

test('calibrator excludes symlink corpus content and never serializes prompts or document text', async (t) => {
  const f = await fixture(t);
  const secret = makeSecret();
  const outside = path.join(f.root, 'outside.md');
  await writeFile(outside, `# Outside\n${secret}`);
  await symlink(outside, path.join(f.corpus, 'outside-link.md'));
  const seen = [];
  const result = await calibrate({ corpusDir: f.corpus, casesFiles: [f.answerable, f.unanswerable], provider: fakeProvider(seen), dumpScores: true });
  assert.ok(seen.every((text) => !text.includes(secret)));
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('target vectorized proof'));
  assert.deepEqual(result.scores.map(({ id }) => id), ['answer-case', 'empty-case']);
});

test('calibration CLI emits valid JSON with a fake provider and a one-line error when the provider is offline', async (t) => {
  const f = await fixture(t);
  const calls = path.join(f.root, 'calls.jsonl');
  await writeFile(calls, '');
  const preload = path.join(f.root, 'fake-fetch.mjs');
  await writeFile(preload, `
    import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      fs.appendFileSync(process.env.CALIBRATION_CALLS, JSON.stringify({ url: String(url), input: body.input }) + '\\n');
      if (process.env.CALIBRATION_OFFLINE === '1') throw new Error(process.env.CALIBRATION_FAILURE);
      return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1]) }) };
    };
  `);
  const secret = makeSecret();
  const baseEnv = {
    ...process.env,
    HOME: f.root,
    TMPDIR: f.root,
    TMP: f.root,
    TEMP: f.root,
    CALIBRATION_CALLS: calls,
    CALIBRATION_FAILURE: secret,
  };
  const baseArgs = [
    '--corpus', f.corpus,
    '--cases', `${f.answerable},${f.unanswerable}`,
    '--model', 'fixture-model',
    '--base-url', 'http://127.0.0.1:1/private-fixture',
    '--query-prefix', 'query: ',
    '--doc-prefix', 'document: ',
    '--dims', '1',
    '--dump-scores',
    '--json',
  ];
  const before = (await readdir(f.root)).sort();
  const ok = spawnSync(process.execPath, ['--import', preload, cliPath, ...baseArgs], { cwd: rootDir, env: baseEnv, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, '');
  assert.equal(ok.stdout.trim().split('\n').length, 1);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.combinations.length, 96);
  assert.deepEqual(report.scores.map(({ id }) => id), ['answer-case', 'empty-case']);
  const requests = (await import('node:fs/promises')).readFile(calls, 'utf8').then((raw) => raw.trim().split('\n').filter(Boolean).map(JSON.parse));
  const parsedRequests = await requests;
  assert.equal(parsedRequests[0].url, 'http://127.0.0.1:1/private-fixture/api/embed');
  assert.ok(parsedRequests[0].input.every((value) => value.startsWith('document: ')));
  assert.ok(parsedRequests.slice(1).flatMap(({ input }) => input).every((value) => value.startsWith('query: ')));
  assert.ok(!ok.stdout.includes('answerable queryword'));

  await writeFile(calls, '');
  const offline = spawnSync(process.execPath, ['--import', preload, cliPath, ...baseArgs], {
    cwd: rootDir,
    env: { ...baseEnv, CALIBRATION_OFFLINE: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(offline.status, 0);
  assert.equal(offline.stdout, '');
  assert.equal(offline.stderr.trim().split('\n').length, 1);
  assert.match(offline.stderr, /^Calibration failed:/u);
  assert.ok(!offline.stderr.includes(secret));
  const failedRequests = (await (await import('node:fs/promises')).readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(failedRequests.length, 1);
  assert.equal(failedRequests[0].url, 'http://127.0.0.1:1/private-fixture/api/embed');
  assert.deepEqual((await readdir(f.root)).sort(), before, 'CLI temporary index files are removed from HOME/TMPDIR');
});
