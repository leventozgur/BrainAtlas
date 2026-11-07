// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../../packages/core/src/modules/index.mjs';
test('modules contract exports are explicit not-implemented stubs', async () => {
  await assert.rejects(Promise.resolve().then(() => api.readModuleManifest()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.discoverModules()), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => api.resolveModuleOrder()), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
