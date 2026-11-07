// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelease, verifyRelease } from '../../release/build-release.mjs';
test('release builder and verifier are explicit not-implemented stubs', async () => {
  await assert.rejects(Promise.resolve().then(() => buildRelease({})), (error) => error.code === 'E_NOT_IMPLEMENTED');
  await assert.rejects(Promise.resolve().then(() => verifyRelease()), (error) => error.code === 'E_NOT_IMPLEMENTED');
});
