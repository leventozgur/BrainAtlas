// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFile, runCommand } from '../../packages/core/src/util/index.mjs';
import { readModuleManifest, resolveModuleOrder } from '../../packages/core/src/modules/index.mjs';
import { createGitTransport, activate, commands } from '../../modules/sync-git/src/index.mjs';
import { createSyncEngine } from '../../modules/sync-engine/src/engine.mjs';

async function fixture(t, remoteBranch = 'main') {
  const root = await mkdtemp(join(tmpdir(), 'sync-git-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    GIT_CONFIG_GLOBAL: join(home, 'global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  await writeFile(env.GIT_CONFIG_GLOBAL, '', { mode: 0o600 });
  const bare = join(root, 'remote.git');
  const initialized = await runCommand('git', ['init', '--bare', `--initial-branch=${remoteBranch}`, bare], { cwd: root, env, timeoutMs: 10_000 });
  assert.equal(initialized.code, 0);
  const remote = pathToFileURL(bare).href;
  const create = (id, options = {}) => createGitTransport({
    stateDir: join(root, id, 'state'), remote, env: { ...env, BRAINATLAS_HOST_ID: id }, now: () => new Date('2026-11-08T10:11:12.000Z'), ...options,
  });
  return { root, home, env, bare, remote, create };
}

function withoutOffline(env) { const copy = { ...env }; delete copy.BRAINATLAS_OFFLINE; return copy; }
function clearProcessOffline(t) {
  const previous = process.env.BRAINATLAS_OFFLINE;
  delete process.env.BRAINATLAS_OFFLINE;
  t.after(() => { if (previous === undefined) delete process.env.BRAINATLAS_OFFLINE; else process.env.BRAINATLAS_OFFLINE = previous; });
}

test('Git transport clones under sync state and provides object CAS over a local bare repository', async (t) => {
  const fx = await fixture(t);
  const vaultGit = join(fx.root, 'vault', '.git');
  await mkdir(vaultGit, { recursive: true });
  await writeFile(join(vaultGit, 'sentinel'), 'leave vault metadata alone\n');
  const first = fx.create('worker-a');
  await assert.rejects(first.get('.git/config'), { code: 'E_INVALID_PATH' });
  const empty = await first.list('wiki');
  assert.deepEqual(empty, []);
  const clonePath = join(fx.root, 'worker-a', 'state', 'sync', 'git');
  assert.equal((await lstat(clonePath)).isDirectory(), true);
  assert.equal(await readFile(join(vaultGit, 'sentinel'), 'utf8'), 'leave vault metadata alone\n');
  const payload = Uint8Array.from([0, 255, 1, 128, 42]);
  const stored = await first.put('wiki/data.bin', payload, { ifAbsent: true });
  assert.equal(stored.rev.length, 64);
  assert.deepEqual(Buffer.from((await first.get('wiki/data.bin')).bytes), Buffer.from(payload));
  await assert.rejects(first.put('wiki/data.bin', Buffer.from('stale'), { ifRev: 'old-revision' }), { code: 'E_CONFLICT' });
  await first.put('wiki/page.md', Buffer.from('# Shared page\n'), { ifAbsent: true });
  const author = await runCommand('git', ['--git-dir', fx.bare, 'log', '-1', '--format=%an%x00%ae'], { cwd: fx.root, env: fx.env });
  assert.equal(author.code, 0);
  assert.equal(author.stdout.trim(), 'BrainAtlas Sync (worker-a)\0sync@brainatlas.invalid');

  const second = fx.create('worker-b');
  const rows = await second.list('wiki/');
  assert.deepEqual(rows.map(({ path }) => path), ['wiki/data.bin', 'wiki/page.md']);
  assert.equal(rows[0].rev, stored.rev);
  assert.equal(Buffer.from((await second.get('wiki/page.md')).bytes).toString(), '# Shared page\n');
  assert.equal((await second.status()).mode, 'git');
  await second.delete('wiki/data.bin', { ifRev: stored.rev });
  await first.pull();
  assert.equal(await first.get('wiki/data.bin'), null);
});

test('configured branch is used for an empty remote and mismatched remote defaults fail clearly', async (t) => {
  const customFx = await fixture(t, 'release');
  const custom = customFx.create('custom-branch', { branch: 'release' });
  await custom.put('wiki/page.md', Buffer.from('release branch\n'), { ifAbsent: true });
  assert.equal((await custom.status()).branch, 'release');

  const mismatchFx = await fixture(t, 'legacy');
  const seed = join(mismatchFx.root, 'seed-repository');
  await mkdir(seed);
  const initialized = await runCommand('git', ['init', '--initial-branch=legacy', seed], { cwd: mismatchFx.root, env: mismatchFx.env });
  assert.equal(initialized.code, 0);
  await writeFile(join(seed, 'seed.md'), 'seed\n');
  for (const args of [
    ['-c', 'user.name=Seed Agent', '-c', 'user.email=seed@brainatlas.invalid', '-C', seed, 'add', '--all'],
    ['-c', 'user.name=Seed Agent', '-c', 'user.email=seed@brainatlas.invalid', '-C', seed, 'commit', '-m', 'seed'],
    ['-C', seed, 'remote', 'add', 'origin', mismatchFx.remote],
    ['-C', seed, 'push', 'origin', 'HEAD:refs/heads/legacy'],
  ]) {
    const result = await runCommand('git', args, { cwd: mismatchFx.root, env: mismatchFx.env });
    assert.equal(result.code, 0, result.stderr);
  }
  const mismatch = mismatchFx.create('wrong-default');
  await assert.rejects(mismatch.list(), (error) => error.code === 'E_DEGRADED' && /default branch does not match/.test(error.message));
});

test('Git uses configured commit identity and never reads or writes global Git configuration', async (t) => {
  const fx = await fixture(t);
  const originalConfig = '[user]\n\tname = Global Config Identity\n\temail = global@brainatlas.invalid\n';
  await writeFile(fx.env.GIT_CONFIG_GLOBAL, originalConfig);
  const commandEnvironments = [];
  const transport = fx.create('identity-host', {
    authorName: 'Configured Sync Agent', authorEmail: 'configured@brainatlas.invalid',
    runCommand: async (command, args, options) => {
      commandEnvironments.push(options.env);
      return runCommand(command, args, options);
    },
  });
  await transport.put('wiki/identity.md', Buffer.from('identity\n'), { ifAbsent: true });
  const author = await runCommand('git', ['--git-dir', fx.bare, 'log', '-1', '--format=%an%x00%ae'], { cwd: fx.root, env: fx.env });
  assert.equal(author.stdout.trim(), 'Configured Sync Agent\0configured@brainatlas.invalid');
  assert.ok(commandEnvironments.length > 0);
  assert.ok(commandEnvironments.every((env) => env.GIT_CONFIG_NOSYSTEM === '1'));
  assert.ok(commandEnvironments.every((env) => env.GIT_CONFIG_GLOBAL !== fx.env.GIT_CONFIG_GLOBAL));
  assert.equal(await readFile(fx.env.GIT_CONFIG_GLOBAL, 'utf8'), originalConfig);
});

test('Git status reports redacted remote, branch, counts, last sync and clean state', async (t) => {
  const fx = await fixture(t);
  const stateDir = join(fx.root, 'status-host', 'state');
  const transport = createGitTransport({ stateDir, remote: fx.remote, env: { ...fx.env, BRAINATLAS_HOST_ID: 'status-host' } });
  await transport.put('wiki/page.md', Buffer.from('page\n'), { ifAbsent: true });
  await mkdir(join(stateDir, 'sync'), { recursive: true });
  await writeFile(join(stateDir, 'sync', 'last-synced-manifest.json'), JSON.stringify({ generatedAt: '2026-11-08T10:11:12.000Z' }));
  const context = { config: { sync: { transport: 'git' } }, transport };
  const status = await commands.status(['--json'], context);
  assert.equal(status.mode, 'git');
  assert.equal(status.hostId, 'status-host');
  assert.equal(status.initialized, true);
  assert.equal(status.remote, fx.remote);
  assert.equal(status.branch, 'main');
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.equal(status.clean, true);
  assert.equal(status.lastSuccessfulSync, '2026-11-08T10:11:12.000Z');
  await writeFile(join(stateDir, 'sync', 'git', 'untracked'), 'dirty\n');
  assert.equal((await transport.status()).clean, false);
});

test('SSH invocation uses BatchMode, keeps terminal prompts disabled, and classifies host-key errors', async (t) => {
  clearProcessOffline(t);
  const fx = await fixture(t);
  const bin = join(fx.root, 'bin');
  await mkdir(bin);
  const argvFile = join(fx.root, 'ssh-argv.txt');
  const promptFile = join(fx.root, 'ssh-prompt.txt');
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$SSH_ARGV_FILE"\nprintf "%s" "$GIT_TERMINAL_PROMPT" > "$SSH_PROMPT_FILE"\nprintf "Host key verification failed.\\n" >&2\nexit 255\n', { mode: 0o700 });
  const cleanEnv = withoutOffline(fx.env);
  const env = { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, SSH_ARGV_FILE: argvFile, SSH_PROMPT_FILE: promptFile };
  const transport = createGitTransport({
    stateDir: join(fx.root, 'ssh-host', 'state'), remote: 'git@example.invalid:owner/repository.git', env,
  });
  await assert.rejects(transport.list(), { code: 'E_AUTH' });
  const argv = (await readFile(argvFile, 'utf8')).trim().split('\n');
  assert.ok(argv.includes('-o'));
  assert.ok(argv.includes('BatchMode=yes'));
  assert.equal(await readFile(promptFile, 'utf8'), '0');

  const customArgvFile = join(fx.root, 'ssh-custom-argv.txt');
  const custom = createGitTransport({
    stateDir: join(fx.root, 'ssh-custom-host', 'state'),
    remote: 'alias:owner/repository.git',
    env: { ...env, GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=yes', SSH_ARGV_FILE: customArgvFile },
  });
  await assert.rejects(custom.list(), { code: 'E_AUTH' });
  const customArgv = (await readFile(customArgvFile, 'utf8')).trim().split('\n');
  assert.ok(customArgv.includes('StrictHostKeyChecking=yes'));
  assert.equal(customArgv.includes('BatchMode=yes'), false);
});

test('credential-bearing HTTPS remotes warn without exposing credentials in status or errors', async (t) => {
  clearProcessOffline(t);
  const fx = await fixture(t);
  const username = 'token-user';
  const password = 'private-token-value';
  const queryToken = 'private-query-value';
  const remote = `https://${username}:${password}@example.invalid/repository.git?access_token=${queryToken}`;
  const warnings = [];
  const ctx = {
    config: { sync: { transport: 'git', options: { remote } } },
    paths: { stateDir: join(fx.root, 'https-host', 'state') }, env: fx.env,
    logger: { warn: (...values) => warnings.push(values) },
  };
  const runCommandFake = async (_command, args) => args.includes('check-ref-format')
    ? { code: 0, stdout: '', stderr: '' }
    : { code: 128, stdout: '', stderr: `Authentication failed for ${remote}` };
  await activate(ctx);
  assert.equal(warnings.length, 1);
  const status = await ctx.transport.status();
  const output = JSON.stringify({ warning: warnings, status });
  assert.match(output, /\[redacted\]/);
  for (const secret of [username, password, queryToken]) assert.equal(output.includes(secret), false);
  await assert.rejects(createGitTransport({
    stateDir: join(fx.root, 'https-failure', 'state'), remote, env: withoutOffline(fx.env), runCommand: runCommandFake,
  }).list(), (error) => error.code === 'E_AUTH' && !error.message.includes(password) && !error.message.includes(queryToken));

  const vaultPath = join(fx.root, 'https-vault'); const stateDir = join(fx.root, 'https-engine', 'state');
  await mkdir(vaultPath);
  const journalTransport = createGitTransport({ stateDir, remote, env: withoutOffline(fx.env), runCommand: runCommandFake });
  const logs = [];
  const engine = createSyncEngine({ vaultPath, stateDir, transport: journalTransport, logger: { info: (...values) => logs.push(values), warn: (...values) => logs.push(values), error: (...values) => logs.push(values) } });
  await assert.rejects(engine.run(), { code: 'E_AUTH' });
  const journal = await readFile(engine.journalPath, 'utf8');
  assert.match(journal, /"errorCode": "E_AUTH"/);
  for (const secret of [username, password, queryToken]) {
    assert.equal(journal.includes(secret), false);
    assert.equal(JSON.stringify(logs).includes(secret), false);
  }
});

test('a push race between two fake hosts retries after rebasing and retains both objects', async (t) => {
  const fx = await fixture(t);
  const seed = fx.create('worker-a');
  await seed.put('wiki/seed.md', Buffer.from('shared base\n'), { ifAbsent: true });
  const second = fx.create('worker-b');
  await second.list();
  let injected = false;
  let firstPushAttempts = 0;
  const first = fx.create('worker-a', {
    runCommand: async (command, args, options) => {
      if (command === 'git' && args.includes('push')) {
        firstPushAttempts += 1;
        if (!injected) {
          injected = true;
          await second.put('wiki/from-b.md', Buffer.from('from worker b\n'), { ifAbsent: true });
        }
      }
      return runCommand(command, args, options);
    },
  });
  await first.list();
  await first.put('wiki/from-a.md', Buffer.from('from worker a\n'), { ifAbsent: true });
  const rows = await first.list();
  assert.deepEqual(rows.map(({ path }) => path), ['wiki/from-a.md', 'wiki/from-b.md', 'wiki/seed.md']);
  assert.equal(firstPushAttempts, 2);
});

test('rebase conflicts use the sync engine three-way merge for canonical index data', async (t) => {
  const fx = await fixture(t);
  const first = fx.create('worker-a');
  const second = fx.create('worker-b');
  const base = '# Wiki Index\n\n## Notes\n\n- [Base](wiki/base.md)\n';
  const baseRev = (await first.put('wiki/index.md', Buffer.from(base), { ifAbsent: true })).rev;
  await second.list();
  const remoteText = `${base}- [Alpha](wiki/alpha.md)\n`;
  await first.put('wiki/index.md', Buffer.from(remoteText), { ifRev: baseRev });
  const localText = `${base}- [Beta](wiki/beta.md)\n`;
  const merged = await second.put('wiki/index.md', Buffer.from(localText), { ifRev: baseRev });
  const result = Buffer.from((await second.get('wiki/index.md')).bytes).toString('utf8');
  assert.match(result, /wiki\/alpha\.md/);
  assert.match(result, /wiki\/beta\.md/);
  assert.equal(merged.rev, (await second.get('wiki/index.md')).rev);
  assert.deepEqual((await first.list('wiki/index.md')).map(({ path }) => path), ['wiki/index.md']);
  const history = await runCommand('git', ['-C', join(fx.root, 'worker-b', 'state', 'sync', 'git'), 'rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: fx.root, env: fx.env });
  assert.equal(history.code, 0);
  assert.equal(history.stdout.trim().split(/\s+/).length, 3, 'resolution commit retains both host histories');
});

test('rebase conflicts use the sync engine three-way merge for canonical log data', async (t) => {
  const fx = await fixture(t);
  const first = fx.create('worker-a');
  const second = fx.create('worker-b');
  const base = '# Wiki Log\n\n2026-01-01: Base record\n';
  const baseRev = (await first.put('wiki/log.md', Buffer.from(base), { ifAbsent: true })).rev;
  await second.list();
  await first.put('wiki/log.md', Buffer.from(`${base}\n2026-01-02: Remote record\n`), { ifRev: baseRev });
  await second.put('wiki/log.md', Buffer.from(`${base}\n2026-01-03: Local record\n`), { ifRev: baseRev });
  const result = Buffer.from((await second.get('wiki/log.md')).bytes).toString('utf8');
  assert.match(result, /Remote record/);
  assert.match(result, /Local record/);
});

test('ordinary rebase conflicts keep local content and add a remote conflict copy', async (t) => {
  const fx = await fixture(t);
  const first = fx.create('worker-a');
  const second = fx.create('worker-b');
  const baseRev = (await first.put('wiki/page.md', Buffer.from('base\n'), { ifAbsent: true })).rev;
  await second.list();
  await first.put('wiki/page.md', Buffer.from('remote edit\n'), { ifRev: baseRev });
  await second.put('wiki/page.md', Buffer.from('local edit\n'), { ifRev: baseRev });
  assert.equal(Buffer.from((await second.get('wiki/page.md')).bytes).toString('utf8'), 'local edit\n');
  const rows = await second.list('wiki');
  const copy = rows.find(({ path }) => path.includes('.conflict-worker-b-'));
  assert.ok(copy);
  assert.equal(Buffer.from((await second.get(copy.path)).bytes).toString('utf8'), 'remote edit\n');
});

test('offline guard rejects network remotes before invoking Git', async (t) => {
  const fx = await fixture(t);
  let calls = 0;
  const transport = createGitTransport({
    stateDir: join(fx.root, 'offline', 'state'),
    remote: 'https://example.com/repository.git',
    env: { ...fx.env, BRAINATLAS_OFFLINE: '1' },
    runCommand: async (...args) => { calls += 1; return runCommand(...args); },
  });
  await assert.rejects(transport.list(), { code: 'E_OFFLINE' });
  assert.equal(calls, 0);
});

test('Git object atomic write failure keeps old bytes and removes its temporary file', async (t) => {
  const fx = await fixture(t);
  const seed=fx.create('atomic-failure');
  const prior=await seed.put('wiki/data.bin',Buffer.from('old complete'),{ifAbsent:true});
  const fsOps={...await import('node:fs/promises'), rename: async () => { throw new Error('injected rename failure'); }};
  const failingWriter=(target,bytes,options)=>atomicWriteFile(target,bytes,{...options,fsOps});
  const transport=fx.create('atomic-failure',{atomicWriter:failingWriter});
  await assert.rejects(transport.put('wiki/data.bin',Buffer.from('new complete'),{ifRev:prior.rev}),/injected rename failure/);
  const target=join(fx.root,'atomic-failure','state','sync','git','wiki','data.bin');
  assert.equal(await readFile(target,'utf8'),'old complete');
  assert.deepEqual(await readdir(join(fx.root,'atomic-failure','state','sync','git','wiki')),['data.bin']);
});

test('activation wires the selected Git transport into the sync engine context', async (t) => {
  const fx = await fixture(t);
  const manifest = readModuleManifest(new URL('../../modules/sync-git/', import.meta.url).pathname);
  assert.deepEqual(manifest.requires, ['sync-engine']);
  assert.deepEqual(resolveModuleOrder([
    manifest,
    { name: 'sync-engine', version: '0.1.0-rc.9', description: 'engine', requires: [], provides: ['sync'], profiles: ['full'], entry: 'src/index.mjs' },
  ]).map((item) => item.name), ['sync-engine', 'sync-git']);
  const ctx = {
    config: { sync: { transport: 'git', options: { remote: fx.remote } } },
    paths: { stateDir: join(fx.root, 'activated', 'state') }, env: fx.env, core: {},
  };
  await activate(ctx);
  assert.deepEqual(ctx.transport.capabilities, { cas: true, mode: 'git' });
  assert.deepEqual(await ctx.transport.list(), []);
});
