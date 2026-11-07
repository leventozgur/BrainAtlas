// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../../packages/adapters/gemini-cli/src/index.mjs';
test('gemini-cli adapter contract methods are explicit not-implemented stubs', async () => {
  for (const [method, args] of [['detect',[{}]],['plan',[{}]],['apply',[{},{}]],['remove',[{}]],['doctor',[{}]],['trustReview',[{}]]]) {
    await assert.rejects(Promise.resolve().then(() => adapter[method](...args)), (error) => error.code === 'E_NOT_IMPLEMENTED');
  }
});
