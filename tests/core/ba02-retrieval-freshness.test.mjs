// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createSearcher, loadPages, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2025-01-01T00:00:00Z');
const plain = (value) => JSON.parse(JSON.stringify(value));
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function markdownNames(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...markdownNames(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(`${prefix}${entry.name}`);
  }
  return out.sort();
}
function pageText(r, seq) {
  const pick = () => WORDS[Math.floor(r() * WORDS.length)];
  const frontmatter = r() < 0.2 ? '---\nstatus: superseded\n---\n' : r() < 0.3 ? `---\ntitle: T${Math.floor(r() * 9)}\nstale_after: P1D\ngenerated: 2020-01-01\n---\n` : '';
  // Padding grows with every write, so each rewrite changes the file size and the fingerprint never depends on timestamp resolution.
  return `${frontmatter}# ${pick()} heading\n${pick()} ${pick()} body ${Math.floor(r() * 1000)} ${'x'.repeat(seq)}\n`;
}
function applyRandomOperation(r, vault, seq) {
  const files = markdownNames(vault);
  const op = r();
  const choose = () => files[Math.floor(r() * files.length)];
  if (op < 0.35 || files.length === 0) {
    const name = `${r() < 0.3 ? 'sub/' : ''}n${Math.floor(r() * 12)}.md`;
    fs.mkdirSync(path.dirname(path.join(vault, name)), { recursive: true });
    fs.writeFileSync(path.join(vault, name), pageText(r, seq));
  } else if (op < 0.65) {
    fs.writeFileSync(path.join(vault, choose()), pageText(r, seq));
  } else if (op < 0.82) {
    fs.rmSync(path.join(vault, choose()));
  } else {
    const from = choose(), to = `${r() < 0.5 ? 'sub/' : ''}r${Math.floor(r() * 12)}.md`;
    if (!fs.existsSync(path.join(vault, to))) {
      fs.mkdirSync(path.dirname(path.join(vault, to)), { recursive: true });
      fs.renameSync(path.join(vault, from), path.join(vault, to));
    }
  }
}
function assertMatchesFreshBuild(searcher, vault, label) {
  const expected = buildIndex(loadPages(vault), { now });
  const snap = searcher.snapshot();
  assert.deepEqual(plain(snap.index), plain(expected), `${label}: index`);
  assert.deepEqual(plain(snap.pages), plain(loadPages(vault)), `${label}: pages`);
  for (const word of [...WORDS, 'heading', 'body', 'missing']) {
    assert.deepEqual(plain(searcher.search(word, { limit: 20 })), plain(search(expected, word, { limit: 20 })), `${label}: search ${word}`);
  }
}

test('incremental searcher matches a fresh build after 60 random external edits', async (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  const r = rng(7);
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(vault, `seed${i}.md`), pageText(r, i));
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  assertMatchesFreshBuild(searcher, vault, 'start');
  for (let step = 1; step <= 60; step++) {
    applyRandomOperation(r, vault, step);
    const changed = searcher.refreshIfChanged();
    assert.equal(typeof changed, 'boolean');
    assertMatchesFreshBuild(searcher, vault, `step ${step}`);
    if (step % 15 === 0) {
      // A cold searcher started from the persisted cache must agree too.
      assertMatchesFreshBuild(createSearcher({ vaultDir: vault, stateDir: state, now }), vault, `cold ${step}`);
    }
  }
});

test('refreshIfChanged reports changes only and reads no page contents when unchanged', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\nalpha body');
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.equal(searcher.refreshIfChanged(), false);
  const reads = t.mock.method(fs, 'readFileSync');
  assert.equal(searcher.refreshIfChanged(), false);
  assert.equal(searcher.refreshIfChanged(), false);
  assert.equal(reads.mock.callCount(), 0);
  reads.mock.restore();
  fs.writeFileSync(path.join(vault, 'b.md'), '# Bravo\nbravo body');
  assert.equal(searcher.refreshIfChanged(), true);
  assert.equal(searcher.search('bravo').results[0].path, 'b.md');
  assert.equal(searcher.refreshIfChanged(), false);
});

test('an external deletion and rename are visible after refreshIfChanged', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'old.md'), '# Quokka\nquokka body');
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.equal(searcher.search('quokka').results.length, 1);
  fs.renameSync(path.join(vault, 'old.md'), path.join(vault, 'new.md'));
  assert.equal(searcher.refreshIfChanged(), true);
  assert.deepEqual(searcher.search('quokka').results.map((r) => r.path), ['new.md']);
  fs.rmSync(path.join(vault, 'new.md'));
  assert.equal(searcher.refreshIfChanged(), true);
  assert.equal(searcher.search('quokka').results.length, 0);
});

test('invalid, foreign-schema or forged caches are rebuilt safely and never written into the vault', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\nalpha body');
  const cache = path.join(state, 'retrieval-index.json');
  const fresh = plain(buildIndex(loadPages(vault), { now }));
  const forged = [
    '{not json',
    JSON.stringify({ key: 'wrong', index: fresh }),
    JSON.stringify({ key: 'x', index: { ...fresh, version: 2 } }),
    JSON.stringify({ key: 'x', index: { ...fresh, postings: { alpha: [[99, [1, 1, 1, 1]]] } } }),
  ];
  for (const text of forged) {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(cache, text);
    const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
    assert.deepEqual(plain(searcher.snapshot().index), fresh);
    assert.equal(searcher.search('alpha').results[0].path, 'a.md');
  }
  assert.deepEqual(markdownNames(vault), ['a.md']);
  assert.deepEqual(fs.readdirSync(vault), ['a.md']);
});

