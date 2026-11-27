// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePaths, vaultStateDir } from '../../packages/core/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');

test('BA-105: CLI wiki write and query use the per-vault index', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ba105-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await mkdir(vault, { recursive: true });
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const run = (input, ...args) =>
    spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false, input });
  const init = run(undefined, 'init', '--yes', '--vault', vault);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  const page = `---\ntype: concept\ntitle: "Zebra"\ngenerated: "2026-11-01"\nstatus: proposed\nsources: []\nverified: []\nstale_after: "P90D"\n---\n\n# Zebra\n\nzebrafish text.\n`;
  const written = run(page, 'wiki', 'write', 'concepts/zebra.md', '--json');
  assert.equal(written.status, 0, written.stderr + written.stdout);
  const query = run(undefined, 'wiki', 'query', 'zebrafish', '--json');
  assert.equal(query.status, 0, query.stderr + query.stdout);
  const paths = resolvePaths({ platform: 'linux', env });
  await stat(join(vaultStateDir(paths, vault), 'retrieval-index.json'));
  await assert.rejects(stat(join(paths.stateDir, 'retrieval-index.json')));
});
