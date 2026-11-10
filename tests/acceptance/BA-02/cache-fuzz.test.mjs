// SPDX-License-Identifier: MIT
// BA-02 independent retest: forged on-disk caches whose key matches the CURRENT stat fingerprint.
// Structural violations must never throw and must give fresh-install results (regular tests).
// Content-level forgeries that the cache cannot detect without reading files are reported as findings:
// they are `todo` tests, so the suite stays green while the finding is recorded with its diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearcher, buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';
import { writeSyntheticCorpus } from '../../../eval/lib/synthetic-corpus.mjs';

const ASOF = new Date('2026-02-01T00:00:00Z');
const OPTS = { limit: 5, abstainThreshold: 0, asOf: ASOF };
const QUERIES = ['alpha', 'bravo charlie', 'zephyr', 'quokka', 'wombat', 'delta echo', 'legacy', 'secret token',
  'title', 'foxtrot', 'constructor', 'proto', 'zzz', 'sec notes', 'notes', 'alpha quokka', 'roadmap'];
const canon = (x) => JSON.stringify(x);

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-fuzz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const home = tmpdir(t);
  const vault = path.join(home, 'vault'), wiki = path.join(vault, 'wiki'), stateDir = path.join(home, 'state');
  fs.mkdirSync(path.join(wiki, 'notes'), { recursive: true }); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'alpha.md'), '---\ntitle: Alpha\n---\n# Alpha\nalpha bravo charlie notes\n');
  fs.writeFileSync(path.join(wiki, 'delta.md'), '# Delta\ndelta echo foxtrot\n');
  fs.writeFileSync(path.join(wiki, 'legacy.md'), '---\ntitle: Old\nstatus: superseded\nsuperseded_by: wiki/alpha.md\n---\n# Old\nlegacy zephyr\n');
  fs.writeFileSync(path.join(wiki, 'z.md'), '---\ntitle: Zed\naliases: [quokka]\n---\n## Sec\nalpha quokka wombat\n');
  fs.writeFileSync(path.join(wiki, 'notes', 'deep.md'), '---\nkeywords: [zephyr, title]\nstatus: active\n---\n# Deep Notes\nzephyr notes about proto\n');
  return { home, vault, wiki, stateDir, cache: path.join(stateDir, 'retrieval-index.json') };
}
// Fresh-install reference: buildIndex over loadPages, no cache involved.
function reference(wiki) {
  const index = buildIndex(loadPages(wiki), { now: ASOF });
  return QUERIES.map((q) => canon(search(index, q, OPTS)));
}
// Searcher over the vault; returns per-query results or throws (caller decides).
function run(f) {
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  s.snapshot();
  return { s, results: QUERIES.map((q) => canon(s.search(q, OPTS))) };
}
// Queries whose results differ from a fresh install. Throws (test failure) if the searcher throws.
function diffFromFresh(f, label) {
  let got;
  try { got = run(f).results; }
  catch (error) { assert.fail(`${label}: searcher threw ${error.code ?? error.name}: ${error.message}`); }
  const expected = reference(f.wiki);
  return QUERIES.filter((_, i) => got[i] !== expected[i]);
}
// Write a valid cache, then replace it with a forged payload. `mutate` edits the parsed object;
// `raw` edits the original text (for tokens JSON cannot express, such as NaN or 1e999).
function forge(f, { mutate, raw }) {
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const original = fs.readFileSync(f.cache, 'utf8');
  let text;
  if (raw) {
    text = raw(original);
    assert.notEqual(text, original, 'fixture error: raw forgery did not change the cache');
  } else {
    const d = JSON.parse(original);
    const out = mutate(d);
    text = JSON.stringify(out === undefined ? d : out);
  }
  fs.writeFileSync(f.cache, text);
}

