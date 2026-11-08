// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCommand } from '../../packages/core/src/util/index.mjs';
import { cleanEnv } from './clean-env.mjs';

test('runCommand captures output, input and exit code without a shell', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ba-command-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = cleanEnv({ SAMPLE_VALUE: 'safe-value' });
  const result = await runCommand(process.execPath, ['-e', "let data=''; process.stdin.on('data', x => data += x); process.stdin.on('end', () => { process.stdout.write(process.env.SAMPLE_VALUE + ':' + data); process.stderr.write('diagnostic'); process.exitCode = 7; });"], { cwd, env, input: 'input' });
  assert.deepEqual(result, { code: 7, stdout: 'safe-value:input', stderr: 'diagnostic' });
});

test('runCommand terminates a timed out child and blocks network commands offline', async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: resolve('.'), env: cleanEnv(), timeoutMs: 50 });
  assert.equal(result.code, 124);
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(runCommand('curl', ['https://example.invalid'], { cwd: resolve('.'), env: cleanEnv({ BRAINATLAS_OFFLINE: '1' }) }), { code: 'E_OFFLINE' });
  await assert.rejects(runCommand('git', ['-C', '.', 'fetch', 'https://example.invalid/repo.git'], { cwd: resolve('.'), env: cleanEnv({ BRAINATLAS_OFFLINE: '1' }) }), { code: 'E_OFFLINE' });
});
