// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = join(root, 'packages/cli/bin/brainatlas.mjs');

test('JSON errors provide a stable envelope and redact HOME, including conflict paths', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'initvault-retest-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state') };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  for (const [args, code] of [[['migrate', '--from'], 'E_ARGUMENT'], [['migrate', '--from', join(home, 'missing'), '--to', join(home, 'target')], 'E_SOURCE_INVALID'], [['not-a-command'], 'E_COMMAND_UNKNOWN']]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, false); assert.equal(value.error.code, code); assert.equal(typeof value.error.message, 'string');
    assert.ok(!result.stdout.includes(home));
  }
  const outside = join(temp, 'outside'); await mkdir(outside);
  const marker = join(outside, 'marker'); await writeFile(marker, 'untouched');
  const data = join(home, '.local/share'); await mkdir(data, { recursive: true });
  await symlink(outside, join(data, 'brainatlas'));
  const result = run('uninstall');
  assert.notEqual(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false); assert.equal(value.error.code, 'E_UNINSTALL_CONFLICT');
  assert.deepEqual(value.error.conflicts, ['~/.local/share/brainatlas']);
  assert.ok(!result.stdout.includes(home));
  assert.equal(await readFile(marker, 'utf8'), 'untouched');
});