// ---- helpers over the on-disk shape: postings are flat [id, c0, c1, c2, c3, id, ...] per term ----
const terms = (d) => Object.keys(d.index.postings);
const tuples = (d, term) => { const flat = d.index.postings[term]; const out = []; for (let i = 0; i + 5 <= flat.length; i += 5) out.push(flat.slice(i, i + 5)); return out; };
const put = (d, term, list) => { if (list.length) d.index.postings[term] = list.flat(); else delete d.index.postings[term]; };
const docIndex = (d, p) => d.index.docs.findIndex((doc) => doc.page.path === p);
const recomputeAverages = (d) => { d.index.averages = [0, 1, 2, 3].map((i) => d.index.docs.reduce((a, x) => a + x.lengths[i], 0) / (d.index.docs.length || 1)); };
// Consistent removal of one page: its postings go, later ids shift down, averages are recomputed.
function removeDoc(d, id) {
  for (const term of terms(d)) {
    const kept = tuples(d, term).filter((t) => t[0] !== id).map((t) => [t[0] > id ? t[0] - 1 : t[0], t[1], t[2], t[3], t[4]]);
    put(d, term, kept);
  }
  d.index.docs.splice(id, 1);
  recomputeAverages(d);
  return d;
}
// Reverse the document order and remap ids, keeping every posting list ascending: a valid, reordered cache.
function reverseDocs(d) {
  const n = d.index.docs.length;
  for (const term of terms(d)) {
    const mapped = tuples(d, term).map((t) => [n - 1 - t[0], t[1], t[2], t[3], t[4]]).sort((a, b) => a[0] - b[0]);
    put(d, term, mapped);
  }
  d.index.docs.reverse();
  return d;
}
const firstTerm = (d) => terms(d)[0];

