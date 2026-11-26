// SPDX-License-Identifier: MIT
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorktreeRetrieval } from './helpers/main-core.mjs';
import { isolateHome, makeVault, writeFiles } from './helpers/vault.mjs';

const now = new Date('2026-11-10T00:00:00Z');
let rt, restoreHome;
before(async () => {
  restoreHome = isolateHome('ba08-cache');
  rt = await loadWorktreeRetrieval();
});
after(() => restoreHome());

const body = (text) => `${text}\n`;
const FILES = {
  'seed.md': body('kestrel courier handoff rules [[timing]] and [[notes/lamp]].'),
  'timing.md': body('forty minutes countersign [[seed]]'),
  'notes/lamp.md': body('lamp wick trimming schedule'),
  'garden.md': body('soil compost unrelated [[timing]]'),
};
const QUERIES = [
  'kestrel courier handoff',
  'forty countersign',
  'lamp wick',
  'soil compost',
  'zebra quasar',
  'handoff rules timing',
];
const answers = (searcher) => QUERIES.map((q) => searcher.search(q, { limit: 10, abstainThreshold: 0, asOf: now }));

function coldAnswers(t, files) {
  const { vault, state } = makeVault(t, files, 'ba08-cold');
  const cold = rt.createSearcher({ vaultDir: vault, stateDir: path.join(state, 'cold'), now });
  return { answers: answers(cold), links: cold.snapshot().index.links, vault, state };
}

test('a valid cache is reused without rewriting it, and answers the same as a cold build', (t) => {
  const w = makeVault(t, FILES, 'ba08-warm');
  const first = rt.createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  const cold = answers(first);
  const bytes = fs.readFileSync(w.cache, 'utf8');
  assert.ok(JSON.parse(bytes).index.links, 'the persisted index carries links');
  const second = rt.createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  assert.equal(fs.readFileSync(w.cache, 'utf8'), bytes, 'a valid cache is not rewritten');
  assert.deepEqual(answers(second), cold);
  assert.equal(JSON.stringify(second.snapshot().index.links), JSON.stringify(JSON.parse(bytes).index.links));
  assert.ok(
    cold.some(
      (r, i) =>
        QUERIES[i] === 'kestrel courier handoff' && r.results.some((x) => x.path === 'timing.md' && x.via === 'link')
    ),
    'expansion is active on the cached path'
  );
});

test('a cache without links is rejected and rebuilt, and the rebuilt cache carries the same graph as a cold build', (t) => {
  const cold = coldAnswers(t, FILES);
  const w = makeVault(t, FILES, 'ba08-nolinks');
  rt.createSearcher({ vaultDir: w.vault, stateDir: w.state, now }).snapshot();
  const data = JSON.parse(fs.readFileSync(w.cache, 'utf8'));
  delete data.index.links;
  fs.writeFileSync(w.cache, JSON.stringify(data));
  const rebuilt = rt.createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  assert.deepEqual(answers(rebuilt), cold.answers);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.cache, 'utf8')).index.links, cold.links);
});

const tampers = {
  'asymmetric edge (neighbour lost its back link)': (links) => {
    const k = Object.keys(links)[0];
    links[k] = links[k].slice(1);
    if (!links[k].length) delete links[k];
  },
  'self edge': (links) => {
    const k = Object.keys(links)[0];
    links[k] = [...links[k], Number(k)].sort((a, b) => a - b);
  },
  'out-of-range neighbour': (links) => {
    const k = Object.keys(links)[0];
    links[k] = [...links[k], 9999];
  },
  'empty neighbour list': (links) => {
    const k = Object.keys(links)[0];
    links[k] = [];
  },
  'non-numeric key': (links) => {
    links.x = [0];
  },
  'neighbour list not an array': (links) => {
    const k = Object.keys(links)[0];
    links[k] = 'abc';
  },
  'unsorted neighbour list': (links) => {
    const k = Object.keys(links).find((x) => links[x].length >= 2);
    links[k] = [...links[k]].reverse();
  },
};
for (const [name, tamper] of Object.entries(tampers)) {
  test(`a cache with a broken graph (${name}) is rejected and rebuilt`, (t) => {
    const cold = coldAnswers(t, FILES);
    const w = makeVault(t, FILES, 'ba08-tamper');
    rt.createSearcher({ vaultDir: w.vault, stateDir: w.state, now }).snapshot();
    const data = JSON.parse(fs.readFileSync(w.cache, 'utf8'));
    tamper(data.index.links);
    fs.writeFileSync(w.cache, JSON.stringify(data));
    const reopened = rt.createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
    assert.deepEqual(answers(reopened), cold.answers, 'answers equal a cold build');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(w.cache, 'utf8')).index.links,
      cold.links,
      'the rewritten cache carries the true graph'
    );
  });
}

test('a link target added to the vault appears after refreshIfChanged, and is dropped again when the target is removed', (t) => {
  const w = makeVault(t, { 'seed.md': body('kestrel courier handoff rules') }, 'ba08-fresh');
  const searcher = rt.createSearcher({ vaultDir: w.vault, stateDir: w.state, now });
  assert.equal(searcher.refreshIfChanged(), false);
  const before = searcher.search('kestrel courier handoff', { abstainThreshold: 0, asOf: now }).results;
  assert.ok(!before.some((r) => r.path === 'timing.md'));

  writeFiles(w.vault, {
    'seed.md': body('kestrel courier handoff rules [[timing]] with a longer line'),
    'timing.md': body('forty minutes countersign'),
  });
  assert.equal(searcher.refreshIfChanged(), true);
  const linked = searcher.search('kestrel courier handoff', { abstainThreshold: 0, asOf: now }).results;
  assert.equal(linked.find((r) => r.path === 'timing.md')?.via, 'link');
  assert.equal(searcher.refreshIfChanged(), false);

  fs.rmSync(path.join(w.vault, 'timing.md'));
  writeFiles(w.vault, {
    'seed.md': body('kestrel courier handoff rules [[timing]] with a much longer line than before'),
  });
  assert.equal(searcher.refreshIfChanged(), true);
  const after = searcher.search('kestrel courier handoff', { abstainThreshold: 0, asOf: now }).results;
  assert.ok(!after.some((r) => r.path === 'timing.md'));
  assert.equal(after[0].related, undefined);
});
