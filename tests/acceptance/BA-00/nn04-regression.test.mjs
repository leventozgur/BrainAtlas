// SPDX-License-Identifier: MIT
// BA-00 retest regression (finding 1): near-negative nn-04 asks for a concurrent-connection count. The corpus must not
// contain that answer (no concurrency/connection-limit wording), so the abstain label stays correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_BA, DEV } from './helpers.mjs';

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const corpusText = walk(CORPUS_BA).filter((f) => f.endsWith('.md')).map((f) => readFileSync(f, 'utf8')).join('\n').toLowerCase();
const nn04 = JSON.parse(readFileSync(join(DEV, 'near-negative-cases.json'), 'utf8')).find((c) => c.id === 'nn-04');

test('nn-04 is an abstain case with empty relevant', () => {
  assert.ok(nn04, 'nn-04 present');
  assert.equal(nn04.abstain, true);
  assert.deepEqual(nn04.relevant, []);
});

test('nn-04: the asked quantity (concurrent connections / connection limit) does not occur in eval/corpus-ba', () => {
  for (const term of ['concurrent', 'concurrency', 'max connections', 'connection limit', 'connections per', 'simultaneous connections', 'open connections']) {
    assert.ok(!corpusText.includes(term), `corpus contains "${term}"`);
  }
});
