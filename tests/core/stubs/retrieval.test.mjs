// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../packages/core/src/retrieval/index.mjs';
test('retrieval contract exports are explicit not-implemented stubs', async () => {
  await assert.rejects(Promise.resolve().then(() => api.buildIndex()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.search()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.createSearcher()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.normalizeText()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.stem()), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
