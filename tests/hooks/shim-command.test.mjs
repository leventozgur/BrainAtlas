// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookCommand } from '../../packages/hooks/src/index.mjs';

test('hook command executes a polyglot shim in a path with spaces', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hook shim test '));
  t.after(() => rm(root, {recursive:true, force:true}));
  const release = join(root, 'release'), vault = join(root, 'vault'), state = join(root, 'state');
  const bin = join(root, 'bin with spaces'), actualBin = join(root, 'actual bin');
  await Promise.all([release, vault, state, bin, actualBin].map(dir => mkdir(dir)));
  const entry = join(release, 'fixture entry.mjs');
  const actualShim = join(actualBin, 'brainatlas');
  const shim = join(bin, 'brainatlas');
  await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const shellNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  await writeFile(actualShim, `#!/bin/sh\n":" //; exec ${shellNode} "$0" "$@"\nimport(require('node:url').pathToFileURL(${JSON.stringify(entry)}).href);\n`);
  await symlink(actualShim, shim);

  const command = buildHookCommand({nodePath:process.execPath, shimPath:shim, client:'gemini', event:'session-start', paths:{vault, state, release}});
  const run = args => spawnSync(command[0], args, {encoding:'utf8'});
  const result = run(command.slice(1));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['gemini', 'session-start']);

  await t.test('permission model requires read access to the shim', async t => {
    if (!command.includes('--permission')) return t.skip('Node permission model unavailable');
    const realShim = await realpath(actualShim);
    assert.ok(command.includes(`--allow-fs-read=${shim}`));
    assert.ok(command.includes(`--allow-fs-read=${realShim}`));
    const denied = run(command.slice(1).filter(arg => arg !== `--allow-fs-read=${shim}` && arg !== `--allow-fs-read=${realShim}`));
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /ERR_ACCESS_DENIED/);
  });
});
