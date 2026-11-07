// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../packages/core/src/util/index.mjs';
test('util contract exports are explicit not-implemented stubs', async () => {
  await assert.rejects(Promise.resolve().then(() => api.atomicWriteFile()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.safeJoin()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.runCommand()), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
