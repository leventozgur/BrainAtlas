// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAME, CLI_NAME, CLI_ALIAS, MCP_SERVER_KEY, NPM_SCOPE, MAC_APP_DIR_NAME, LINUX_DIR_NAME, VERSION, SIGNATURE_NAMESPACE } from '../../packages/core/src/meta/index.mjs';
test('metadata has one stable BrainAtlas identity and package version', () => {
  assert.deepEqual([NAME,CLI_NAME,CLI_ALIAS,MCP_SERVER_KEY,NPM_SCOPE,MAC_APP_DIR_NAME,LINUX_DIR_NAME,SIGNATURE_NAMESPACE],['BrainAtlas','brainatlas','ba','brainatlas','@brainatlas','BrainAtlas','brainatlas','brainatlas-release']);
  assert.equal(VERSION,'0.1.0-rc.5');
});
