// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransport } from '../../modules/sync-engine/src/transport.mjs';
import * as moduleEntry from '../../modules/sync-engine/src/index.mjs';
test('memory transport contract is an explicit not-implemented stub', () => {
  assert.throws(() => createMemoryTransport(), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
test('module entry exports commands and an explicit not-implemented activation stub', async () => {
  assert.deepEqual(moduleEntry.commands, {});
  await assert.rejects(moduleEntry.activate({}), (error) => error.name === 'NotImplementedError' && error.code === 'E_NOT_IMPLEMENTED');
});
