// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../packages/core/src/safety/index.mjs';
test('safety contract exports are explicit not-implemented stubs', async () => {
  await assert.rejects(Promise.resolve().then(() => api.scanText()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.scanPath()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.redact()), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
