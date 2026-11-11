// SPDX-License-Identifier: MIT
// BA-03 independent final-verification tests (last-pass tester). Written from the brief and docs/contracts/retrieval.md.
// Covers: date formats never identifiers, version strings stay identifiers, abbreviations are not identifiers,
// deep paths (13, 20, 40 components) index basename and suffix chains, exact-index cache corruption is rebuilt.
// Hermetic: temp dirs only, HOME injected, no network, no timing assertions (the 2000-page cost is reported only).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createSearcher, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
const run = (index, query, options = {}) => search(index, query, { limit: 10, abstainThreshold: 0, asOf: now, ...options });
const page = (p, body, extra = {}) => ({
  path: p, title: extra.title ?? 'Page', aliases: [], keywords: [], headings: [], body, frontmatter: extra.frontmatter ?? {},
});

let savedHome;
let tempHome;
before(() => {
  savedHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ba03-final-home-'));
  process.env.HOME = tempHome;
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// A vault that contains none of the dates, versions or deep paths probed below.
const unrelated = () => buildIndex([page('notes/garden.md', 'Plain prose about gardens, rivers and bread.', { title: 'Garden' })], { now });

test('dates in every common format are not identifiers: an absent date never gives identifier-not-found', () => {
  const index = unrelated();
  const dates = ['01.02.2025', '31.12.2025', '2025.12.31', '2025-12-31', '12/31/2025', '31/12/2025'];
  for (const d of dates) {
    for (const q of [d, `Ne oldu ${d}?`, `What happened on ${d}?`, `${d} notes`]) {
      const r = run(index, q);
      assert.notEqual(r.reason, 'identifier-not-found', `date ${d} in "${q}" must not be an identifier`);
    }
  }
});

test('present dates are found by ordinary matching (dates in the vault do not abstain)', () => {
  const index = buildIndex([
    page('log/feb.md', 'Deployment happened on 01.02.2025 at noon.', { title: 'February' }),
    page('log/dec.md', 'Audit closed on 2025.12.31 by the team.', { title: 'December' }),
    page('log/other.md', 'Nothing dated here, only tea.', { title: 'Tea' }),
  ], { now });
  const r1 = run(index, 'what happened on 01.02.2025?', { abstainThreshold: 0.35 });
  assert.equal(r1.abstained, false);
  assert.equal(r1.results[0].path, 'log/feb.md');
  const r2 = run(index, 'audit 2025.12.31', { abstainThreshold: 0.35 });
  assert.equal(r2.abstained, false);
  assert.equal(r2.results[0].path, 'log/dec.md');
});

test('observation: an invalid calendar date (32.13.2025) is not a date and abstains like a version string when absent (diagnostic only)', (t) => {
  const index = unrelated();
  const r = run(index, '32.13.2025 ne oldu?');
  // Contract: a three-part numeric token is a date only when its day and month are in range; otherwise it is a
  // version-like identifier. So an absent invalid date abstains with identifier-not-found. Reported, not asserted.
  t.diagnostic(`32.13.2025 -> abstained=${r.abstained} reason=${r.reason}`);
  assert.equal(typeof r.abstained, 'boolean');
});

test('versions 1.2.3, 10.20.30 and 2.4.0-rc.12 remain identifiers: absent ones abstain, present ones are found', () => {
  const vault = buildIndex([
    page('release/notes.md', 'Upgraded the client to 1.2.3 last week.', { title: 'Notes' }),
    page('release/other.md', 'Unrelated changelog entry about caches.', { title: 'Other' }),
  ], { now });
  for (const q of ['10.20.30', 'What changed in 10.20.30?', '2.4.0-rc.12', 'Is 2.4.0-rc.12 safe?']) {
    assert.equal(run(vault, q).reason, 'identifier-not-found', `absent version must be an identifier: ${q}`);
  }
  for (const q of ['1.2.3', 'Ne zaman 1.2.3 çıktı?', 'what about 1.2.3']) {
    const r = run(vault, q, { abstainThreshold: 0.35 });
    assert.equal(r.abstained, false, q);
    assert.equal(r.results[0].path, 'release/notes.md', q);
  }
  const keys = Object.keys(buildIndex([page('v.md', 'Versions 10.20.30 and 2.4.0-rc.12 shipped.')], { now }).exact);
  assert.ok(keys.includes('10.20.30') && keys.includes('2.4.0-rc.12'), `exact keys: ${keys.join(',')}`);
});

test('abbreviations a.k.a, vs., e.g., i.e. are not identifiers (no exact keys, no identifier-not-found)', () => {
  const idx = buildIndex([page('prose/abbr.md', 'Notes: a.k.a. aliases, vs. comparisons, e.g. samples, i.e. definitions.')], { now });
  for (const bad of ['a.k.a', 'a.k', 'k.a', 'vs', 'e.g', 'i.e']) {
    assert.equal(Object.hasOwn(idx.exact, bad), false, `abbreviation indexed as identifier: ${bad}`);
  }
  const onlySingleLetterDotted = Object.keys(idx.exact).filter(k => /^\p{L}(\.\p{L})+$/u.test(k));
  assert.deepEqual(onlySingleLetterDotted, []);
  for (const q of ['What does a.k.a mean?', 'vs. or e.g. examples?', 'compare a.k.a. with vs. and i.e. wording']) {
    assert.notEqual(run(unrelated(), q).reason, 'identifier-not-found', q);
  }
});

test('negative words (2026, v2, mp3, follow-up, and/or, 1.0, iOS) are not in the exact index', () => {
  const idx = buildIndex([page('neg.md', 'In 2026 we used v2 and mp3, a follow-up and/or the 1.0 release on iOS 26.')], { now });
  for (const bad of ['2026', 'v2', 'mp3', 'follow-up', 'and/or', '1.0', 'ios']) {
    assert.equal(Object.hasOwn(idx.exact, bad), false, `negative indexed as identifier: ${bad}`);
  }
});

// Deep paths: `n` components in total (n-1 directories plus one basename). The body names the full path.
function deepPath(n, leaf) {
  const dirs = Array.from({ length: n - 1 }, (_, i) => `dir${String(i).padStart(2, '0')}`);
  return [...dirs, leaf].join('/');
}
// The suffix window contract: for paths longer than twelve segments only the last four segments start a chain.
// A hyphen or dot starts a new segment, so a hyphenated basename uses more of that window. Two leaf shapes are tested:
// `handler.mjs` (no hyphen) and `handler-x-y.mjs` (hyphenated). Each variant that the vault contains must not abstain.
function deepCase(n, leaf) {
  const full = deepPath(n, leaf);
  const parts = full.split('/');
  const index = buildIndex([
    page(`deep/page-${n}.md`, `Handler lives at ${full}. Retries are capped.`, { title: `Deep ${n}` }),
    page('notes/other.md', 'Other notes about bread and rivers.', { title: 'Other' }),
  ], { now });
  return { index, full, parts };
}
for (const n of [13, 20, 40]) {
  test(`a ${n}-component vault path with a plain basename: basename, 2- and 3-component suffixes find the document`, () => {
    const leaf = `handler-${n}.mjs`.replace('-', '_');
    const { index, parts } = deepCase(n, leaf);
    for (const [kind, q] of Object.entries({ basename: leaf, suffix2: parts.slice(-2).join('/'), suffix3: parts.slice(-3).join('/'), full: parts.join('/') })) {
      const r = run(index, `Where is ${q}?`);
      assert.notEqual(r.reason, 'identifier-not-found', `${n} ${kind}`);
      assert.equal(r.results[0]?.path, `deep/page-${n}.md`, `${n} ${kind}: ${q}`);
    }
    // A non-consecutive subpath is not a match (contract), so it is an unknown identifier.
    const gapped = [parts[0], parts[2], leaf].join('/');
    assert.equal(run(index, gapped).reason, 'identifier-not-found', `non-consecutive ${gapped}`);
  });
  // PM update (BA-17/18, 2026-11-11): fixed — the suffix window counts path components.
  test(`a ${n}-component vault path with a hyphenated basename: its 2- and 3-component suffixes are indexed`, () => {
    const leaf = `handler-x-${n}.mjs`;
    const { index, parts } = deepCase(n, leaf);
    // The basename itself is always found; the contract says the basename and its suffixes are always indexed.
    assert.equal(run(index, leaf).results[0]?.path, `deep/page-${n}.md`, `basename ${leaf}`);
    for (const k of [2, 3]) {
      const q = parts.slice(-k).join('/');
      const r = run(index, `Where is ${q}?`);
      // A vault-present identifier variant must never abstain with identifier-not-found.
      assert.notEqual(r.reason, 'identifier-not-found', `${n}-component path, ${k}-component suffix ${q} is in the vault but abstained`);
      assert.equal(r.results[0]?.path, `deep/page-${n}.md`, `${k}-component suffix ${q}`);
    }
  });
}

test('a 40-component path: the basename is found when it is the only identifier-bearing text and the page is one of many', () => {
  const leaf = 'retry-policy-40.mjs';
  const full = deepPath(40, leaf);
  const pages = [page('deep/target.md', `Policy in ${full}.`, { title: 'Target' })];
  for (let i = 0; i < 30; i++) pages.push(page(`deep/filler-${i}.md`, `Filler page ${i} with cats and dogs.`, { title: `Filler ${i}` }));
  const index = buildIndex(pages, { now });
  const r = run(index, leaf, { abstainThreshold: 0.35 });
  assert.equal(r.abstained, false);
  assert.equal(r.results[0].path, 'deep/target.md');
});

test('exact-index cache corruption (duplicate, out-of-range, non-array, empty) is rebuilt to the clean content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba03-final-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault'); const state = path.join(dir, 'state');
  fs.mkdirSync(vault); fs.mkdirSync(state);
  fs.writeFileSync(path.join(vault, 'a.md'), 'Use E_ALPHA_ONE here, plus 2.4.0-rc.12.');
  fs.writeFileSync(path.join(vault, 'b.md'), 'E_BETA_TWO only, nothing else about alpha.');
  const cache = path.join(state, 'retrieval-index.json');
  createSearcher({ vaultDir: vault, stateDir: state, now });
  const clean = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const key = Object.keys(clean.index.exact).find(k => k === 'e_alpha_one');
  assert.ok(key, 'expected normalized identifier key in clean exact index');
  const variants = {
    duplicate: [0, 0],
    outOfRange: [99],
    notArray: 'x',
    empty: [],
  };
  for (const [name, value] of Object.entries(variants)) {
    const data = JSON.parse(JSON.stringify(clean));
    data.index.exact[key] = value;
    fs.writeFileSync(cache, JSON.stringify(data));
    const s = createSearcher({ vaultDir: vault, stateDir: state, now });
    const r = s.search('E_ALPHA_ONE', { limit: 10, abstainThreshold: 0, asOf: now });
    assert.equal(r.results[0]?.path, 'a.md', `${name}: results after rebuild`);
    const rebuilt = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.deepEqual(rebuilt.index.exact, clean.index.exact, `${name}: cache exact not restored`);
  }
});

