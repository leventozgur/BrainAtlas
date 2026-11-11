// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildIndex, createSearcher, loadPages, normalizeText, search, stem } from '../../../packages/core/src/retrieval/index.mjs';
import { runEval } from '../../../eval/run-eval.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const now = new Date('2025-01-01T00:00:00.000Z');
const page = (file, body, frontmatter = {}, extra = {}) => ({
  path: file, title: 'Neutral page', aliases: [], keywords: [], headings: [], body, frontmatter, ...extra,
});
const stopwords = new Set('the a an and or of to in for on is are with how what which when where who why does do will this that bir ve veya ile icin nasil nedir ne hangi bu su de da mi mu'.split(' '));

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-section-acceptance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function terms(text, query = false) {
  return (normalizeText(text).match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => !query || !stopwords.has(token))
    .map(stem);
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split('/').includes('..');
}

function stale(frontmatter, asOf) {
  let expiry = frontmatter.stale_after;
  if (expiry instanceof Date) expiry = expiry.toISOString().slice(0, 10);
  if (!expiry) return false;
  if (typeof expiry === 'string' && /^P\d+[DW]$/u.test(expiry)) {
    const generated = frontmatter.generated instanceof Date ? frontmatter.generated.toISOString().slice(0, 10) : frontmatter.generated;
    const base = new Date(generated);
    if (!Number.isFinite(base.getTime())) return false;
    const days = Number(expiry.slice(1, -1)) * (expiry.endsWith('W') ? 7 : 1);
    expiry = new Date(base.getTime() + days * 86400000);
  }
  const time = new Date(expiry).getTime();
  return Number.isFinite(time) && time < asOf.getTime();
}

// Reference for the pre-section search behavior: ranking, confidence, and result metadata
// are intentionally calculated without consulting section fields or snippets.
function legacySearch(index, query, options = {}) {
  const queryTerms = [...new Set(terms(query, true))];
  const limit = options.limit ?? 5;
  const budget = options.budgetChars ?? Infinity;
  const threshold = options.abstainThreshold ?? 0;
  const asOf = options.asOf ?? new Date(index.now);
  if (!queryTerms.length) return { results: [], abstained: true, reason: 'empty-query', truncated: false };

  const scores = new Map();
  let maxScore = 0;
  for (const term of queryTerms) {
    const list = Object.hasOwn(index.postings, term) ? index.postings[term] : [];
    const idf = Math.log(1 + (index.docs.length - list.length + 0.5) / (list.length + 0.5));
    maxScore += idf * 2.5;
    for (const [id, counts] of list) {
      if (!safePath(index.docs[id]?.page?.path)) continue;
      let tf = 0;
      for (let i = 0; i < 4; i++) tf += [4, 3, 2, 1][i] * counts[i] / (0.25 + 0.75 * index.docs[id].lengths[i] / (index.averages[i] || 1));
      scores.set(id, (scores.get(id) || 0) + idf * 2.5 * tf / (1.5 + tf));
    }
  }
  const ranked = [...scores].map(([id, score]) => ({ id, score: Math.sqrt(score / (maxScore || 1)) }))
    .sort((a, b) => b.score - a.score || (index.docs[a.id].page.path < index.docs[b.id].page.path ? -1 : index.docs[a.id].page.path > index.docs[b.id].page.path ? 1 : 0));
  if (!ranked.length || ranked[0].score < threshold) {
    return { results: [], abstained: true, reason: ranked.length ? 'below_threshold' : 'no_match', truncated: false };
  }
  let remaining = Math.floor(budget), truncated = false;
  const results = ranked.slice(0, limit).map(({ id, score }) => {
    const found = index.docs[id].page;
    let snippet = (found.body || '').trim();
    if (snippet.length > remaining) {
      truncated = true;
      snippet = remaining > 0 ? snippet.slice(0, Math.max(0, remaining - 1)) + '…' : '';
    }
    remaining -= snippet.length;
    const frontmatter = found.frontmatter || {};
    return {
      path: found.path, title: found.title, score, snippet,
      stale: stale(frontmatter, asOf),
      status: typeof frontmatter.status === 'string' ? frontmatter.status : null,
    };
  });
  return { results, abstained: false, reason: null, truncated };
}

