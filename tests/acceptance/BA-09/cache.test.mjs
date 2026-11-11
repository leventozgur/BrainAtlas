// SPDX-License-Identifier: MIT
// BA-09 blind acceptance: the persisted index stores each document's trust class. A cache whose class is missing or wrong is
// rejected and rebuilt once; a changed page is picked up through the freshness key. Contract: docs/contracts/retrieval.md, "Cache".
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCandidate, makeVault, removeDir, page, record, NOW } from './helpers.mjs';

const rt = await loadCandidate();
const dirs = [];
after(() => dirs.forEach(removeDir));
const QUERY = 'zephyr quorum ledger';
const BODY = 'zephyr quorum ledger reconciliation notes.';
const VERIFIED = `status: confirmed\n${record({})}`;

function setup(prefix) {
  const vault = makeVault({
    'v.md': page({ fm: VERIFIED, body: BODY }),
    'w.md': page({ fm: 'status: proposed\n', body: BODY }),
    'n.md': page({ body: BODY }),
  }, `ba09-${prefix}-vault-`);
  const state = makeVault({}, `ba09-${prefix}-state-`);
  dirs.push(vault, state);
  const cache = path.join(state, 'retrieval-index.json');
  const searcher = () => rt.createSearcher({ vaultDir: vault, stateDir: state, now: NOW });
  return { vault, state, cache, searcher };
}
const answer = (s) => s.search(QUERY, { limit: 10, abstainThreshold: 0, asOf: NOW });
const trustFromCache = (cache) => Object.fromEntries(JSON.parse(fs.readFileSync(cache, 'utf8')).index.docs.map((d) => [d.page.path, d.trust]));
const docFor = (data, file) => data.index.docs.find((d) => d.page.path === file);

test('a cold build stores the trust class of every document in the cache', () => {
  const { cache, searcher } = setup('store');
  const cold = answer(searcher());
  assert.deepEqual(trustFromCache(cache), { 'v.md': 'verified', 'w.md': 'weak', 'n.md': 'neutral' });
  assert.equal(cold.results[0].path, 'v.md');
  assert.equal(cold.results[0].trust, 'verified');
});

test('a cache with a wrong class is rejected, rebuilt once, and answers like a cold build', () => {
  const { cache, searcher } = setup('wrong');
  const cold = answer(searcher());
  const data = JSON.parse(fs.readFileSync(cache, 'utf8'));
  docFor(data, 'v.md').trust = 'neutral';
  fs.writeFileSync(cache, JSON.stringify(data));
  const again = answer(searcher());
  assert.deepEqual(again, cold);
  assert.equal(trustFromCache(cache)['v.md'], 'verified', 'the cache was rewritten with the right class');
});

test('a cache whose class is missing or not one of the three values is rejected and rebuilt', () => {
  for (const [label, mutate] of [['missing', (d) => { delete d.trust; }], ['unknown', (d) => { d.trust = 'trusted'; }]]) {
    const { cache, searcher } = setup(`bad-${label}`);
    const cold = answer(searcher());
    const data = JSON.parse(fs.readFileSync(cache, 'utf8'));
    mutate(docFor(data, 'w.md'));
    fs.writeFileSync(cache, JSON.stringify(data));
    assert.deepEqual(answer(searcher()), cold, label);
    assert.equal(trustFromCache(cache)['w.md'], 'weak', `${label} class was rebuilt`);
  }
});

test('an edited page is re-read through the freshness key, and its new class is used', () => {
  const { vault, searcher } = setup('edit');
  assert.equal(answer(searcher()).results.find((r) => r.path === 'w.md').trust, 'weak');
  // A different status changes the file size, so the stat-based freshness key changes with the write.
  fs.writeFileSync(path.join(vault, 'w.md'), page({ fm: 'status: draft\n', body: BODY }), 'utf8');
  const out = answer(searcher());
  assert.equal(out.results.find((r) => r.path === 'w.md')?.trust, undefined, 'draft is neutral');
});
