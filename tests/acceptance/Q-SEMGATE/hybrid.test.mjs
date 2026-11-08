// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSemanticEval } from '../../../eval/semantic-eval.mjs';
import { buildIndex, search } from '../../../packages/core/src/retrieval/index.mjs';
import { cosineSimilarity, searchHybrid } from '../../../modules/semantic/src/hybrid.mjs';

const page = (file, body, frontmatter = {}) => ({ path: file, title: file, aliases: [], keywords: [], headings: [], body, frontmatter });
const makeSecret = () => ['sk', 'test' + 'x'.repeat(24)].join('-');
function legacyRrf(lists) {
  const scores = new Map();
  for (const [listIndex, list] of lists.entries()) {
    const seen = new Set();
    list.forEach((item, rank) => {
      if (seen.has(item.path)) return;
      seen.add(item.path);
      const combined = scores.get(item.path) ?? { ...item, rrfScore: 0, sourceRanks: [] };
      combined.rrfScore += 1 / (60 + rank + 1);
      combined.sourceRanks.push(rank + 1);
      for (const [key, value] of Object.entries(item)) if (combined[key] == null && value != null) combined[key] = value;
      scores.set(item.path, combined);
    });
  }
  return [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.path.localeCompare(b.path));
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'q-sem-gate-hybrid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus');
  await mkdir(corpus);
  return { root, corpus };
}

test('default searchHybrid preserves legacy RRF output and puts a semantic rank-one hit in the first five', async () => {
  const pages = [
    page('a-lex.md', 'needle unrelated text'),
    page('b-sem.md', 'semantic evidence lives here'),
    page('c-lex.md', 'needle unrelated text'),
    page('d-sem.md', 'secondary semantic evidence'),
  ];
  const entries = [
    { path: 'b-sem.md', text: 'semantic evidence lives here', headingPath: '', vector: [1, 0] },
    { path: 'd-sem.md', text: 'secondary semantic evidence', headingPath: '', vector: [0.8, 0.6] },
  ];
  const provider = { embedQuery: async () => [1, 0] };
  const args = { query: 'needle', pages, entries, provider, limit: 5, asOf: new Date('2025-01-01T00:00:00Z') };
  const actual = await searchHybrid(args);
  const explicitLegacyDefaults = await searchHybrid({ ...args, weights: [1, 1], mode: 'rrf' });

  // Reconstruct the old default pipeline and compare its full result objects.
  const lexical = search(buildIndex(pages), 'needle', { limit: 20 }).results;
  const semantic = entries.map((entry) => {
    const source = pages.find(({ path: file }) => file === entry.path);
    return { path: entry.path, title: source.title, status: null, stale: false,
      semanticScore: cosineSimilarity([1, 0], entry.vector), snippet: entry.text, headingPath: entry.headingPath };
  }).sort((a, b) => b.semanticScore - a.semanticScore || a.path.localeCompare(b.path));
  const oldFullOutput = legacyRrf([lexical, semantic]).slice(0, 5);
  assert.deepEqual(actual, explicitLegacyDefaults);
  assert.deepEqual(actual, oldFullOutput);
  assert.deepEqual(actual.map(({ path: file }) => file), ['a-lex.md', 'b-sem.md', 'c-lex.md', 'd-sem.md']);
  assert.deepEqual(actual.map(({ rrfScore, sourceRanks }) => [rrfScore, sourceRanks]), [
    [1 / 61, [1]], [1 / 61, [1]], [1 / 62, [2]], [1 / 62, [2]],
  ]);
  assert.ok(actual.slice(0, 5).some(({ path: file }) => file === 'b-sem.md'));
  assert.equal(actual.fallbackReason, undefined);
});

test('semantic-eval data flow preserves a deterministic semantic rank-one hit in hybrid recall@5', async (t) => {
  const { corpus, root } = await fixture(t);
  for (const index of Array.from({ length: 8 }, (_, i) => i + 1)) {
    await writeFile(path.join(corpus, `a-lex-${index}.md`), `# Lexical ${index}\nquartz unrelated text`);
  }
  await writeFile(path.join(corpus, 'z-semantic.md'), '# Semantic evidence\nmeaningful answer content');
  const casesFile = path.join(root, 'cases.json');
  await writeFile(casesFile, JSON.stringify([{ id: 'tr-to-en', query: 'quartz', relevant: ['z-semantic.md'], trToEn: true }]));
  const provider = {
    id: 'deterministic', dims: 2,
    async embedDocuments(texts) { return texts.map((text) => text.includes('meaningful answer') ? [1, 0] : [0, 1]); },
    async embedQuery() { return [1, 0]; },
  };

  const report = await runSemanticEval({ corpusDir: corpus, casesFile, provider, limit: 5 });
  assert.equal(report.semantic.recallAt5, 1);
  assert.equal(report.hybrid.recallAt5, 1);
  assert.equal(report.hybrid.trToEn.recallAt5, 1);
  assert.equal(report.index.chunks, 9);
});