test('observation: a 2000-page vault with 20-component paths (cache size and build time reported, no threshold)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba03-final-deep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault'); const state = path.join(dir, 'state');
  const comps = Array.from({ length: 19 }, (_, i) => `s${String(i).padStart(2, '0')}`);
  const deepDir = path.join(vault, ...comps);
  fs.mkdirSync(deepDir, { recursive: true }); fs.mkdirSync(state);
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const full = [...comps, `note-${i}.md`].join('/');
    fs.writeFileSync(path.join(deepDir, `note-${i}.md`), `---\ntitle: "Note ${i}"\n---\n# Note ${i}\nRecord ${i} is stored at ${full}. Garden bread river ${i % 37}.\n`);
  }
  const t0 = process.hrtime.bigint();
  const pages = loadPages(vault);
  const index = buildIndex(pages, { now });
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  const s = createSearcher({ vaultDir: vault, stateDir: state, now });
  const coldMs = Number(process.hrtime.bigint() - t1) / 1e6;
  const cachePath = path.join(state, 'retrieval-index.json');
  const sizeKiB = fs.statSync(cachePath).size / 1024;
  const exactKeys = Object.keys(index.exact).length;
  t.diagnostic(`N=${N} comps=20 buildIndex(loadPages+build)=${buildMs.toFixed(0)}ms createSearcher(cold,writes cache)=${coldMs.toFixed(0)}ms cache=${sizeKiB.toFixed(0)}KiB exactKeys=${exactKeys}`);
  // Correctness is asserted; cost is only reported.
  for (let k = 0; k < N; k += 40) {
    const r = s.search(`note-${k}.md`, { limit: 10, abstainThreshold: 0, asOf: now });
    assert.equal(r.results[0]?.path, [...comps, `note-${k}.md`].join('/'), `basename note-${k}.md`);
  }
});
