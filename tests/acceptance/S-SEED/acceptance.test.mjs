// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initVault } from '../../../packages/core/src/vault/index.mjs';
import { runCommand } from '../../../packages/core/src/util/index.mjs';
import { createSyncEngine } from '../../../modules/sync-engine/src/engine.mjs';
import { createGitTransport } from '../../../modules/sync-git/src/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 's-seed-accept-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitConfig = join(root, 'git-config');
  await writeFile(gitConfig, '');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: join(root, 'home'),
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'home', 'config'),
    XDG_DATA_HOME: join(root, 'home', 'data'),
    XDG_STATE_HOME: join(root, 'home', 'state'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  await mkdir(env.HOME, { recursive: true });
  const remote = join(root, 'remote.git');
  const initialized = await runCommand('git', ['init', '--bare', '--initial-branch=main', remote], { cwd: root, env, timeoutMs: 10_000 });
  assert.equal(initialized.code, 0, initialized.stderr);
  const remoteUrl = pathToFileURL(remote).href;
  async function host(name) {
    const home = join(root, name);
    const vaultPath = join(home, 'vault');
    const stateDir = join(home, 'state');
    const hostEnv = { ...env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_HOST_ID: name };
    await mkdir(home, { recursive: true });
    await initVault(vaultPath);
    const transport = createGitTransport({ stateDir, remote: remoteUrl, env: hostEnv });
    const engine = createSyncEngine({ vaultPath, stateDir, transport, env: hostEnv });
    return { vaultPath, stateDir, engine };
  }
  async function head() {
    const result = await runCommand('git', ['--git-dir', remote, 'rev-parse', 'HEAD'], { cwd: root, env, timeoutMs: 10_000 });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  }
  return { root, remote, host, head };
}

async function put(vaultPath, path, bytes) {
  const target = join(vaultPath, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, bytes);
}

async function conflictCopiesBelow(root, current = root) {
  const names = await readdir(current, { withFileTypes: true });
  const found = [];
  for (const entry of names) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) found.push(...await conflictCopiesBelow(root, path));
    else if (entry.name.includes('.conflict-')) found.push(path.slice(root.length + 1));
  }
  return found;
}

test('two initialized hosts converge from an untouched seed on an empty bare remote', async t => {
  const fx = await fixture(t);
  const a = await fx.host('seed-left');
  const b = await fx.host('seed-right');
  const remoteContent = new Map([
    ['AGENTS.md', Buffer.from('# Shared policy\n\nRemote policy content.\n')],
    ['wiki/index.md', Buffer.from('# Shared index\n\n- [Remote](wiki/entities/remote.md)\n')],
    ['wiki/log.md', Buffer.from('# Shared log\n\n- Remote history entry.\n')],
    ['planning/backlog.md', Buffer.from('# Shared backlog\n\n- Remote task.\n')],
    ['wiki/entities/remote.md', Buffer.from('# Remote page\n\nShared content.\n')],
  ]);
  for (const [path, bytes] of remoteContent) await put(a.vaultPath, path, bytes);

  const first = await a.engine.run();
  assert.equal(first.status, 'SYNCED');
  assert.equal(first.pushed, remoteContent.size);
  const headBeforeB = await fx.head();
  const second = await b.engine.run();

  assert.equal(second.status, 'SYNCED');
  assert.equal(second.pulled, remoteContent.size);
  assert.equal(second.merged, 0);
  assert.equal(second.pushed, 0);
  assert.deepEqual(second.conflicts, []);
  for (const [path, expected] of remoteContent) assert.deepEqual(await readFile(join(b.vaultPath, path)), expected, path);
  assert.deepEqual(await conflictCopiesBelow(b.vaultPath), []);
  assert.equal(await fx.head(), headBeforeB);
  assert.deepEqual(await a.engine.checkPeer(b.stateDir), { status: 'PASS', differences: [] });
});

test('a modified local init template still produces an unbased conflict copy', async t => {
  const fx = await fixture(t);
  const a = await fx.host('seed-left');
  const b = await fx.host('seed-right');
  const remote = Buffer.from('# Shared policy\n\nRemote policy content.\n');
  const template = await readFile(new URL('../../../templates/policy/AGENTS.md', import.meta.url));
  await put(a.vaultPath, 'AGENTS.md', remote);
  await put(b.vaultPath, 'AGENTS.md', Buffer.concat([template, Buffer.from('\nLocal customization.\n')]));
  await a.engine.run();

  const result = await b.engine.run();
  assert.equal(result.status, 'CONFLICT');
  assert.deepEqual(result.conflicts.map(({ path, kind }) => ({ path, kind })), [{ path: 'AGENTS.md', kind: 'unbased-divergence' }]);
  assert.deepEqual(await readFile(join(b.vaultPath, result.conflicts[0].conflictCopy)), remote);
  assert.deepEqual(await readFile(join(b.vaultPath, 'AGENTS.md')), Buffer.concat([template, Buffer.from('\nLocal customization.\n')]));
  assert.equal((await conflictCopiesBelow(b.vaultPath)).length, 1);
});
