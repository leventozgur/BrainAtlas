// SPDX-License-Identifier: MIT
// BA-09 blind acceptance: link expansion (BA-08) combined with trust weighting. The first result must not change through a
// link, and link-added pages keep their `trust` field. Contract: docs/contracts/retrieval.md, "Order" and "Page links".
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCandidate, loadMain, makeVault, removeDir, page, record, NOW } from './helpers.mjs';

const rt = await loadCandidate();
let main;
before(async () => { main = await loadMain(); });
after(() => main?.dispose());

const QUERY = 'kestrel courier handoff';
const VERIFIED = `status: confirmed\n${record({})}`;
const search = (lib, dir, options = {}) => lib.search(lib.buildIndex(lib.loadPages(dir), { now: NOW }), QUERY, { limit: 10, abstainThreshold: 0.35, asOf: NOW, ...options });

test('a neutral top page stays first when it links to a weak page with no query terms, and the neighbour keeps its trust field', () => {
  const dir = makeVault({
    'top.md': page({ title: 'Top', body: 'kestrel courier handoff rules, see [[weak-side]].' }),
    'weak-side.md': page({ title: 'Side', fm: 'status: proposed\n', body: 'unrelated lamp wick schedule.' }),
  }, 'ba09-link-a-');
  try {
    const cand = search(rt, dir), mainOut = search(main.retrieval, dir);
    assert.equal(cand.results[0].path, 'top.md');
    assert.equal(Object.hasOwn(cand.results[0], 'via'), false);
    assert.equal(cand.results[0].score, mainOut.results[0].score, 'first score equals main');
    const side = cand.results.find((r) => r.path === 'weak-side.md');
    assert.ok(side, 'linked neighbour is returned');
    assert.equal(side.via, 'link');
    assert.equal(side.trust, 'weak');
  } finally {
    removeDir(dir);
  }
});

test('a verified top page keeps the first place when it links to a neutral page', () => {
  const dir = makeVault({
    'top.md': page({ title: 'Top', fm: VERIFIED, body: 'kestrel courier handoff rules, see [[neighbour]].' }),
    'neighbour.md': page({ title: 'Neighbour', body: 'kestrel courier notes about the lamp.' }),
  }, 'ba09-link-b-');
  try {
    const cand = search(rt, dir);
    assert.equal(cand.results[0].path, 'top.md');
    assert.equal(cand.results[0].trust, 'verified');
    assert.equal(cand.results[0].via, undefined);
  } finally {
    removeDir(dir);
  }
});

test('a weak top page keeps the first place over a neutral page that only a link reaches', () => {
  const dir = makeVault({
    'top.md': page({ title: 'Top', fm: 'status: disputed\n', body: 'kestrel courier handoff rules, see [[linked]].' }),
    'linked.md': page({ title: 'Linked', body: 'lamp wick schedule.' }),
  }, 'ba09-link-c-');
  try {
    const cand = search(rt, dir);
    assert.equal(cand.results[0].path, 'top.md');
    assert.equal(cand.results[0].trust, 'weak');
    const linked = cand.results.find((r) => r.path === 'linked.md');
    assert.equal(linked.via, 'link');
    assert.equal(Object.hasOwn(linked, 'trust'), false, 'a neutral linked page has no trust key');
  } finally {
    removeDir(dir);
  }
});

test('abstention is not changed by a link: a query with no lexical match abstains even when a page links to something', () => {
  const dir = makeVault({
    'top.md': page({ title: 'Top', fm: VERIFIED, body: 'lamp wick schedule, see [[other]].' }),
    'other.md': page({ title: 'Other', body: 'kestrel courier handoff rules.' }),
  }, 'ba09-link-d-');
  try {
    const cand = search(rt, dir, { abstainThreshold: 0.35 });
    const mainOut = search(main.retrieval, dir, { abstainThreshold: 0.35 });
    assert.equal(cand.abstained, mainOut.abstained);
    assert.equal(cand.reason, mainOut.reason);
  } finally {
    removeDir(dir);
  }
});
