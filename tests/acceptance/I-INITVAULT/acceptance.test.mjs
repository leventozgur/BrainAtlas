// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolvePaths } from '@brainatlas/core';
import { cleanEnv } from '../../cli/clean-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function run(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', shell: false, timeout: 20_000 });
}

function assertJsonSuccess(result, label) {
  assert.equal(result.error, undefined, `${label} could not start`);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function treeSnapshot(base) {
  const files = new Map();
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name); const path = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await lstat(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(file, path);
      else files.set(path, sha(stat.isSymbolicLink() ? Buffer.from('symlink') : await readFile(file)));
    }
  }
  await visit(base);
  return files;
}

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'ba-i-initvault-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'); await mkdir(home);
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    PATH: process.env.PATH || '/usr/bin:/bin'
  });
  return { temp, home, env };
}

test('init creates a missing vault, plans without writes, is idempotent, and preserves user files', async t => {
  const f = await fixture(t); const vault = join(f.temp, 'new-vault');
  const planned = assertJsonSuccess(run(f.env, 'init', '--yes', '--vault', vault, '--plan', '--json'), 'init plan');
  assert.equal(planned.vault.path, vault);
  assert.ok(planned.vault.created.includes('wiki/index.md'));
  await assert.rejects(lstat(vault), { code: 'ENOENT' });

  const first = assertJsonSuccess(run(f.env, 'init', '--yes', '--vault', vault, '--json'), 'first init');
  assert.equal(first.vault.path, vault);
  assert.ok(first.vault.created.includes('wiki/index.md'));
  const before = await treeSnapshot(vault);
  assert.ok(before.has('wiki/index.md'));
  assert.ok(before.has('wiki/log.md'));
  assert.ok(before.has('planning/backlog.md'));
  assert.ok(before.has('AGENTS.md'));

  const second = assertJsonSuccess(run(f.env, 'init', '--yes', '--vault', vault, '--json'), 'second init');
  assert.deepEqual(second.vault.created, []);
  assert.deepEqual(await treeSnapshot(vault), before);

  const index = Buffer.from('# My vault\nKeep these bytes.\n');
  const custom = Buffer.from('# User instructions\nKeep this file.\n');
  await writeFile(join(vault, 'wiki/index.md'), index);
  await writeFile(join(vault, 'AGENTS.md'), custom);
  const userBefore = await treeSnapshot(vault);
  const withUserFiles = assertJsonSuccess(run(f.env, 'init', '--yes', '--vault', vault, '--json'), 'init with user files');
  assert.deepEqual(withUserFiles.vault.created, []);
  assert.deepEqual(await treeSnapshot(vault), userBefore);
  assert.deepEqual(await readFile(join(vault, 'wiki/index.md')), index);
  assert.deepEqual(await readFile(join(vault, 'AGENTS.md')), custom);
});

test('migrate accepts an unchanged init scaffold, replaces matching templates, and leaves source bytes intact', async t => {
  const f = await fixture(t); const source = join(f.temp, 'source-vault'); const target = join(f.temp, 'target-vault');
  await mkdir(join(source, 'wiki/entities'), { recursive: true }); await mkdir(join(source, 'planning'), { recursive: true });
  const pages = new Map([
    ['wiki/index.md', Buffer.from('# Imported index\n\nSee the imported page.\n')],
    ['wiki/entities/page.md', Buffer.from('# Imported page\n\nEvidence body.\n')],
    ['wiki/log.md', Buffer.from('# Imported log\n\nPrior event.\n')],
    ['planning/backlog.md', Buffer.from('# Imported planning\n\nOne item.\n')],
    ['AGENTS.md', Buffer.from('# Legacy policy\n\n## User instructions\nKeep my custom instruction.\n')]
  ]);
  for (const [relative, bytes] of pages) {
    await mkdir(dirname(join(source, relative)), { recursive: true });
    await writeFile(join(source, relative), bytes);
  }
  const sourceBefore = await treeSnapshot(source);
  const initialized = assertJsonSuccess(run(f.env, 'init', '--yes', '--vault', target, '--json'), 'target init');
  assert.ok(initialized.vault.created.includes('wiki/index.md'));

  const result = assertJsonSuccess(run(f.env, 'migrate', '--from', source, '--to', target, '--json'), 'migrate to initialized target');
  assert.equal(result.bodyHashMatch, true);
  for (const [relative, bytes] of pages) {
    if (relative === 'wiki/log.md' || relative === 'AGENTS.md') continue;
    assert.deepEqual(await readFile(join(target, relative)), bytes, relative);
  }
  const targetLog = await readFile(join(target, 'wiki/log.md'));
  assert.ok(targetLog.subarray(0, pages.get('wiki/log.md').length).equals(pages.get('wiki/log.md')));
  assert.match(await readFile(join(target, 'AGENTS.md'), 'utf8'), /Keep my custom instruction\./);
  assert.deepEqual(await treeSnapshot(source), sourceBefore);
});