test('hybrid fusion modes and weights match hand-computed ranks; invalid fusion values fail safely', async () => {
  const pages = [
    page('a-lex.md', 'needle needle needle lexical lure'),
    page('z-target.md', 'the semantically relevant answer'),
    page('m-both.md', 'needle mixed evidence'),
  ];
  const entries = [
    { path: 'z-target.md', text: 'target chunk', vector: [1, 0] },
    { path: 'm-both.md', text: 'mixed chunk', vector: [0.8, 0.6] },
  ];
  const provider = { embedQuery: async () => [1, 0] };
  const call = (options = {}) => searchHybrid({ query: 'needle', pages, entries, provider, limit: 3, ...options });

  const equalWeights = await call({ weights: [1, 1] });
  const semanticDouble = await call({ weights: [1, 2] });
  const semanticTriple = await call({ weights: [1, 3] });
  const primary = await call({ mode: 'semantic-primary' });
  assert.deepEqual(equalWeights.map(({ path: file }) => file), ['m-both.md', 'a-lex.md', 'z-target.md']);
  assert.deepEqual(semanticDouble.map(({ path: file }) => file), ['m-both.md', 'z-target.md', 'a-lex.md']);
  assert.deepEqual(semanticTriple.map(({ path: file }) => file), ['m-both.md', 'z-target.md', 'a-lex.md']);
  assert.deepEqual(primary.map(({ path: file }) => file), ['z-target.md', 'm-both.md', 'a-lex.md']);

  const tiePages = [page('z-both.md', 'needle tied evidence'), page('a-semantic.md', 'semantic tied evidence')];
  const tieEntries = tiePages.map(({ path: file }) => ({ path: file, vector: [1, 0], text: file }));
  const tie = await searchHybrid({ query: 'needle', pages: tiePages, entries: tieEntries, provider, mode: 'semantic-primary' });
  assert.deepEqual(tie.map(({ path: file }) => file), ['z-both.md', 'a-semantic.md'], 'equal semantic scores use lexical rank before path');

  for (const weights of [[-1, 1], [1, Number.NaN], [1, Number.POSITIVE_INFINITY], [0, 1]]) {
    await assert.rejects(call({ weights }), TypeError, `weights ${String(weights)} must be rejected`);
  }
});

test('hybrid rejects malformed mode and threshold values', async () => {
  const options = { query: 'needle', pages: [page('page.md', 'needle')], entries: [], provider: { embedQuery: async () => [1, 0] } };
  await assert.rejects(searchHybrid({ ...options, mode: 'unknown' }), TypeError);
  await assert.rejects(searchHybrid({ ...options, minSemanticScore: Number.NaN }), TypeError);
  await assert.rejects(searchHybrid({ ...options, minMargin: -0.01 }), TypeError);
});

test('abstain thresholds are inclusive at equality, distinguish adjacent values, and annotate empty results', async () => {
  const pages = [page('top.md', 'quartz'), page('second.md', 'quartz')];
  const entries = [
    { path: 'top.md', vector: [0.6, 0.8], text: 'top' },
    { path: 'second.md', vector: [0.8, 0.6], text: 'second' },
  ];
  const provider = { embedQuery: async () => [1, 0] };
  const call = (options = {}) => searchHybrid({ query: 'quartz', pages, entries, provider, limit: 5, ...options });
  const topScore = cosineSimilarity([1, 0], entries[1].vector);
  const margin = topScore - cosineSimilarity([1, 0], entries[0].vector);

  assert.ok((await call({ minSemanticScore: topScore })).length > 0, 'score equal to cutoff passes');
  assert.ok((await call({ minSemanticScore: topScore - Number.EPSILON })).length > 0, 'score just above cutoff passes');
  const tooLow = await call({ minSemanticScore: topScore + Number.EPSILON });
  assert.deepEqual([...tooLow], []);
  assert.equal(tooLow.abstained, true);
  assert.equal(tooLow.reason, 'min-semantic-score');

  assert.ok((await call({ minMargin: margin })).length > 0, 'margin equal to cutoff passes');
  const narrow = await call({ minMargin: margin + Number.EPSILON });
  assert.deepEqual([...narrow], []);
  assert.equal(narrow.abstained, true);
  assert.equal(narrow.reason, 'min-margin');
  assert.ok((await call({ minMargin: margin - Number.EPSILON })).length > 0, 'margin just above cutoff passes');

  const single = await searchHybrid({ query: 'quartz', pages: [pages[0]], entries: [entries[0]], provider, minMargin: 2 });
  assert.ok(single.length > 0, 'a single semantic candidate has maximum cosine margin 2');
  const none = await searchHybrid({ query: 'quartz', pages, entries: [], provider, minSemanticScore: 0.3 });
  assert.deepEqual([...none], []);
  assert.equal(none.abstained, true);
  assert.equal(none.reason, 'no-semantic-results');
  const noThreshold = await searchHybrid({ query: 'quartz', pages, entries: [], provider });
  assert.equal(noThreshold.abstained, undefined, 'thresholds are disabled by default');
  const emptyMargin = await searchHybrid({ query: '', pages: [], entries: [], provider, minMargin: 0.1 });
  assert.deepEqual([...emptyMargin], []);
  assert.equal(emptyMargin.abstained, true);
  assert.equal(emptyMargin.reason, 'no-semantic-results');
});

