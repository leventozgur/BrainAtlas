// SPDX-License-Identifier: MIT
// BA-04 independent acceptance: the persisted cache carries `supersedes`; a structurally bad or pre-BA-04 cache is rebuilt,
// and a vault change is picked up. Hermetic: temporary directories only, no HOME access, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearcher } from '../../../packages/core/src/retrieval/index.mjs';
import { NOW } from './helpers.mjs';

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ba04-cache-'));
  const vault = path.join(root, 'vault'), state = path.join(root, 'state');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'a.md'), '---\nstatus: superseded\nsuperseded_by: b.md\n---\n# Quota\nlegacy quota is 10 per day\n');
  fs.writeFileSync(path.join(vault, 'b.md'), '# Quota\nquota is 50 per day\n');
  return { root, vault, state, cacheFile: path.join(state, 'retrieval-index.json') };
}

const supersedesOf = (searcher, query = 'quota per day') => searcher.search(query, { limit: 5, asOf: NOW }).results.find(r => r.path === 'b.md')?.supersedes;

test('a fresh build routes the superseded page and writes it into the cache', () => {
  const v = makeVault();
  try {
    const s = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
    assert.deepEqual(supersedesOf(s), ['a.md']);
    assert.deepEqual(JSON.parse(fs.readFileSync(v.cacheFile, 'utf8')).index.supersedes, { 'b.md': ['a.md'] });
  } finally { fs.rmSync(v.root, { recursive: true, force: true }); }
});

test('a cache that carries a bad supersedes map is rejected and rebuilt with the correct routing', () => {
  const bad = {
    'target not indexed': { 'ghost.md': ['a.md'] },
    'source not skipped': { 'b.md': ['b.md'] },
    'empty source list': { 'b.md': [] },
    'unsorted sources': { 'b.md': ['c.md', 'a.md'] },
    'non-string source': { 'b.md': [7] },
    'array instead of object': [['b.md', ['a.md']]],
  };
  for (const [label, value] of Object.entries(bad)) {
    const v = makeVault();
    try {
      createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
      const data = JSON.parse(fs.readFileSync(v.cacheFile, 'utf8'));
      data.index.supersedes = value;
      fs.writeFileSync(v.cacheFile, JSON.stringify(data));
      const s = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
      assert.deepEqual(supersedesOf(s), ['a.md'], label);
      assert.deepEqual(JSON.parse(fs.readFileSync(v.cacheFile, 'utf8')).index.supersedes, { 'b.md': ['a.md'] }, `${label}: repaired cache`);
    } finally { fs.rmSync(v.root, { recursive: true, force: true }); }
  }
});

test('a pre-BA-04 cache without a supersedes map is rejected and rebuilt once', () => {
  const v = makeVault();
  try {
    createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
    const data = JSON.parse(fs.readFileSync(v.cacheFile, 'utf8'));
    delete data.index.supersedes;
    fs.writeFileSync(v.cacheFile, JSON.stringify(data));
    const s = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
    assert.deepEqual(supersedesOf(s), ['a.md']);
    assert.deepEqual(JSON.parse(fs.readFileSync(v.cacheFile, 'utf8')).index.supersedes, { 'b.md': ['a.md'] });
  } finally { fs.rmSync(v.root, { recursive: true, force: true }); }
});

test('adding a superseded page is detected by refreshIfChanged and routed', () => {
  const v = makeVault();
  try {
    const s = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
    assert.deepEqual(supersedesOf(s), ['a.md']);
    fs.writeFileSync(path.join(v.vault, 'c-old.md'), '---\nstatus: superseded\nsuperseded_by: b.md\n---\n# Quota\nolder quota is 5 per day\n');
    assert.equal(s.refreshIfChanged(), true);
    assert.deepEqual(supersedesOf(s), ['a.md', 'c-old.md']);
  } finally { fs.rmSync(v.root, { recursive: true, force: true }); }
});

test('removing a superseded page is detected and its routing disappears', () => {
  const v = makeVault();
  try {
    const s = createSearcher({ vaultDir: v.vault, stateDir: v.state, now: NOW });
    assert.deepEqual(supersedesOf(s), ['a.md']);
    fs.rmSync(path.join(v.vault, 'a.md'));
    assert.equal(s.refreshIfChanged(), true);
    assert.equal(supersedesOf(s), undefined);
    assert.equal(JSON.parse(fs.readFileSync(v.cacheFile, 'utf8')).index.supersedes['b.md'], undefined);
  } finally { fs.rmSync(v.root, { recursive: true, force: true }); }
});
