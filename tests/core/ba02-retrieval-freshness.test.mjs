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