function metricSnapshot(cases, resultFor) {
  let recall = 0, reciprocalRank = 0, answerable = 0, abstainRight = 0, abstainCount = 0;
  for (const item of cases) {
    const relevant = Array.isArray(item.relevant) ? item.relevant : [];
    const abstain = Boolean(item.abstain || !relevant.length);
    const result = resultFor(item);
    if (abstain) {
      abstainCount++;
      abstainRight += Number(result.abstained);
      continue;
    }
    answerable++;
    recall += result.results.slice(0, 5).filter((entry) => relevant.includes(entry.path)).length / relevant.length;
    const rank = result.results.findIndex((entry) => relevant.includes(entry.path));
    reciprocalRank += rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0;
  }
  return {
    recallAt5: answerable ? recall / answerable : 0,
    mrrAt10: answerable ? reciprocalRank / answerable : 0,
    abstainAccuracy: abstainCount ? abstainRight / abstainCount : 0,
  };
}

test('contract v1 documents optional section fields and preserves the original required result fields', () => {
  const contract = fs.readFileSync(path.join(root, 'docs/contracts/retrieval.md'), 'utf8');
  assert.match(contract, /^contract-version:\s*1\s*$/mu);
  for (const field of ['heading', 'anchor', 'headingPath']) assert.match(contract, new RegExp(`\\b${field}\\b`, 'u'));
  assert.match(contract, /optional fields are backwards-compatible additions to version 1/u);
  assert.match(contract, /snippet:string/u);

  const result = search(buildIndex([page('contract.md', '# Relevant\ncontractneedle')], { now }), 'contractneedle').results[0];
  assert.equal(typeof result.snippet, 'string');
  assert.ok(result.snippet.length > 0);
  for (const field of ['heading', 'anchor', 'headingPath']) assert.ok(field in result);
});

test('second and third matching sections return their own heading, anchor, path, and nonempty snippet', () => {
  const body = '# Guide\nopening text\n## Second section\nsecondneedle precise evidence\n### Third section\nthirdneedle precise evidence';
  const index = buildIndex([page('guide.md', body)], { now });
  const second = search(index, 'secondneedle').results[0];
  const third = search(index, 'thirdneedle').results[0];
  assert.equal(second.heading, 'Second section');
  assert.equal(second.anchor, 'second-section');
  assert.equal(second.headingPath, 'Guide > Second section');
  assert.equal(second.snippet, '## Second section\nsecondneedle precise evidence');
  assert.equal(third.heading, 'Third section');
  assert.equal(third.anchor, 'third-section');
  assert.equal(third.headingPath, 'Guide > Second section > Third section');
  assert.equal(third.snippet, '### Third section\nthirdneedle precise evidence');
  for (const result of [second, third]) assert.ok(result.snippet.length > 0);
});

test('equal section scores keep the first section and repeated terms do not inflate its score', () => {
  const body = '# First\nsharedneedle sharedneedle sharedneedle\n## Second\nsharedneedle';
  const result = search(buildIndex([page('tie.md', body)], { now }), 'sharedneedle').results[0];
  assert.equal(result.heading, 'First');
  assert.equal(result.anchor, 'first');
  assert.equal(result.snippet, '# First\nsharedneedle sharedneedle sharedneedle');
});

