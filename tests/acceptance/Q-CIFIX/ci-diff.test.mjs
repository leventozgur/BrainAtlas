// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Q-CIFIX originally pinned the workflow byte for byte to commit fce43aa plus `fail-fast: false`. Later intended
// changes (full-history checkout for BA-09 tests, Node 24 in the matrix) made that pin obsolete, so the test now
// checks the property Q-CIFIX introduced: one failing matrix job must not cancel the others.
test('CI workflow keeps fail-fast false in the matrix strategy', async () => {
  const current = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(current, /\n {4}strategy:\n {6}fail-fast: false\n/, 'the test job strategy must set fail-fast: false');
});