// ---- A. Structural forgeries: must never throw and must equal a fresh install ----
const STRUCTURAL = [
  ['posting ids not ascending (reversed list)', { mutate: (d) => { for (const t of terms(d)) put(d, t, tuples(d, t).reverse()); return d; } }],
  ['posting id negative', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][0] = -1; put(d, t, l); return d; } }],
  ['posting id fractional', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][0] = 0.5; put(d, t, l); return d; } }],
  ['posting id equal to doc count (out of range)', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][0] = d.index.docs.length; put(d, t, l); return d; } }],
  ['posting id as string', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][0] = '0'; put(d, t, l); return d; } }],
  ['posting id NaN (raw token)', { raw: (s) => s.replace('"alph":[0,', '"alph":[NaN,') }],
  ['count negative', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][1] = -1; put(d, t, l); return d; } }],
  ['count fractional', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][2] = 0.5; put(d, t, l); return d; } }],
  ['count string', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][1] = '1'; put(d, t, l); return d; } }],
  ['count null', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][1] = null; put(d, t, l); return d; } }],
  ['count 1e308 (finite, huge)', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][1] = 1e308; put(d, t, l); return d; } }],
  ['count 1e999 (Infinity, raw)', { raw: (s) => s.replace('"alph":[0,1,', '"alph":[0,1e999,') }],
  ['count larger than its field length', { mutate: (d) => { const t = firstTerm(d); const l = tuples(d, t); l[0][1] = 999; put(d, t, l); return d; } }],
  ['posting flat length not a multiple of 5', { mutate: (d) => { d.index.postings[firstTerm(d)].push(0); return d; } }],
  ['posting is an object, not an array', { mutate: (d) => { d.index.postings[firstTerm(d)] = { 0: 1 }; return d; } }],
  ['posting list empty', { mutate: (d) => { d.index.postings.zzz = []; return d; } }],
  ['lengths set to 2^53-1 (averages recomputed; finite, safe integers)', { mutate: (d) => { docOf(d, 'alpha.md').lengths = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, 1]; recomputeAverages(d); return d; } }],
  ['lengths with three entries', { mutate: (d) => { d.index.docs[0].lengths.pop(); return d; } }],
  ['lengths with a string entry', { mutate: (d) => { d.index.docs[0].lengths[0] = 'x'; return d; } }],
  ['lengths with a negative entry', { mutate: (d) => { d.index.docs[0].lengths[2] = -4; return d; } }],
  ['lengths null', { mutate: (d) => { d.index.docs[0].lengths = null; return d; } }],
  ['averages with five entries', { mutate: (d) => { d.index.averages.push(1); return d; } }],
  ['averages made up (wrong value)', { mutate: (d) => { d.index.averages[0] = 123.456; return d; } }],
  ['averages null', { mutate: (d) => { d.index.averages[1] = null; return d; } }],
  ['averages as string', { mutate: (d) => { d.index.averages = 'abcd'; return d; } }],
  ['duplicate page path', { mutate: (d) => { d.index.docs[1].page.path = d.index.docs[0].page.path; return d; } }],
  ['absolute page path', { mutate: (d) => { d.index.docs[0].page.path = '/etc/passwd'; return d; } }],
  ['traversal page path', { mutate: (d) => { d.index.docs[0].page.path = '../escape.md'; return d; } }],
  ['backslash page path', { mutate: (d) => { d.index.docs[0].page.path = 'notes\\deep.md'; return d; } }],
  ['frontmatter is an array', { mutate: (d) => { docOf(d, 'alpha.md').page.frontmatter = []; return d; } }],
  ['frontmatter is null', { mutate: (d) => { docOf(d, 'alpha.md').page.frontmatter = null; return d; } }],
  ['frontmatter is a string', { mutate: (d) => { docOf(d, 'alpha.md').page.frontmatter = 'status: x'; return d; } }],
  ['active page marked superseded in cache', { mutate: (d) => { docOf(d, 'alpha.md').page.frontmatter.status = 'superseded'; return d; } }],
  ['active page given superseded_by in cache', { mutate: (d) => { docOf(d, 'alpha.md').page.frontmatter.superseded_by = 'wiki/x.md'; return d; } }],
  ['headings contains a number', { mutate: (d) => { docOf(d, 'z.md').page.headings = [1]; return d; } }],
  ['headings is a string', { mutate: (d) => { docOf(d, 'z.md').page.headings = 'Sec'; return d; } }],
  ['aliases contains a non-string', { mutate: (d) => { docOf(d, 'z.md').page.aliases = [5]; return d; } }],
  ['keywords contains a non-string', { mutate: (d) => { docOf(d, 'notes/deep.md').page.keywords = [null]; return d; } }],
  ['title is a number', { mutate: (d) => { docOf(d, 'alpha.md').page.title = 5; return d; } }],
  ['title is null', { mutate: (d) => { docOf(d, 'alpha.md').page.title = null; return d; } }],
  ['body is a number (BA-02 F2 regression)', { mutate: (d) => { docOf(d, 'alpha.md').page.body = 42; return d; } }],
  ['body missing', { mutate: (d) => { delete docOf(d, 'alpha.md').page.body; return d; } }],
  ['doc entry is null', { mutate: (d) => { d.index.docs[0] = null; return d; } }],
  ['docs is an object', { mutate: (d) => { d.index.docs = { 0: d.index.docs[0] }; return d; } }],
  ['index version 0', { mutate: (d) => { d.index.version = 0; return d; } }],
  ['postings is an array', { mutate: (d) => { d.index.postings = []; return d; } }],
  ['__proto__ posting key with a valid list (inert)', { mutate: (d) => { Object.defineProperty(d.index.postings, '__proto__', { value: [0, 1, 0, 0, 0], enumerable: true, writable: true, configurable: true }); return d; } }],
  ['__proto__ posting key with an invalid list', { mutate: (d) => { Object.defineProperty(d.index.postings, '__proto__', { value: [0, -1, 0, 0, 0], enumerable: true, writable: true, configurable: true }); return d; } }],
  ['toString posting key with an invalid list', { mutate: (d) => { d.index.postings.toString = [9]; return d; } }],
  ['cache root is an array', { raw: () => '[]' }],
  ['cache root is null', { raw: () => 'null' }],
  ['cache file empty', { raw: () => '' }],
  ['cache binary garbage', { raw: () => '\u0000\u0001\u0002' }],
  ['cache key not a string', { mutate: (d) => ({ ...d, key: 12345 }) }],
  ['docs reversed with ids remapped (valid, reordered)', { mutate: (d) => reverseDocs(d) }],
  ['naive page removal (averages stale)', { mutate: (d) => { d.index.docs.pop(); return d; } }],
  ['oversized cache: 16 MB unused field', { mutate: (d) => ({ ...d, padding: 'a'.repeat(16 * 1024 * 1024) }) }],
];
function docOf(d, p) { return d.index.docs[docIndex(d, p)]; }