test('backtick and tilde fenced heading-looking lines do not create sections', () => {
  const body = '# Source\nsource context\n```js\n# Backtick fake\nbacktickneedle\n```\n~~~md\n# Tilde fake\ntildeneedle\n~~~\n## Actual section\nactualneedle';
  const index = buildIndex([page('fences.md', body)], { now });
  const backtick = search(index, 'backtickneedle').results[0];
  const tilde = search(index, 'tildeneedle').results[0];
  assert.equal(backtick.heading, 'Source');
  assert.equal(backtick.anchor, 'source');
  assert.equal(tilde.heading, 'Source');
  assert.equal(tilde.anchor, 'source');
  assert.match(tilde.snippet, /^# Source/u);
});

test('duplicate headings get unique suffixed anchors and hostile heading text never yields an empty anchor', () => {
  const body = [
    '# Işık\nfirstneedle',
    '## Işık\nsecondneedle',
    '## Isik-1\nnaturalcollisionneedle',
    '## Işık\nthirdneedle',
    '## 😀💥\nemojineedle',
    '## !?\npunctuationneedle',
    '## ı Ş\nturkishneedle',
  ].join('\n');
  const index = buildIndex([page('anchors.md', body)], { now });
  const results = Object.fromEntries(['firstneedle', 'secondneedle', 'naturalcollisionneedle', 'thirdneedle', 'emojineedle', 'punctuationneedle', 'turkishneedle']
    .map((query) => [query, search(index, query).results[0]]));
  assert.deepEqual([
    results.firstneedle.anchor,
    results.secondneedle.anchor,
    results.naturalcollisionneedle.anchor,
    results.thirdneedle.anchor,
  ], ['isik', 'isik-1', 'isik-1-1', 'isik-2']);
  const generatedAnchors = Object.values(results).map((result) => result.anchor);
  assert.equal(new Set(generatedAnchors).size, generatedAnchors.length);
  for (const result of Object.values(results)) {
    assert.equal(typeof result.heading, 'string');
    assert.ok(result.heading.length > 0);
    assert.ok(result.anchor === null || result.anchor.length > 0);
    assert.ok(result.snippet.length > 0);
  }
  assert.equal(results.turkishneedle.anchor, 'i-s');
});

test('headingless, unmatched, heading-only, and preface text use the documented fallback safely', () => {
  const plainBody = 'plainneedle without headings';
  const plain = search(buildIndex([page('plain.md', plainBody)], { now }), 'plainneedle').results[0];
  assert.equal(plain.heading, null);
  assert.equal(plain.anchor, null);
  assert.equal(plain.headingPath, null);
  assert.equal(plain.snippet, plainBody);

  const unmatchedBody = 'preface text\n# Backup heading\nunrelated content';
  const unmatched = search(buildIndex([page('unmatched.md', unmatchedBody)], { now }), 'backup').results[0];
  assert.equal(unmatched.heading, null);
  assert.equal(unmatched.anchor, null);
  assert.equal(unmatched.headingPath, null);
  assert.equal(unmatched.snippet, unmatchedBody);

  const prefaceBody = 'introneedle in the preface\n# Later\nother material';
  const preface = search(buildIndex([page('preface.md', prefaceBody)], { now }), 'introneedle').results[0];
  assert.equal(preface.heading, null);
  assert.ok(preface.snippet.startsWith('introneedle in the preface'));
});

test('a single-section snippet is byte-for-byte the legacy trimmed body, including CRLF handling', () => {
  const body = '# Topic  \r\n\r\nknowledge topic evidence\r\n';
  const oldSnippet = body.trim();
  const result = search(buildIndex([page('single.md', body)], { now }), 'knowledge').results[0];
  assert.equal(result.snippet, oldSnippet);
  assert.equal(result.heading, 'Topic');
  assert.equal(result.anchor, 'topic');
});

test('BOM-prefixed headings are parsed and Turkish heading anchors fold safely', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'bom.md'), '\uFEFF# İstanbul ve Işık\nBOMneedle');
  const loaded = loadPages(vault)[0];
  const result = search(buildIndex([loaded], { now }), 'BOMneedle').results[0];
  assert.equal(result.heading, 'İstanbul ve Işık');
  assert.equal(result.anchor, 'istanbul-ve-isik');
  assert.equal(normalizeText('İSTANBUL IŞIK ı'), 'istanbul isik i');
});

test('budget boundaries include the heading, use an ellipsis, and never exceed the total budget', () => {
  const index = buildIndex([
    page('a.md', '# Selected heading\nneedle body content'),
    page('b.md', '# Selected heading\nneedle another body'),
  ], { now });
  const zero = search(index, 'needle', { limit: 2, budgetChars: 0 });
  const one = search(index, 'needle', { limit: 1, budgetChars: 1 });
  const two = search(index, 'needle', { limit: 1, budgetChars: 2 });
  const exactBudget = 10;
  const exact = search(buildIndex([page('exact.md', '# H\nneedle')], { now }), 'needle', { budgetChars: exactBudget });
  assert.equal(zero.results[0].snippet, '');
  assert.equal(zero.truncated, true);
  assert.equal(one.results[0].snippet, '…');
  assert.equal(one.truncated, true);
  assert.equal(two.results[0].snippet.length, 2);
  assert.equal(two.results[0].snippet.at(-1), '…');
  assert.ok(two.truncated);
  assert.equal(exact.results[0].snippet, '# H\nneedle');
  assert.equal(exact.truncated, false);
  assert.ok(zero.results.reduce((total, item) => total + item.snippet.length, 0) <= 0);
});

