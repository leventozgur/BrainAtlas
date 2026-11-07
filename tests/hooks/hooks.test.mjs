// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { runHook } from '../../packages/hooks/src/index.mjs';
test('hook contract is an explicit not-implemented stub', async () => {
  await assert.rejects(Promise.resolve().then(() => runHook({})), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
