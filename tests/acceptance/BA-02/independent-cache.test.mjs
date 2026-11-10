// SPDX-License-Identifier: MIT
// BA-02 independent final verification (not written by the implementer).
// (a) page-set mismatches between the cache and the vault force a rebuild; results equal a fresh install and the cache is rewritten.
// (b) snapshot() pages + lexical index, fed to searchHybrid, equal a fresh buildIndex(loadPages()) after outside changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearcher, buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';
import { searchHybrid } from '../../../modules/semantic/src/hybrid.mjs';

const ASOF = new Date('2026-02-01T00:00:00Z');
const OPTS = { limit: 5, abstainThreshold: 0, asOf: ASOF };
const QUERIES = ['alpha', 'bravo charlie', 'zephyr', 'quokka', 'legacy', 'delta echo', 'title', 'notes', 'alpha quokka', 'roadmap', 'added', 'latemarker'];
const canon = (x) => JSON.stringify(x);

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-ind-'));
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
const freshPaths = (wiki) => loadPages(wiki).map((p) => p.path).sort();
// Fresh-install reference over the vault, no cache involved.
function reference(wiki) {
  const index = buildIndex(loadPages(wiki), { now: ASOF });
  return QUERIES.map((q) => canon(search(index, q, OPTS)));
}
function resultsOf(searcher) { return QUERIES.map((q) => canon(searcher.search(q, OPTS))); }
// The on-disk cache must record exactly the walked page set, as indexed (docs) or skipped, with no duplicates.
function assertCachePartition(f) {
  const d = JSON.parse(fs.readFileSync(f.cache, 'utf8'));
  const indexed = d.index.docs.map((doc) => doc.page.path);
  assert.equal(new Set(indexed).size, indexed.length, 'indexed paths are unique');
  assert.equal(new Set(d.skipped).size, d.skipped.length, 'skipped paths are unique');
  assert.equal(indexed.some((p) => d.skipped.includes(p)), false, 'no page is both indexed and skipped');
  assert.deepEqual([...indexed, ...d.skipped].sort(), freshPaths(f.wiki), 'cache partition equals the walked page set');
}
// Build a valid cache, apply a forged mutation to its parsed form, and keep the key.
function forgeCache(f, mutate) {
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const d = JSON.parse(fs.readFileSync(f.cache, 'utf8'));
  mutate(d);
  fs.writeFileSync(f.cache, JSON.stringify(d));
}
const docEntry = (d, p) => d.index.docs.find((doc) => doc.page.path === p);

// ---- (a) page-set mismatch forgeries: rebuild, fresh-install results, rewritten consistent cache ----
const PAGE_SET_CASES = [
  ['missing page: z.md dropped from docs and not listed as skipped', (d) => { d.index.docs.splice(d.index.docs.findIndex((x) => x.page.path === 'z.md'), 1); }],
  ['extra page: ghost.md (absent on disk) added to docs', (d) => {
    d.index.docs.push({ page: { path: 'ghost.md', title: 'Ghost', aliases: [], keywords: [], headings: [], body: 'ghost text', frontmatter: {} }, lengths: [1, 0, 0, 2] });
  }],
  ['superseded page absent from skipped (legacy.md unlisted)', (d) => { d.skipped = d.skipped.filter((p) => p !== 'legacy.md'); }],
  ['duplicate path in skipped (legacy.md twice)', (d) => { d.skipped.push('legacy.md'); }],
  ['skipped lists an indexed page (alpha.md)', (d) => { d.skipped.push('alpha.md'); }],
  ['skipped lists a page absent on disk (ghost.md)', (d) => { d.skipped.push('ghost.md'); }],
  ['skipped lists an absolute path', (d) => { d.skipped.push('/etc/passwd'); }],
  ['skipped lists a traversal path', (d) => { d.skipped.push('../outside.md'); }],
  ['superseded page placed into docs', (d) => {
    d.index.docs.push({ page: { path: 'legacy.md', title: 'Old', aliases: [], keywords: [], headings: ['Old'], body: 'legacy zephyr\n', frontmatter: { title: 'Old', status: 'superseded', superseded_by: 'wiki/alpha.md' } }, lengths: [1, 0, 0, 2] });
    d.skipped = d.skipped.filter((p) => p !== 'legacy.md');
  }],
  ['skipped is an object, not an array', (d) => { d.skipped = { 0: 'legacy.md' }; }],
  ['skipped missing entirely', (d) => { delete d.skipped; }],
];
for (const [name, mutate] of PAGE_SET_CASES) {
  test(`(a) page-set mismatch rebuilds: ${name}`, (t) => {
    const f = fixture(t);
    forgeCache(f, mutate);
    const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
    s.snapshot();
    assert.deepEqual(resultsOf(s), reference(f.wiki), 'results equal a fresh install');
    assertCachePartition(f);
  });
}

test('(a) a page added on disk after a cache hit is found by search after refreshIfChanged', (t) => {
  const f = fixture(t);
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  fs.writeFileSync(path.join(f.wiki, 'added.md'), '# Added\nlatemarker here\n');
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(resultsOf(s), reference(f.wiki));
  assert.equal(s.search('latemarker', OPTS).results[0].path, 'added.md');
  assertCachePartition(f);
});

test('(a) symlinked directory inside the wiki is never indexed or snapshotted', (t) => {
  const f = fixture(t);
  const outside = tmpdir(t);
  fs.writeFileSync(path.join(outside, 'leak.md'), '# Leak\nlatemarker outside\n');
  fs.symlinkSync(outside, path.join(f.wiki, 'linked'));
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const snap = s.snapshot();
  assert.equal(snap.pages.some((p) => p.path.startsWith('linked/')), false, 'snapshot pages exclude the symlinked directory');
  assert.deepEqual(resultsOf(s), reference(f.wiki));
  assert.equal(s.search('latemarker', OPTS).results.length, 0);
  assertCachePartition(f);
});

