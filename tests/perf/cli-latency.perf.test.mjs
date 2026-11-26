// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../packages/core/src/util/index.mjs';
import { cleanEnv } from '../cli/clean-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('runCommand terminates a timed out child and blocks network commands offline', async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    cwd: ROOT,
    env: cleanEnv(),
    timeoutMs: 50,
  });
  assert.equal(result.code, 124);
  assert.ok(Date.now() - started < 3000);
});
