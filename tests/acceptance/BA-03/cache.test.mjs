// SPDX-License-Identifier: MIT
// BA-03 independent cache tests: schema-tag change rebuilds the cache once; malformed or fake `exact` is rebuilt.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
let savedHome;
let tempHome;
before(() => {
  savedHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ba03-cache-home-'));
  process.env.HOME = tempHome;
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function workspace(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba03-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault');
  const state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.mkdirSync(state);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(vault, name), body);
  return { vault, state, cache: path.join(state, 'retrieval-index.json') };
}

// Mirrors the documented fingerprint: sha256 over the schema tag, then `rel\0size\0mtime\0ctime\0ino\n` per file.
// Used only to construct a cache that carries the previous schema tag (retrieval-stat-v4).
function fingerprintKey(vault, schema) {
  const hash = createHash('sha256').update(schema);
  for (const name of fs.readdirSync(vault).sort()) {
    const st = fs.lstatSync(path.join(vault, name));
    hash.update(`${name}\0${[st.size, st.mtimeMs, st.ctimeMs, st.ino].join('\0')}\n`);
  }
  return hash.digest('hex');
}

const TWO_PAGES = {
  'a.md': '---\ntitle: Alpha\n---\n# Alpha\nE_WIDGET_TIMEOUT occurs here.\n',
  'b.md': '# Beta\nE_WIDGET_TIMEOUT is also mentioned here.\n',
};

function freshSearch(vault, state) {
  return createSearcher({ vaultDir: vault, stateDir: state, now }).search('E_WIDGET_TIMEOUT', { limit: 10, abstainThreshold: 0 });
}

test('a cache written with the previous schema tag is rebuilt, and the rebuilt cache equals a clean one', (t) => {
  const w = workspace(t, TWO_PAGES);
  createSearcher({ vaultDir: w.vault, stateDir: w.state, now }).search('E_WIDGET_TIMEOUT');
  const clean = fs.readFileSync(w.cache, 'utf8');
  const cleanData = JSON.parse(clean);
  const oldKey = fingerprintKey(w.vault, 'retrieval-stat-v4');
  assert.notEqual(oldKey, cleanData.key, 'test setup: old and new keys must differ');

  // Previous-schema cache whose content is deliberately wrong (title changed), so a silent reuse would show.
  const stale = JSON.parse(clean);
  stale.key = oldKey;
  stale.index.docs[0].page.title = 'STALE-V4-TITLE';
  fs.writeFileSync(w.cache, JSON.stringify(stale));

  const searcher = createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  const r = searcher.search('E_WIDGET_TIMEOUT', { limit: 10, abstainThreshold: 0 });
  assert.notEqual(r.results[0].title, 'STALE-V4-TITLE', 'old-schema cache must not be reused');
  assert.equal(fs.readFileSync(w.cache, 'utf8'), clean, 'rebuilt cache must equal the clean cache');
});

test('after the one rebuild a current cache is reused on the next start', (t) => {
  const w = workspace(t, TWO_PAGES);
  createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  const data = JSON.parse(fs.readFileSync(w.cache, 'utf8'));
  data.index.docs[0].page.title = 'REUSED-FROM-CACHE';
  fs.writeFileSync(w.cache, JSON.stringify(data));
  const r = createSearcher({ vaultDir: w.vault, stateDir: w.state, now }).search('E_WIDGET_TIMEOUT', { limit: 10, abstainThreshold: 0 });
  assert.equal(r.results[0].title, 'REUSED-FROM-CACHE', 'a current-schema cache with a matching key should be used, not rebuilt');
});

test('a cache whose exact identifier postings are malformed is rebuilt, and results match a fresh build', (t) => {
  // Two documents share E_WIDGET_TIMEOUT, so the valid postings are [0, 1].
  const variants = {
    'exact is null': (e) => { e.index.exact = null; },
    'exact is an array': (e) => { e.index.exact = []; },
    'exact is a string': (e) => { e.index.exact = 'x'; },
    'exact is missing': (e) => { delete e.index.exact; },
    'posting is not an array': (e) => { e.index.exact.e_widget_timeout = 'abc'; },
    'posting list is empty': (e) => { e.index.exact.e_widget_timeout = []; },
    'id out of range (high)': (e) => { e.index.exact.e_widget_timeout = [0, 2]; },
    'id out of range (negative)': (e) => { e.index.exact.e_widget_timeout = [-1, 0]; },
    'duplicate id': (e) => { e.index.exact.e_widget_timeout = [0, 0]; },
    'unsorted ids': (e) => { e.index.exact.e_widget_timeout = [1, 0]; },
    'non-integer id': (e) => { e.index.exact.e_widget_timeout = [0, 0.5]; },
    'string id': (e) => { e.index.exact.e_widget_timeout = ['0', '1']; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const w = workspace(t, TWO_PAGES);
    const fresh = freshSearch(w.vault, w.state);
    const clean = fs.readFileSync(w.cache, 'utf8');
    const data = JSON.parse(clean);
    assert.deepEqual(data.index.exact.e_widget_timeout, [0, 1], 'test setup');
    mutate(data);
    fs.writeFileSync(w.cache, JSON.stringify(data));
    const after = freshSearch(w.vault, w.state);
    assert.deepEqual(after, fresh, `${name}: results after rebuild`);
    assert.equal(fs.readFileSync(w.cache, 'utf8'), clean, `${name}: cache must be rebuilt to the clean form`);
  }
});

test('valid exact postings with a matching key are accepted without a rebuild (control case)', (t) => {
  const w = workspace(t, TWO_PAGES);
  createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  const data = JSON.parse(fs.readFileSync(w.cache, 'utf8'));
  data.index.docs[1].page.title = 'CONTROL';
  fs.writeFileSync(w.cache, JSON.stringify(data));
  const r = createSearcher({ vaultDir: w.vault, stateDir: w.state, now }).search('E_WIDGET_TIMEOUT', { limit: 10, abstainThreshold: 0 });
  assert.ok(r.results.some(x => x.title === 'CONTROL'), 'a structurally valid cache is reused');
});

test('observation: an in-range but wrong exact posting is accepted (diagnostic only, documented threat model)', (t) => {
  const w = workspace(t, TWO_PAGES);
  createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  const data = JSON.parse(fs.readFileSync(w.cache, 'utf8'));
  data.index.exact.e_widget_timeout = [1];
  fs.writeFileSync(w.cache, JSON.stringify(data));
  const r = createSearcher({ vaultDir: w.vault, stateDir: w.state, now }).search('E_WIDGET_TIMEOUT', { limit: 10, abstainThreshold: 0 });
  t.diagnostic(`fake in-range exact [1] -> first result ${r.results[0]?.path}; contract: content is not validated, accepted risk`);
  assert.ok(Array.isArray(r.results));
});
