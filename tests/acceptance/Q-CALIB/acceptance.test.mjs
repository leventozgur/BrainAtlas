// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildIndex, createSearcher, loadPages, normalizeText, search, stem } from '../../../packages/core/src/retrieval/index.mjs';
import { runEval } from '../../../eval/run-eval.mjs';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { migrate } from '../../../packages/core/src/config/migrations/000-to-1.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const now = new Date('2026-11-08T00:00:00.000Z');
const stopwords = new Set('the a an and or of to in for on is are with how what which when where who why does do will this that bir ve veya ile icin nasil nedir ne hangi bu su de da mi mu'.split(' '));
const weights = [4, 3, 2, 1];
const page = (file, body, extra = {}) => ({ path: file, title: 'Evidence', aliases: [], keywords: [], headings: [], body, frontmatter: {}, ...extra });

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-calib-acceptance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Recreate the pre-transform normalization and lexical tie-breaker independently.
function oldRanking(index, query) {
  const terms = [...new Set((normalizeText(query).match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => !stopwords.has(token)).map(stem))];
  const scores = new Map();
  let maxScore = 0;
  for (const term of terms) {
    const list = Object.hasOwn(index.postings, term) ? index.postings[term] : [];
    const idf = Math.log(1 + (index.docs.length - list.length + 0.5) / (list.length + 0.5));
    maxScore += idf * 2.5;
    for (const [id, counts] of list) {
      let tf = 0;
      for (let field = 0; field < 4; field++) {
        tf += weights[field] * counts[field] / (0.25 + 0.75 * index.docs[id].lengths[field] / (index.averages[field] || 1));
      }
      scores.set(id, (scores.get(id) || 0) + idf * 2.5 * tf / (1.5 + tf));
    }
  }
  return [...scores].map(([id, score]) => ({
    id,
    path: index.docs[id].page.path,
    score: score / (maxScore || 1),
  })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en'));
}

function oldCacheKey(vaultDir, pages) {
  const fingerprint = createHash('sha256').update('retrieval-stemmer-v2');
  for (const item of pages) {
    const full = path.join(vaultDir, item.path);
    const stat = fs.statSync(full);
    fingerprint.update(item.path).update(String(stat.mtimeMs)).update(String(stat.size))
      .update(createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return fingerprint.digest('hex');
}

test('new score transform preserves old ordering and path tie-breaking', () => {
  const index = buildIndex([
    page('zeta.md', 'alpha beta archive'),
    page('beta.md', 'alpha beta archive'),
    page('alpha.md', 'alpha beta archive'),
    page('body-only.md', 'alpha evidence beta archive details'),
    page('needle.md', 'alpha beta'),
  ], { now });

  for (const query of ['alpha', 'alpha beta', 'alpha archive missingterm']) {
    const expected = oldRanking(index, query).map((item) => item.path);
    const actual = search(index, query, { limit: 20, abstainThreshold: 0 }).results.map((item) => item.path);
    assert.deepEqual(actual, expected, `legacy and current order for ${query}`);
  }
  const ties = oldRanking(index, 'alpha beta').filter((item) => ['alpha.md', 'beta.md', 'zeta.md'].includes(item.path));
  assert.equal(new Set(ties.map((item) => item.score)).size, 1);
  assert.deepEqual(ties.map((item) => item.path), ['alpha.md', 'beta.md', 'zeta.md']);
});

test('scores are finite and bounded; threshold boundaries and invalid values retain their contract', () => {
  const index = buildIndex([
    page('exact.md', 'alpha beta alpha beta alpha beta'),
    page('partial.md', 'alpha evidence'),
  ], { now });
  const result = search(index, 'alpha beta', { abstainThreshold: 0, limit: 10 });
  assert.ok(result.results.length > 0, 'threshold zero returns a matching document');
  for (const item of result.results) {
    assert.equal(Number.isFinite(item.score), true);
    assert.ok(item.score >= 0 && item.score <= 1);
  }
  assert.ok(result.results[0].score <= 1, 'an exact-term match cannot exceed one');

  const perfectOnly = search(index, 'alpha beta', { abstainThreshold: 1 });
  assert.ok(perfectOnly.results.every((item) => item.score === 1));
  if (result.results[0].score < 1) assert.equal(perfectOnly.abstained, true);
  const boundary = result.results[0].score;
  assert.equal(search(index, 'alpha beta', { abstainThreshold: boundary }).abstained, false);
  assert.equal(search(index, 'alpha beta', { abstainThreshold: boundary + 1e-9 }).abstained, true);

  for (const threshold of [-0.01, 1.01, NaN]) {
    assert.throws(() => search(index, 'alpha', { abstainThreshold: threshold }), { code: 'E_INVALID_INPUT' });
  }
});

test('unmatched terms continue to lower confidence monotonically; no-answer and empty queries abstain', () => {
  const index = buildIndex([page('answer.md', 'alpha beta evidence')], { now });
  const queries = [
    'alpha beta',
    'alpha beta unmatchedwordone',
    'alpha beta unmatchedwordone unmatchedwordtwo',
    'alpha beta unmatchedwordone unmatchedwordtwo unmatchedwordthree',
  ];
  const scores = queries.map((query) => search(index, query, { abstainThreshold: 0 }).results[0].score);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] < scores[i - 1]);
  assert.deepEqual(queries.map((query) => search(index, query, { abstainThreshold: 0 }).results[0].path), Array(4).fill('answer.md'));

  const unrelated = search(index, 'completely unrelatedxyz vocabularyq', { abstainThreshold: 0.35 });
  assert.equal(unrelated.abstained, true);
  assert.equal(unrelated.reason, 'no_match');
  for (const query of ['', ' \t\n ', 'the and of to bir ve ile']) {
    const empty = search(index, query);
    assert.deepEqual(empty.results, []);
    assert.equal(empty.abstained, true);
    assert.equal(empty.reason, 'empty-query');
  }
});

test('typed query and corrupt-index errors are unchanged and do not expose input', () => {
  const index = buildIndex([page('safe.md', 'alpha evidence')], { now });
  assert.throws(() => search(index, 42), { code: 'E_QUERY_INVALID' });
  assert.throws(() => search({}, 'alpha'), { code: 'E_INDEX_CORRUPT' });
  assert.throws(() => search({ version: 1, docs: [], postings: null, averages: [] }, 'alpha'), { code: 'E_INDEX_CORRUPT' });
});

test('pre-transform v1 cache remains readable and search applies the new score transform', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(vault, 'evidence.md'), '# Alpha\nalpha beta evidence');
  const pages = loadPages(vault);
  const index = buildIndex(pages, { now });
  const oldFormatCache = JSON.stringify({ key: oldCacheKey(vault, pages), index });
  const cacheFile = path.join(state, 'retrieval-index.json');
  fs.writeFileSync(cacheFile, oldFormatCache);

  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  const result = searcher.search('alpha beta', { abstainThreshold: 0 });
  assert.equal(result.results[0].path, 'evidence.md');
  assert.equal(result.results[0].score, Math.sqrt(oldRanking(index, 'alpha beta')[0].score));
  assert.equal(fs.readFileSync(cacheFile, 'utf8'), oldFormatCache, 'matching old cache is loaded without rewrite');
});