test('(a) truncated cache file and cache with an out-of-range posting id: rebuild, fresh results', (t) => {
  const f = fixture(t);
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const text = fs.readFileSync(f.cache, 'utf8');
  fs.writeFileSync(f.cache, text.slice(0, Math.floor(text.length / 2)));
  const s1 = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  assert.deepEqual(resultsOf(s1), reference(f.wiki));
  assertCachePartition(f);
  forgeCache(f, (d) => { const flat = d.index.postings[Object.keys(d.index.postings)[0]]; flat[0] = 10 ** 9; });
  const s2 = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  assert.deepEqual(resultsOf(s2), reference(f.wiki));
  assertCachePartition(f);
});

// ---- (b) snapshot() + searchHybrid equals a fresh build after outside changes ----
const ENTRY_QUERIES = ['alpha', 'zephyr', 'legacy', 'added', 'latemarker', 'delta echo', 'title', 'roadmap'];
function vectorFor(i) { const a = (i * 0.7) % 3.1; return [Math.cos(a), Math.sin(a)]; }
function hybridArgs(pages, paths, query) {
  const entries = paths.map((p, i) => ({ path: p, vector: vectorFor(i), text: p, headingPath: '' }));
  return { query, pages, entries, provider: { fingerprint: 'ba02-ind', embedQuery: async () => [1, 0] }, asOf: ASOF, limit: 5 };
}
const norm = (r) => canon({ results: [...r], fallbackReason: r.fallbackReason ?? null, abstained: r.abstained ?? null });
async function assertHybridMatchesFresh(f, snap, label) {
  const pages = loadPages(f.wiki);
  const paths = pages.map((p) => p.path);
  const fresh = buildIndex(pages, { now: ASOF });
  for (const q of ENTRY_QUERIES) {
    const got = norm(await searchHybrid({ ...hybridArgs(snap.pages, paths, q), lexicalIndex: snap.index }));
    const exp = norm(await searchHybrid({ ...hybridArgs(pages, paths, q), lexicalIndex: fresh }));
    const exp2 = norm(await searchHybrid({ ...hybridArgs(pages, paths, q) }));
    assert.equal(got, exp, `${label}: snapshot+lexicalIndex vs fresh lexicalIndex for "${q}"`);
    assert.equal(exp, exp2, `${label}: fresh lexicalIndex vs no lexicalIndex for "${q}"`);
  }
}
test('(b) snapshot after cache hit, outside add, delete, supersede and rename (no refresh) equals fresh hybrid', async (t) => {
  const f = fixture(t);
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  fs.writeFileSync(path.join(f.wiki, 'added.md'), '---\ntitle: Added\n---\n# Added\nlatemarker zephyr\n');
  fs.rmSync(path.join(f.wiki, 'delta.md'));
  fs.writeFileSync(path.join(f.wiki, 'alpha.md'), '---\ntitle: Alpha\nstatus: superseded\nsuperseded_by: wiki/added.md\n---\n# Alpha\nalpha bravo charlie notes\n');
  fs.renameSync(path.join(f.wiki, 'z.md'), path.join(f.wiki, 'zz.md'));
  await assertHybridMatchesFresh(f, s.snapshot(), 'no-refresh');
});
test('(b) snapshot before and after refreshIfChanged across add, delete, supersede equals fresh hybrid', async (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  await assertHybridMatchesFresh(f, s.snapshot(), 'initial');
  fs.writeFileSync(path.join(f.wiki, 'added.md'), '# Added\nlatemarker zephyr\n');
  fs.unlinkSync(path.join(f.wiki, 'notes', 'deep.md'));
  fs.writeFileSync(path.join(f.wiki, 'delta.md'), '---\nstatus: superseded\nsuperseded_by: wiki/added.md\n---\n# Delta\ndelta echo foxtrot\n');
  assert.equal(s.refreshIfChanged(), true);
  await assertHybridMatchesFresh(f, s.snapshot(), 'after-refresh');
  assertCachePartition(f);
});
test('(b) repeated outside edits, refreshIfChanged then snapshot each round (MCP order), equal fresh hybrid', async (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  for (let round = 0; round < 4; round++) {
    const file = path.join(f.wiki, `round-${round}.md`);
    if (round % 2 === 0) fs.writeFileSync(file, `# Round ${round}\nlatemarker round ${round}\n`);
    else fs.rmSync(path.join(f.wiki, `round-${round - 1}.md`), { force: true });
    s.refreshIfChanged();
    await assertHybridMatchesFresh(f, s.snapshot(), `round ${round}`);
  }
});
test('(b) snapshot without a refresh after an outside change: pages and index agree with each other (stale, not fresh)', (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  s.snapshot();
  fs.writeFileSync(path.join(f.wiki, 'added.md'), '# Added\nlatemarker only\n');
  const snap = s.snapshot();
  const indexable = (p) => String(p.frontmatter?.status || '').toLowerCase() !== 'superseded' && !Object.hasOwn(p.frontmatter || {}, 'superseded_by');
  assert.deepEqual(snap.pages.filter(indexable).map((p) => p.path).sort(), snap.index.docs.map((d) => d.page.path).sort(), 'pages and index describe the same state');
  assert.equal(s.refreshIfChanged(), true, 'the change is only picked up by refreshIfChanged');
  assert.equal(s.search('latemarker', OPTS).results[0].path, 'added.md');
});
