// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, main } from '../../packages/mcp/src/index.mjs';
test('MCP server contract is an explicit not-implemented stub', () => {
  assert.throws(() => createServer({}), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
test('MCP stdio entry is an explicit not-implemented stub', async () => {
  await assert.rejects(Promise.resolve().then(() => main()), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
