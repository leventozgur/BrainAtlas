// SPDX-License-Identifier: MIT
// BA-25 hypothesis 3 (guard), part A: calls without expectedSha256 must behave exactly like main.
// The same call sequence runs against a main server and a candidate server on identical vault copies. Replies and the
// final Wiki files must match after normalising wall-clock timestamps. Two intentional, documented differences are
// removed before comparison: wiki_read_page carries the new `sha256` field, and wiki_status carries the `indexAgeMs`
// clock value. The test skips itself once main contains the lock module (then main is no longer the old behaviour).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { makeFixture, openClient, call, textOf, page, secret, filesUnder, WT, MAIN, mainHasFeature, LOCK_NAME } from './harness.mjs';

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const normalize = (value) => JSON.parse(JSON.stringify(value).replace(TS, '<TS>'));

const SCRIPT = [
  ['wiki_list_pages', {}],
  ['wiki_query', { query: 'synthetic bilingual', limit: 3 }],
  ['wiki_read_page', { path: 'wiki/entities/sample-06.md' }],
  ['wiki_read_index', {}],
  ['wiki_status', {}],
  ['wiki_lint', {}],
  ['wiki_write_page', { path: 'entities/eq-probe.md', content: page('Eq Probe', 'Eq probe evidence.') }],
  ['wiki_update_page', { path: 'entities/eq-probe.md', patch: { append: '\nAppended.' } }],
  ['wiki_update_page', { path: 'entities/eq-probe.md', content: page('Eq Probe', 'Replaced body, see [Eq Concept](../concepts/eq-concept.md).') }],
  ['wiki_update_page', { path: 'entities/eq-probe.md' }],
  ['wiki_create_entity', { name: 'Eq Entity', content: 'Evidence.' }],
  ['wiki_create_entity', { name: 'Eq Entity', content: 'Duplicate.' }],
  ['wiki_create_concept', { name: 'Eq Concept', content: '---\nsummary: Concept for equivalence\ntags: [eq, check]\n---\nConcept body.' }],
  ['wiki_add_crosslinks', { path: 'entities/eq-probe.md' }],
  ['wiki_update_index', {}],
  ['wiki_write_page', { path: '../escape.md', content: page('Escape', 'x') }],
  ['wiki_write_page', { path: 'entities/eq-secret.md', content: page('Eq Secret', `key ${secret()}`) }],
  ['wiki_read_page', { path: '../outside.md' }],
  ['wiki_query', { query: 'eq probe' }],
  ['wiki_list_pages', {}],
  ['wiki_list_pages', { type: 'entities' }],
  ['wiki_status', {}],
  ['wiki_read_index', {}],
];

async function runScript(t, root) {
  const f = await makeFixture(t);
  const c = await openClient(t, root, f, 'eq');
  const replies = [];
  for (const [name, args] of SCRIPT) {
    const r = await call(c.client, name, args);
    let body = textOf(r);
    try { body = JSON.parse(body); } catch { /* plain error text */ }
    if (name === 'wiki_read_page' && body && typeof body === 'object') delete body.sha256; // intentional BA-25 addition
    if (name === 'wiki_status' && body && typeof body === 'object') delete body.indexAgeMs; // clock value
    replies.push({ name, isError: r.isError === true, body: normalize(body) });
  }
  const tree = {};
  for (const path of await filesUnder(f.wikiDir)) tree[relative(f.wikiDir, path)] = (await readFile(path, 'utf8')).replace(TS, '<TS>');
  return { replies, tree, f };
}

test('guard A: candidate replies and final Wiki files equal main for calls without expectedSha256', { skip: mainHasFeature ? 'feature already present in main' : false }, async (t) => {
  const main = await runScript(t, MAIN);
  const cand = await runScript(t, WT);
  assert.equal(cand.replies.length, main.replies.length);
  for (let i = 0; i < main.replies.length; i++) {
    assert.deepEqual(cand.replies[i], main.replies[i], `reply ${i} (${SCRIPT[i][0]}) differs from main`);
  }
  assert.deepEqual(Object.keys(cand.tree).sort(), Object.keys(main.tree).sort(), 'same file set in the Wiki');
  for (const key of Object.keys(main.tree)) assert.equal(cand.tree[key], main.tree[key], `file ${key} differs from main`);
  // The lock file must not survive the run.
  assert.equal(existsSync(join(cand.f.wikiDir, LOCK_NAME)), false);
  // Sanity: the script really exercised writes and refusals (guards against a vacuous comparison).
  assert.ok(main.replies.some((r) => r.isError), 'script includes refused calls');
  assert.ok(main.replies.some((r) => !r.isError && r.name === 'wiki_add_crosslinks'), 'script includes a successful crosslink');
});

test('guard A (candidate only): the script ends with no lock file and no temporary file in the Wiki', async (t) => {
  const cand = await runScript(t, WT);
  const names = (await filesUnder(cand.f.wikiDir)).map((p) => p.split('/').at(-1));
  assert.equal(names.some((n) => n === LOCK_NAME || n.endsWith('.tmp')), false);
  assert.equal(cand.replies.filter((r) => r.isError).length >= 5, true, 'refusals present');
});