test('migrate rejects user content beside an init scaffold without changing either vault', async t => {
  const f = await fixture(t); const source = join(f.temp, 'source-vault'); const target = join(f.temp, 'target-vault');
  await mkdir(join(source, 'wiki'), { recursive: true });
  await writeFile(join(source, 'wiki/index.md'), '# Source page\n');
  assertJsonSuccess(run(f.env, 'init', '--yes', '--vault', target, '--json'), 'target init');
  const userFile = join(target, 'wiki/entities', 'user-page.md');
  await writeFile(userFile, '# Keep this user page\n');
  const sourceBefore = await treeSnapshot(source); const targetBefore = await treeSnapshot(target);
  const rejected = run(f.env, 'migrate', '--from', source, '--to', target, '--json');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /E_TARGET_NOT_EMPTY/);
  assert.deepEqual(await treeSnapshot(source), sourceBefore);
  assert.deepEqual(await treeSnapshot(target), targetBefore);
});

test('two source CLI hosts initialize uncreated vaults and sync byte-equal pages with generated host IDs', async t => {
  const f = await fixture(t); const gitConfig = join(f.temp, 'git-config'); const remote = join(f.temp, 'sync-remote.git');
  await writeFile(gitConfig, '');
  const baseEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: f.temp,
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C'
  };
  const hosts = ['host-a', 'host-b'].map(name => {
    const home = join(f.temp, name);
    return {
      home,
      vault: join(f.temp, `${name}-vault`),
      env: cleanEnv({
        ...baseEnv,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state')
      })
    };
  });
  const sourceCli = join(root, 'packages/cli/bin/brainatlas.mjs');
  for (const host of hosts) {
    await mkdir(host.home, { recursive: true });
    const paths = resolvePaths({ platform: 'linux', env: host.env });
    await mkdir(paths.releasesDir, { recursive: true });
    await symlink(root, join(paths.releasesDir, 'i-initvault-e2e'));
    await symlink('releases/i-initvault-e2e', paths.currentDir);
    const initialized = assertJsonSuccess(run(host.env, 'init', '--profile', 'full', '--yes', '--vault', host.vault, '--json'), 'two-host init');
    assert.ok(initialized.vault.created.includes('wiki/index.md'));
    assert.equal(Object.hasOwn(host.env, 'BRAINATLAS_HOST_ID'), false);
  }

  const bare = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', '--quiet', remote], { cwd: root, env: hosts[0].env, encoding: 'utf8', shell: false });
  assert.equal(bare.status, 0, bare.stderr);
  const remoteUrl = pathToFileURL(remote).href;
  for (const host of hosts) {
    assert.equal(assertJsonSuccess(run(host.env, 'config', 'set', 'sync.transport', 'git', '--json'), 'transport config').action, 'config set');
    assert.equal(assertJsonSuccess(run(host.env, 'config', 'set', 'sync.options.remote', remoteUrl, '--json'), 'remote config').action, 'config set');
  }

  const sourcePage = Buffer.from('# Shared page\n\nSame bytes on both hosts.\n');
  const sourcePagePath = join(hosts[0].vault, 'wiki', 'entities', 'shared.md');
  await writeFile(sourcePagePath, sourcePage);
  for (const host of hosts) {
    const result = run(host.env, 'sync', 'run', '--json');
    const sync = assertJsonSuccess(result, 'sync run');
    assert.equal(sync.status, 'SYNCED');
    assert.match(result.stderr, /sync run completed/);
    assert.doesNotMatch(result.stdout, /sync run completed/);
  }
  assert.deepEqual(await readFile(join(hosts[1].vault, 'wiki', 'entities', 'shared.md')), sourcePage);

  const stateA = resolvePaths({ platform: 'linux', env: hosts[0].env }).stateDir;
  const stateB = resolvePaths({ platform: 'linux', env: hosts[1].env }).stateDir;
  const hostIdA = (await readFile(join(stateA, 'sync', 'host-id'), 'utf8')).trim();
  const hostIdB = (await readFile(join(stateB, 'sync', 'host-id'), 'utf8')).trim();
  assert.match(hostIdA, /^[a-f0-9]{32}$/);
  assert.match(hostIdB, /^[a-f0-9]{32}$/);
  assert.notEqual(hostIdA, hostIdB);
});