for (const [name, spec] of STRUCTURAL) {
  test(`structural forgery: ${name}`, (t) => {
    const f = fixture(t);
    forge(f, spec);
    assert.deepEqual(diffFromFresh(f, name), []);
  });
}

// ---- B. Content-level forgeries (key matches, payload self-consistent, page content is not re-read) ----
// Each is a finding. A passing body means the cache was rejected or the change had no visible effect.
const FINDINGS = [
  ['missing real page (consistent removal of z.md; key matches, z.md on disk)', 'medium',
    { mutate: (d) => removeDoc(d, docIndex(d, 'z.md')) }],
  ['title emptied for alpha.md', 'low', { mutate: (d) => { docOf(d, 'alpha.md').page.title = ''; return d; } }],
  ['lengths inflated for alpha.md (averages recomputed)', 'low', { mutate: (d) => { docOf(d, 'alpha.md').lengths[3] += 7; recomputeAverages(d); return d; } }],
  ['term "constructor" posting attached to alpha.md', 'low', { mutate: (d) => { d.index.postings.constructor = [docIndex(d, 'alpha.md'), 1, 0, 0, 0]; return d; } }],
  ['page paths swapped between alpha.md and delta.md', 'low', { mutate: (d) => { const a = docOf(d, 'alpha.md').page, b = docOf(d, 'delta.md').page; [a.path, b.path] = [b.path, a.path]; return d; } }],
];
for (const [name, severity, spec] of FINDINGS) {
  test(`FINDING (${severity}) content forgery accepted: ${name}`, { todo: `finding: ${severity}; cache content is not validated against page files` }, (t) => {
    const f = fixture(t);
    forge(f, spec);
    assert.deepEqual(diffFromFresh(f, name), [], `results differ from a fresh install for: ${name}`);
  });
}

// ---- C. Cache location and type ----
test('cache path occupied by a directory: no throw, fresh-install results', (t) => {
  const f = fixture(t);
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  fs.rmSync(f.cache); fs.mkdirSync(f.cache);
  assert.deepEqual(diffFromFresh(f, 'directory at cache path'), []);
  assert.ok(fs.statSync(f.cache).isDirectory(), 'the directory at the cache path is left as it was');
});
test('cache path is a symlink to a valid cache outside the vault: fresh-install results', (t) => {
  const f = fixture(t);
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const outside = tmpdir(t), copy = path.join(outside, 'elsewhere.json');
  fs.copyFileSync(f.cache, copy);
  fs.rmSync(f.cache); fs.symlinkSync(copy, f.cache);
  assert.deepEqual(diffFromFresh(f, 'symlinked cache'), []);
});
test('cache path is a symlink into the vault: no throw, vault file untouched', (t) => {
  const f = fixture(t);
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const target = path.join(f.wiki, 'alpha.md');
  const before = fs.readFileSync(target, 'utf8');
  fs.rmSync(f.cache); fs.symlinkSync(target, f.cache);
  assert.deepEqual(diffFromFresh(f, 'cache symlink into vault'), []);
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'vault page must not be overwritten through the cache path');
});
test('cache written by a different vault under the same stateDir is rejected', (t) => {
  const f = fixture(t);
  const other = fixture(t);
  createSearcher({ vaultDir: other.wiki, stateDir: other.stateDir, now: ASOF });
  fs.copyFileSync(other.cache, f.cache);
  assert.deepEqual(diffFromFresh(f, 'foreign cache'), []);
});

