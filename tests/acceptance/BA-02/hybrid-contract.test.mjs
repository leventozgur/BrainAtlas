// SPDX-License-Identifier: MIT
// BA-02 blind acceptance: searchHybrid with and without lexicalIndex, and core search, must match the main
// (1eeec6e) outputs byte-for-byte. Golden digests were produced by running hybrid-cases.mjs on the main tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { runHybridCases } from './hybrid-cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GOLDEN = {
  core: '9976c137411ee4305528f22bb6500e225577d32ea088037a8242ef9cc7fd953f',
  plain: 'c3743193df1fc951eecef1839b5e55b2df47b06c9af2788c1c035608a2165638',
  indexed: '1a9eb2e606d6b07a85beac342aa2a4e8dbb3b468ca993bdb6db8fb7d4dc2a6ec',
};

test('core search, hybrid without lexicalIndex and hybrid with lexicalIndex match main byte-for-byte', async () => {
  const got = await runHybridCases(root);
  assert.equal(got.caseCount, 1057);
  assert.equal(got.core, GOLDEN.core, 'core search output differs from main');
  assert.equal(got.plain, GOLDEN.plain, 'searchHybrid without lexicalIndex differs from main');
  assert.equal(got.indexed, GOLDEN.indexed, 'searchHybrid with lexicalIndex differs from main');
  assert.equal(got.supportsSnapshot, true);
});
