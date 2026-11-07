// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransport } from '../../modules/sync-engine/src/transport.mjs';
test('memory transport contract is an explicit not-implemented stub', () => {
  assert.throws(() => createMemoryTransport(), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
