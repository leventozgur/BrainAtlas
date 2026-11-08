// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '@brainatlas/core';
import { cleanEnv } from './clean-env.mjs';

test('installed shim works directly and through Node and repairs an old shim', async t => {
  const root = resolve('.');
  const work = await realpath(await mkdtemp(join(tmpdir(), "ba shim ' space-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const home = join(work, 'home with spaces');
  const data = join(home, 'Application Support', 'brainatlas');
  const release = join(data, 'releases', 'test');
  await mkdir(release, { recursive: true });
  await symlink(join(root, 'packages'), join(release, 'packages'), 'dir');
  await symlink('releases/test', join(data, 'current'));
  const env = cleanEnv({ HOME: home, XDG_DATA_HOME: join(home, 'Application Support'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux' });
  const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
  const shim = join(data, 'bin', 'brainatlas');
  const run = (command, args) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
  const finalize = () => run(process.execPath, [cli, 'install', '--finalize']);
  const installed = finalize();
  assert.equal(installed.status, 0, installed.stderr);

  const checkVersion = result => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), VERSION);
  };
  await t.test('direct execution', () => checkVersion(run(shim, ['--version'])));
  await t.test('Node in CommonJS and ESM package scopes', async () => {
    for (const type of ['commonjs', 'module']) {
      await writeFile(join(data, 'package.json'), JSON.stringify({ type }));
      checkVersion(run(process.execPath, [shim, '--version']));
    }
  });
  await t.test('Node permission mode', t => {
    if (!process.allowedNodeEnvironmentFlags.has('--permission')) return t.skip('Node does not support --permission');
    checkVersion(run(process.execPath, ['--permission', `--allow-fs-read=${work}`, `--allow-fs-read=${root}`, shim, '--version']));
  });
  await t.test('old shell-only shim fails under Node and finalize repairs it', async () => {
    const original = await readFile(shim, 'utf8');
    await writeFile(shim, `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`);
    const broken = run(process.execPath, [shim, '--version']);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /SyntaxError/);
    const repaired = finalize();
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(await readFile(shim, 'utf8'), original);
    checkVersion(run(process.execPath, [shim, '--version']));
  });
});