test('heading matches alone do not select an empty section and long sections stay bounded', () => {
  const body = `# Backup\n${'filler '.repeat(10000)}\n## End\nendneedle`;
  const headingOnly = search(buildIndex([page('heading-only.md', '# Backup\nbody without that term')], { now }), 'backup').results[0];
  assert.equal(headingOnly.heading, null);
  assert.equal(headingOnly.snippet, '# Backup\nbody without that term');
  const long = search(buildIndex([page('long.md', body)], { now }), 'filler', { budgetChars: 17 }).results[0];
  assert.equal(long.snippet.length, 17);
  assert.ok(long.snippet.endsWith('…'));
});

// PM update (BA-03, 2026-11-11): identifier-aware retrieval intentionally re-ranks queries that contain code-like
// identifiers (file paths, versions, snake_case, CamelCase). Parity with the legacy ranking is now required for every
// query without such a token; overall recall and abstention must stay equal and MRR must not fall.
const IDENTIFIER_LIKE = /[\p{L}\p{N}][_./][\p{L}\p{N}]|--\p{L}|\p{Ll}\p{Lu}|\p{L}\p{N}|\p{N}\p{L}/u;
test('old and new ranking agree for non-identifier queries; recall and abstention agree and MRR does not fall at T=0.35', (t) => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, 'eval/dev/natural-cases.json'), 'utf8'));
  const index = buildIndex(loadPages(path.join(root, 'eval/corpus-natural')), { now });
  const options = { limit: 10, asOf: now, abstainThreshold: 0.35 };
  const currentFor = (item) => search(index, item.query, options);
  const oldFor = (item) => legacySearch(index, item.query, options);
  let compared = 0;
  for (const item of cases) {
    if (IDENTIFIER_LIKE.test(item.query)) continue;
    compared++;
    const current = currentFor(item), old = oldFor(item);
    // PM update (BA-09, 2026-11-11): provenance trust re-weights verified and weak (proposed/disputed) pages; results carrying
    // a `trust` field are left out of the legacy comparison, every other result must keep its exact order and score.
    const weighted = new Set(index.docs.filter((d) => d.trust && d.trust !== 'neutral').map((d) => d.page.path));
    const keep = (r) => !weighted.has(r.path);
    const a = current.results.filter(keep), b = old.results.filter(keep), n = Math.min(a.length, b.length);
    const pick = ({ path: file, score, stale: isStale, status }) => ({ path: file, score, stale: isStale, status });
    assert.deepEqual(a.slice(0, n).map(pick), b.slice(0, n).map(pick), item.id);
    assert.equal(current.abstained, old.abstained, item.id);
    assert.equal(current.reason, old.reason, item.id);
  }
  const currentMetrics = metricSnapshot(cases, currentFor);
  const oldMetrics = metricSnapshot(cases, oldFor);
  t.diagnostic(`natural-case legacy metrics: ${JSON.stringify(oldMetrics)}; current: ${JSON.stringify(currentMetrics)}; parity cases: ${compared}`);
  assert.ok(compared >= 80, `expected most natural cases to be identifier-free, got ${compared}`);
  for (const key of Object.keys(oldMetrics)) {
    if (/mrr/i.test(key)) assert.ok(currentMetrics[key] >= oldMetrics[key] - 1e-12, key);
    else assert.equal(currentMetrics[key], oldMetrics[key], key);
  }
});