test('natural dev cases meet the calibrated threshold and excluded pages stay excluded', (t) => {
  const corpusDir = path.join(root, 'eval/corpus-natural');
  const casesFile = path.join(root, 'eval/dev/natural-cases.json');
  const zero = runEval({ corpusDir, casesFile, now, repeat: 1, abstainThreshold: 0 });
  const calibrated = runEval({ corpusDir, casesFile, now, repeat: 1, abstainThreshold: 0.35 });
  assert.equal(zero.n, 100);
  assert.equal(zero.falsePositives.length, 10);
  assert.ok(calibrated.recallAt5 >= 0.9 * zero.recallAt5);
  assert.ok(calibrated.abstainAccuracy >= 0.8);
  assert.ok(calibrated.falsePositives.length <= zero.falsePositives.length);

  const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const index = buildIndex(loadPages(corpusDir), { now });
  const excludedViolations = [];
  for (const item of cases.filter((entry) => entry.category === 'stale-superseded' && Array.isArray(entry.excluded) && entry.excluded.length)) {
    const result = search(index, item.query, { limit: 10, asOf: now, abstainThreshold: 0.35 });
    for (const match of result.results) {
      if (item.excluded.includes(match.path)) excludedViolations.push({ id: item.id, path: match.path });
    }
  }
  assert.deepEqual(excludedViolations, []);

  const categories = [...new Set([...Object.keys(zero.byCategory), ...Object.keys(calibrated.byCategory)])].sort();
  t.diagnostic('natural dev before/after (same sqrt scoring; threshold 0 → 0.35):');
  for (const category of categories) {
    const before = zero.byCategory[category], after = calibrated.byCategory[category];
    t.diagnostic(`${category}: n=${after?.n ?? before?.n}, recall@5=${before?.recallAt5.toFixed(3)} → ${after?.recallAt5.toFixed(3)}, MRR@10=${before?.mrrAt10.toFixed(3)} → ${after?.mrrAt10.toFixed(3)}`);
  }
  t.diagnostic(`overall recall@5=${zero.recallAt5.toFixed(3)} → ${calibrated.recallAt5.toFixed(3)}; abstainAccuracy=${zero.abstainAccuracy.toFixed(3)} → ${calibrated.abstainAccuracy.toFixed(3)}; falsePositives=${zero.falsePositives.length} → ${calibrated.falsePositives.length}`);
});

