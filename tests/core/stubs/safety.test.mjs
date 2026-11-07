// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanPath, redact } from '../../../packages/core/src/safety/index.mjs';
test('safety API accepts safe content and paths', () => {
  assert.deepEqual(scanText('ordinary text'), []);
  assert.deepEqual(scanPath('docs/readme.md'), []);
  assert.equal(redact('ordinary text'), 'ordinary text');
});