test('symbolic links to pages or directories are neither indexed nor tracked', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state'), outside = path.join(dir, 'outside');
  fs.mkdirSync(vault); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Outside\nzanzibar secret');
  fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\nalpha body');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(vault, 'link.md'));
  fs.symlinkSync(outside, path.join(vault, 'linkdir'));
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.deepEqual(searcher.snapshot().pages.map((p) => p.path), ['a.md']);
  assert.equal(searcher.search('zanzibar').results.length, 0);
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Outside\nzanzibar secret changed and longer');
  assert.equal(searcher.refreshIfChanged(), false);
});

test('the persisted cache lives only under the state directory', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\nalpha body');
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  fs.writeFileSync(path.join(vault, 'b.md'), '# Bravo\nbravo body with more text');
  searcher.refreshIfChanged();
  assert.ok(fs.existsSync(path.join(state, 'retrieval-index.json')));
  assert.deepEqual(fs.readdirSync(vault).sort(), ['a.md', 'b.md']);
});

test('flat on-disk postings with out-of-range ids, bad widths or non-numeric counts are rebuilt', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'a.md'), '# Alpha\nalpha body');
  const cache = path.join(state, 'retrieval-index.json');
  createSearcher({ vaultDir: vault, stateDir: state, now });
  const good = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const fresh = plain(buildIndex(loadPages(vault), { now }));
  const term = Object.keys(good.index.postings)[0];
  const variants = [
    { ...good.index, postings: { ...good.index.postings, [term]: [99, 1, 1, 1, 1] } },
    { ...good.index, postings: { ...good.index.postings, [term]: [0, 1, 1, 1] } },
    { ...good.index, postings: { ...good.index.postings, [term]: [0, 'x', 1, 1, 1] } },
    { ...good.index, postings: { ...good.index.postings, [term]: [0.5, 1, 1, 1, 1] } },
  ];
  for (const index of variants) {
    fs.writeFileSync(cache, JSON.stringify({ key: good.key, index }));
    const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
    assert.deepEqual(plain(searcher.snapshot().index), fresh);
  }
});

test('structurally invalid but key-matching caches are rebuilt (fix1 regression table)', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'a.md'), '---\ntitle: Alpha\n---\n# Alpha\nalpha bravo alpha');
  fs.writeFileSync(path.join(vault, 'b.md'), '# Bravo\nbravo charlie');
  const cache = path.join(state, 'retrieval-index.json');
  createSearcher({ vaultDir: vault, stateDir: state, now });
  const good = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const fresh = plain(buildIndex(loadPages(vault), { now }));
  const termOf = (word) => Object.keys(good.index.postings).find((k) => k === word) ?? Object.keys(good.index.postings)[0];
  const cases = {
    'ghost page not on disk': (d) => { d.index.docs.push({ page: { path: 'ghost.md', title: 'Ghost', aliases: [], keywords: [], headings: [], body: 'ghost', frontmatter: {} }, lengths: [0, 0, 0, 1] }); },
    'duplicate page path': (d) => { d.index.docs.push(structuredClone(d.index.docs[0])); },
    'non-increasing posting ids': (d) => { const k = termOf(); const a = d.index.postings[k]; if (a.length >= 10) { const x = a.slice(0, 5); d.index.postings[k] = [...a.slice(5, 10), ...x]; } else d.index.postings[k] = [...a, ...a]; },
    'repeated posting id': (d) => { const k = termOf(); d.index.postings[k] = [...d.index.postings[k], ...d.index.postings[k].slice(0, 5)]; },
    'count larger than field length': (d) => { const k = termOf(); d.index.postings[k][1] = d.index.docs[d.index.postings[k][0]].lengths[0] + 1; },
    'count 1e308': (d) => { d.index.postings[termOf()][1] = 1e308; },
    'negative count': (d) => { d.index.postings[termOf()][2] = -1; },
    'negative field length': (d) => { d.index.docs[0].lengths[1] = -3; },
    'average inconsistent with lengths': (d) => { d.index.averages[0] = d.index.averages[0] + 1; },
    'body not a string': (d) => { d.index.docs[0].page.body = 42; },
    'headings not a string array': (d) => { d.index.docs[0].page.headings = [1]; },
    'frontmatter is an array': (d) => { d.index.docs[0].page.frontmatter = []; },
    'superseded page inside the cache': (d) => { d.index.docs[0].page.frontmatter = { status: 'superseded' }; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const data = structuredClone(good);
    mutate(data);
    fs.writeFileSync(cache, JSON.stringify(data));
    const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
    assert.deepEqual(plain(searcher.snapshot().index), fresh, name);
    assert.deepEqual(plain(searcher.search('alpha bravo', { abstainThreshold: 0 })), plain(search(fresh, 'alpha bravo', { abstainThreshold: 0 })), `${name}: results`);
  }
});
