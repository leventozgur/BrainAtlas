// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../packages/core/src/checkpoint/index.mjs';
test('checkpoint contract exports are explicit not-implemented stubs', async () => {
  await assert.rejects(Promise.resolve().then(() => api.checkpoint()), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