test('legacy dev set keeps its default-threshold metrics; production defaults remain 0.35', () => {
  const result = runEval({
    corpusDir: path.join(root, 'eval/corpus'),
    casesFile: path.join(root, 'eval/dev/cases.json'),
    now,
    repeat: 1,
  });
  assert.equal(result.abstainThreshold, 0);
  assert.equal(result.recallAt5, 1);
  assert.equal(result.abstainAccuracy, 1);
  assert.equal(defaultConfig('lite').retrieval.abstainThreshold, 0.35);
  assert.equal(migrate({}).retrieval.abstainThreshold, 0.35);
});

test('path traversal and symlink escapes are excluded; configured cache writes stay in temp state', (t) => {
  const direct = buildIndex([
    page('../outside.md', 'traversal canary'),
    page('inside.md', 'inside evidence'),
  ], { now });
  assert.ok(search(direct, 'traversal', { abstainThreshold: 0 }).results.every((item) => item.path !== '../outside.md'));

  const dir = temp(t), vault = path.join(dir, 'vault'), outside = path.join(dir, 'outside.md'), state = path.join(dir, 'state'), fakeHome = path.join(dir, 'home');
  fs.mkdirSync(vault);
  fs.mkdirSync(fakeHome);
  fs.writeFileSync(path.join(vault, 'inside.md'), '# Inside\ninside evidence');
  fs.writeFileSync(outside, '# Outside\nsymlink canary');
  try { fs.symlinkSync(outside, path.join(vault, 'linked.md')); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`symlink unavailable: ${error.code}`); return; }
    throw error;
  }

  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
    assert.deepEqual(searcher.search('canary').results, []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.deepEqual(fs.readdirSync(vault), ['inside.md', 'linked.md']);
  assert.deepEqual(fs.readdirSync(state), ['retrieval-index.json']);
  assert.deepEqual(fs.readdirSync(fakeHome), []);
  assert.equal(fs.readFileSync(outside, 'utf8').includes('symlink canary'), true);
});

test('synthetic secret fragments never enter logs, metrics, or result output', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state'), fakeHome = path.join(dir, 'home');
  fs.mkdirSync(vault);
  fs.mkdirSync(fakeHome);
  fs.writeFileSync(path.join(vault, 'entry.md'), '# Entry\nordinary evidence');
  const syntheticSecret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const casesFile = path.join(dir, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify([{ id: syntheticSecret, query: syntheticSecret, relevant: ['entry.md'] }]));
  const messages = [];
  const originalError = console.error;
  const originalLog = console.log;
  const previousHome = process.env.HOME;
  let metrics, searchResult;
  try {
    process.env.HOME = fakeHome;
    console.error = (...args) => messages.push(args.join(' '));
    console.log = (...args) => messages.push(args.join(' '));
    const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
    searchResult = searcher.search(syntheticSecret);
    metrics = runEval({ corpusDir: vault, casesFile, now, repeat: 1, verbose: true });
  } finally {
    console.error = originalError;
    console.log = originalLog;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  const emitted = JSON.stringify({ searchResult, metrics, messages });
  assert.equal(emitted.includes(syntheticSecret), false);
  assert.ok(messages.length > 0, 'the failure diagnostic path was exercised');
  assert.deepEqual(fs.readdirSync(fakeHome), []);
  assert.deepEqual(fs.readdirSync(state), ['retrieval-index.json']);
});