test('natural-case top-1 snippet stem coverage does not regress and reaches 0.9 at T=0.35', (t) => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, 'eval/dev/natural-cases.json'), 'utf8'));
  const pages = loadPages(path.join(root, 'eval/corpus-natural'));
  const byPath = new Map(pages.map((item) => [item.path, item]));
  const index = buildIndex(pages, { now });
  let beforeHits = 0, afterHits = 0, denominator = 0;
  for (const item of cases) {
    const old = legacySearch(index, item.query, { limit: 1, asOf: now, abstainThreshold: 0.35 });
    const current = search(index, item.query, { limit: 1, asOf: now, abstainThreshold: 0.35 });
    if (!old.results.length || !current.results.length) continue;
    denominator++;
    const queryTerms = new Set(terms(item.query, true));
    const oldTerms = new Set(terms(old.results[0].snippet));
    const newTerms = new Set(terms(current.results[0].snippet));
    beforeHits += Number([...queryTerms].some((term) => oldTerms.has(term)));
    afterHits += Number([...queryTerms].some((term) => newTerms.has(term)));
    assert.ok(byPath.has(current.results[0].path), `unknown top-1 path for ${item.id}`);
  }
  const before = denominator ? beforeHits / denominator : 0;
  const after = denominator ? afterHits / denominator : 0;
  t.diagnostic(`top-1 snippet stem coverage at T=0.35: old=${beforeHits}/${denominator} (${before.toFixed(3)}), new=${afterHits}/${denominator} (${after.toFixed(3)})`);
  assert.ok(denominator > 0);
  assert.ok(after >= before, `coverage regressed from ${beforeHits}/${denominator} to ${afterHits}/${denominator}`);
  assert.ok(after >= 0.9, `new snippet stem coverage=${after} (${afterHits}/${denominator})`);
});

test('2000-page warm queries stay under 300 ms with section selection enabled', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  for (let i = 0; i < 2000; i++) {
    fs.writeFileSync(path.join(vault, `${String(i).padStart(4, '0')}.md`), `---\ntitle: Topic ${i}\n---\n# Overview\ncommon synthetic evidence ${i}\n## Detail\nquerytarget ${i}`);
  }
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  for (let i = 0; i < 2; i++) searcher.search('querytarget 1234');
  const timings = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    searcher.search('querytarget 1234');
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  t.diagnostic(`Q-SECTION warm 2000-page median: ${median.toFixed(2)} ms`);
  assert.ok(median < 300, `median ${median.toFixed(2)} ms`);
});

test('temporary HOME, logs, metrics, traversal, symlink, malformed input, and errors stay contained', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state'), fakeHome = path.join(dir, 'fake-home');
  const outside = path.join(dir, 'outside.md');
  fs.mkdirSync(vault);
  fs.mkdirSync(fakeHome);
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  fs.writeFileSync(path.join(vault, 'entry.md'), `# Private\n${secret} private evidence`);
  fs.writeFileSync(outside, 'linked outside evidence');
  try { fs.symlinkSync(outside, path.join(vault, 'linked.md')); }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; t.skip(`symlink unavailable: ${error.code}`); return; }

  const oldHome = process.env.HOME;
  const logged = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  let searcher;
  try {
    process.env.HOME = fakeHome;
    for (const key of Object.keys(originals)) console[key] = (...args) => logged.push(args.join(' '));
    searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
    searcher.search(secret);
  } finally {
    for (const [key, fn] of Object.entries(originals)) console[key] = fn;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
  assert.deepEqual(logged, []);
  assert.deepEqual(fs.readdirSync(fakeHome), []);
  assert.deepEqual(fs.readdirSync(state), ['retrieval-index.json']);
  assert.deepEqual(loadPages(vault).map((item) => item.path), ['entry.md']);
  assert.deepEqual(search(buildIndex([page('../outside.md', 'traversalneedle')], { now }), 'traversalneedle').results, []);
  assert.throws(() => search({}, 'query'), { code: 'E_INDEX_CORRUPT' });
  assert.throws(() => search(buildIndex([page('ok.md', 'body')], { now }), 42), { code: 'E_QUERY_INVALID' });
  assert.throws(() => search(buildIndex([page('ok.md', 'body')], { now }), 'body', { budgetChars: -1 }), { code: 'E_INVALID_INPUT' });

  const malformed = path.join(dir, 'malformed');
  fs.mkdirSync(malformed);
  fs.writeFileSync(path.join(malformed, 'bad.md'), '---\ntitle: [invalid\n---\nbody');
  assert.throws(() => loadPages(malformed), (error) => error.code === 'E_INVALID_INPUT' && !error.message.includes(secret));
  const casesFile = path.join(dir, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify([{ id: 'private-case', query: secret, relevant: ['missing.md'] }]));
  const metrics = runEval({ corpusDir: vault, casesFile, now, repeat: 1 });
  assert.equal(JSON.stringify(metrics).includes(secret), false);
  assert.equal(JSON.stringify({ logs: logged }).includes(secret), false);
  assert.equal(fs.existsSync(path.join(dir, secret)), false);
});
