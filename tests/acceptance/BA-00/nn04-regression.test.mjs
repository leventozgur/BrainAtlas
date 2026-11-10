// SPDX-License-Identifier: MIT
// BA-00 retest regression (finding 1): near-negative nn-04 asks how many concurrent connections a client may hold
// open to the Orchard API. No sentence in eval/corpus-ba may answer that premise or the quantity, so the abstain
// label stays correct. The query must not rely on the old "anonymous client" framing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_BA, DEV } from './helpers.mjs';

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const pages = walk(CORPUS_BA).filter((f) => f.endsWith('.md')).map((f) => readFileSync(f, 'utf8').toLowerCase());
const corpusText = pages.join('\n');
const orchardPages = pages.filter((p) => p.includes('orchard'));
const nn04 = JSON.parse(readFileSync(join(DEV, 'near-negative-cases.json'), 'utf8')).find((c) => c.id === 'nn-04');

// Answer terms for the asked quantity (concurrent connections per client).
const ANSWER_TERMS = [
  'concurrent', 'concurrency', 'max connections', 'maximum connections', 'connection limit', 'connection cap',
  'connections per', 'simultaneous connections', 'open connections', 'held open', 'hold open', 'keep-alive',
  'persistent connection', 'socket',
];
// Connection wording that would answer the Orchard-specific premise. Checked on Orchard pages only, because the
// unrelated database connection pool in ops/incident-2026-02-cache-stampede.md is not an Orchard API statement.
const ORCHARD_CONNECTION = /connection|concurren|simultan|socket|keep-alive/;

test('nn-04 is an abstain case with empty relevant', () => {
  assert.ok(nn04, 'nn-04 present');
  assert.equal(nn04.abstain, true);
  assert.deepEqual(nn04.relevant, []);
});

test('nn-04 query uses the current framing (no anonymous/anonim wording)', () => {
  assert.ok(nn04.query.length > 0, 'query present');
  assert.doesNotMatch(nn04.query.toLowerCase(), /anonym|anonim/);
  assert.match(nn04.query.toLowerCase(), /concurrent connections/);
  assert.match(nn04.query.toLowerCase(), /orchard api/);
});

test('nn-04: the asked quantity (concurrent connections / connection limit) does not occur in eval/corpus-ba', () => {
  for (const term of ANSWER_TERMS) {
    assert.ok(!corpusText.includes(term), `corpus contains "${term}"`);
  }
});

test('nn-04: no Orchard page states connection wording that would answer the premise', () => {
  assert.ok(orchardPages.length > 0, 'Orchard pages found in corpus');
  for (const page of orchardPages) {
    const hit = page.match(ORCHARD_CONNECTION);
    assert.equal(hit, null, `Orchard page contains connection wording "${hit && hit[0]}"`);
  }
});