test('semantic abstention overrides lexical hits, while a lexical abstention can still be filled semantically', async () => {
  const lexicalPage = page('lexical.md', 'quartz lexical evidence');
  const semPage = page('semantic.md', 'unrelated semantic evidence');
  const pages = [lexicalPage, semPage];
  const entries = [{ path: 'semantic.md', vector: [1, 0], text: 'semantic answer' }];
  const provider = { embedQuery: async () => [1, 0] };

  const equalityPasses = await searchHybrid({ query: 'quartz', pages, entries, provider, minSemanticScore: 1 });
  assert.ok(equalityPasses.some(({ path: file }) => file === 'semantic.md'));
  const strictAbstain = await searchHybrid({ query: 'quartz', pages, entries: [{ ...entries[0], vector: [0, 1] }], provider, minSemanticScore: 0.1 });
  assert.deepEqual([...strictAbstain], []);
  assert.equal(strictAbstain.abstained, true);
  assert.equal(strictAbstain.reason, 'min-semantic-score');

  const lexicalMiss = await searchHybrid({ query: 'translation-only', pages: [semPage], entries, provider, minSemanticScore: 0.9 });
  assert.deepEqual(lexicalMiss.map(({ path: file }) => file), ['semantic.md']);
  assert.equal(lexicalMiss.abstained, undefined);
});

test('provider failures and fingerprint mismatches expose content-free fallback reasons', async () => {
  const secret = makeSecret();
  const pages = [page('lexical.md', 'quartz lexical hit')];
  const failed = await searchHybrid({ query: 'quartz', pages, entries: [], provider: { embedQuery: async () => { throw new Error(secret); } } });
  assert.equal(failed.fallbackReason, 'provider-error');
  assert.deepEqual(failed.map(({ path: file }) => file), ['lexical.md']);
  assert.ok(!JSON.stringify(failed).includes(secret));

  let calls = 0;
  const mismatch = await searchHybrid({ query: 'quartz', pages, entries: [], provider: { fingerprint: 'new', embedQuery: async () => { calls++; return [1, 0]; } }, indexMeta: { providerFingerprint: 'old' } });
  assert.equal(mismatch.fallbackReason, 'fingerprint-mismatch');
  assert.deepEqual(mismatch.map(({ path: file }) => file), ['lexical.md']);
  assert.equal(calls, 0);

  const malformedVector = await searchHybrid({ query: 'quartz', pages, entries: [{ path: 'lexical.md', vector: [1] }], provider: { embedQuery: async () => [1, 0] } });
  assert.equal(malformedVector.fallbackReason, 'provider-error');
  assert.deepEqual(malformedVector.map(({ path: file }) => file), ['lexical.md']);
});

test('traversal entries and corpus symlinks are excluded without exposing outside content', async (t) => {
  const { root, corpus } = await fixture(t);
  const secret = makeSecret();
  const outside = path.join(root, 'outside.md');
  await writeFile(outside, `# Outside\n${secret}`);
  await writeFile(path.join(corpus, 'inside.md'), '# Inside\nquartz inside content');
  await symlink(outside, path.join(corpus, 'linked.md'));
  const casesFile = path.join(root, 'cases.json');
  await writeFile(casesFile, JSON.stringify([{ id: 'private-check', query: 'quartz', relevant: ['inside.md'] }]));
  const seen = [];
  const provider = {
    id: 'security-fixture', dims: 2,
    async embedDocuments(texts) { seen.push(...texts); return texts.map(() => [1, 0]); },
    async embedQuery() { return [1, 0]; },
  };
  const report = await runSemanticEval({ corpusDir: corpus, casesFile, provider });
  assert.equal(report.index.chunks, 1);
  assert.ok(seen.every((text) => !text.includes(secret)));
  assert.ok(!JSON.stringify(report).includes(secret));

  const pages = [page('inside.md', 'quartz inside content')];
  const result = await searchHybrid({ query: 'quartz', pages, entries: [{ path: '../outside.md', text: secret, vector: [1, 0] }], provider: { embedQuery: async () => [1, 0] } });
  assert.ok(result.every(({ path: file }) => file !== '../outside.md'));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('core retrieval imports no semantic module and makes no network call when used with semantic disabled', async () => {
  async function sourceFiles(dir) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...await sourceFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(full);
    }
    return found;
  }
  const coreRoot = path.resolve('packages/core/src');
  const files = await sourceFiles(coreRoot);
  const coreText = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(coreText, /(?:from\s*|import\s*\()\s*['"][^'"]*modules\/semantic\//u);

  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('network must remain unused'); };
  try {
    const index = buildIndex([page('local.md', 'quartz local retrieval')]);
    assert.equal(search(index, 'quartz').results[0].path, 'local.md');
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