// ---- D. Seeded random structural mutations (deterministic) ----
function mulberry32(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Values that are never valid at any structural site of the cache (wrong type or out of range for it).
const BAD = [null, -1, 0.5, '1', 'x', 1e308, true, [], [1, 2], { q: 1 }];
test('300 seeded random structural mutations: no throw, fresh-install results every time', (t) => {
  const f = fixture(t);
  const rng = mulberry32(20260211);
  const pick = (xs) => xs[Math.floor(rng() * xs.length)];
  const failures = [];
  for (let i = 0; i < 300; i++) {
    createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
    const d = JSON.parse(fs.readFileSync(f.cache, 'utf8'));
    const n = d.index.docs.length;
    const site = Math.floor(rng() * 7);
    const bad = pick(BAD);
    let where;
    if (site === 0) { where = 'index.version'; d.index.version = bad; }
    else if (site === 1) { where = 'index.averages'; d.index.averages[Math.floor(rng() * 4)] = bad; }
    else if (site === 2) { const k = Math.floor(rng() * n); where = `docs[${k}].lengths`; d.index.docs[k].lengths[Math.floor(rng() * 4)] = bad; }
    else if (site === 3) {
      const k = Math.floor(rng() * n);
      const field = pick(['title', 'body', 'path', 'headings', 'aliases', 'keywords', 'frontmatter']);
      const fieldBad = {
        title: [null, 1, -1, 0.5, true, [], [1]], body: [null, 1, true, [], {}], path: ['x', '../x.md', '/abs.md', 5, null, ''],
        headings: [5, 'x', null, [1], {}], aliases: [5, 'x', null, [1]], keywords: [5, 'x', null, [1]], frontmatter: [null, 5, 'x', [], [1], true],
      }[field];
      where = `docs[${k}].page.${field}`;
      d.index.docs[k].page[field] = pick(fieldBad);
    }
    else if (site === 4) { const k = Math.floor(rng() * n); where = `docs[${k}]`; d.index.docs[k] = pick([null, 5, 'x', [], {}]); }
    else if (site === 5) { const term = pick(terms(d)); const flat = d.index.postings[term]; const j = Math.floor(rng() * flat.length); where = `postings.${term}[${j}]`; flat[j] = pick([null, -1, 0.5, '1', 'x', 1e308, true, []]); }
    else { const term = pick(terms(d)); where = `postings.${term} (whole)`; d.index.postings[term] = pick([null, 5, 'x', [], [1, 2], {}, [null]]); }
    fs.writeFileSync(f.cache, JSON.stringify(d));
    let differs;
    try { differs = diffFromFresh(f, where); }
    catch (error) { failures.push(`${i}: ${where}: ${error.message}`); continue; }
    if (differs.length) failures.push(`${i}: ${where}: differs on ${differs.join('|')}`);
  }
  assert.deepEqual(failures, []);
});

// ---- E. Snapshot contract: pages and index must describe the same state ----
// PM correction (2026-11-11): superseded pages are in snapshot().pages by contract (cache-integrity.test.mjs) but never in the
// lexical index, so the comparison excludes them. The finding itself (a page added after a cache hit missing from the index) is fixed.
test('snapshot after an outside add (no refresh) pairs pages with an index of the same state', (t) => {
  const f = fixture(t);
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF }); // writes the cache
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF }); // cache hit: pages not loaded
  fs.writeFileSync(path.join(f.wiki, 'added-late.md'), '# Late\nlatemarker only on disk\n');
  const snap = s.snapshot();
  const indexable = (p) => String(p.frontmatter?.status || '').toLowerCase() !== 'superseded' && !Object.hasOwn(p.frontmatter || {}, 'superseded_by');
  const pagePaths = snap.pages.filter(indexable).map((p) => p.path).sort();
  const indexPaths = snap.index.docs.map((d) => d.page.path).sort();
  assert.ok(pagePaths.includes('added-late.md'), 'the page added after the cache hit is in the snapshot');
  assert.deepEqual(pagePaths, indexPaths, 'snapshot pages and lexical index describe different states');
});

// ---- F. Large valid cache (near the largest realistic size) ----
test('large valid cache (1500 pages, ~tens of MB of postings) loads and matches a fresh install', (t) => {
  const f = fixture(t);
  for (const p of fs.readdirSync(f.wiki)) fs.rmSync(path.join(f.wiki, p), { recursive: true, force: true });
  const { queries } = writeSyntheticCorpus(f.wiki, { pages: 1500, seed: 7, wordsPerPage: 600, queryCount: 30 });
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF }); // writes the large cache
  console.log(`large cache: ${(fs.statSync(f.cache).size / 1048576).toFixed(1)} MiB`);
  const idx = buildIndex(loadPages(f.wiki), { now: ASOF });
  const expected = queries.map((q) => canon(search(idx, q, OPTS)));
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF }); // cache hit
  assert.deepEqual(queries.map((q) => canon(s.search(q, OPTS))), expected);
});
