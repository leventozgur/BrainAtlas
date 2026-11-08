// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { signRelease } from '../../../release/sign.mjs';
import { cleanEnv } from '../../cli/clean-env.mjs';
import { runCommand, atomicWriteFile } from '../../../packages/core/src/util/index.mjs';
import { createGitTransport, activate, commands as gitCommands } from '../../../modules/sync-git/src/index.mjs';
import { createFolderTransport } from '../../../modules/sync-folder/src/index.mjs';
import { commands as syncCommands, createMemoryTransport } from '../../../modules/sync-engine/src/index.mjs';
import { planMigration } from '../../../packages/cli/src/migrate.mjs';

async function fixture(t, head = 'main') {
  const root = await mkdtemp(join(tmpdir(), 's-ops-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_TERMINAL_PROMPT: '0', BRAINATLAS_OFFLINE: '0' };
  delete env.GIT_SSH_COMMAND; delete env.GIT_SSH;
  await writeFile(env.GIT_CONFIG_GLOBAL, '[user]\n name = Unwanted Global\n');
  const bare = join(root, 'remote.git');
  const init = await runCommand('git', ['init', '--bare', `--initial-branch=${head}`, bare], { cwd: root, env });
  assert.equal(init.code, 0, init.stderr);
  const remote = pathToFileURL(bare).href;
  const tx = (id, extra = {}) => createGitTransport({ stateDir: join(root, id, 'state'), remote, hostId: id, env, ...extra });
  const context = async (id, extra = {}) => {
    const vault = join(root, id, 'vault'), stateDir = join(root, id, 'state'); await mkdir(vault, { recursive: true });
    return { config: { vault: { path: vault }, sync: { transport: 'git', options: {} } }, paths: { stateDir }, transport: tx(id, extra), hostId: id, env };
  };
  return { root, home, env, bare, remote, tx, context };
}

test('empty bare remote: two hosts run, exchange updates, report JSON fields and protect vault Git', async t => {
  const f = await fixture(t), a = await f.context('alpha'), b = await f.context('beta');
  await mkdir(join(a.config.vault.path, '.git')); await writeFile(join(a.config.vault.path, '.git', 'sentinel'), 'keep');
  await writeFile(join(a.config.vault.path, 'page.md'), 'first\n');
  const before = await gitCommands.status(['--json'], a); assert.equal(before.initialized, false); assert.equal(before.lastSuccessfulSync, null);
  await syncCommands.sync(a, { action: 'run' }); await syncCommands.sync(b, { action: 'run' });
  assert.equal(await readFile(join(b.config.vault.path, 'page.md'), 'utf8'), 'first\n');
  await writeFile(join(b.config.vault.path, 'page.md'), 'second\n'); await syncCommands.sync(b, { action: 'run' }); await syncCommands.sync(a, { action: 'run' });
  assert.equal(await readFile(join(a.config.vault.path, 'page.md'), 'utf8'), 'second\n');
  const status = JSON.parse(JSON.stringify(await gitCommands.status(['--json'], a)));
  assert.deepEqual(Object.keys(status).sort(), ['ahead', 'behind', 'branch', 'clean', 'initialized', 'hostId', 'lastSuccessfulSync', 'mode', 'remote'].sort()); // PM: S-HOSTID acceptance adds hostId to git status
  assert.equal(status.branch, 'main'); assert.equal(status.remote, f.remote); assert.equal(status.ahead, 0); assert.equal(status.behind, 0); assert.equal(status.clean, true); assert.ok(Number.isFinite(Date.parse(status.lastSuccessfulSync)));
  await writeFile(join(a.paths.stateDir, 'sync/git/untracked'), 'dirty'); assert.equal((await gitCommands.status([], a)).clean, false);
  assert.throws(() => gitCommands.status(['--bad'], a), { code: 'E_ARGUMENT' });
  assert.equal(await readFile(join(a.config.vault.path, '.git/sentinel'), 'utf8'), 'keep');
  assert.equal(await readFile(f.env.GIT_CONFIG_GLOBAL, 'utf8'), '[user]\n name = Unwanted Global\n');
});

test('custom branch, author overrides, mismatched default and malformed branch', async t => {
  const f = await fixture(t, 'release'), a = f.tx('a', { branch: 'release', authorName: 'Robot', authorEmail: 'robot@brainatlas.invalid' });
  await a.put('a.md', Buffer.from('a'), { ifAbsent: true });
  const log = await runCommand('git', ['--git-dir', f.bare, 'log', '-1', '--format=%an%x00%ae'], { cwd: f.root, env: f.env });
  assert.equal(log.stdout.trim(), 'Robot\0robot@brainatlas.invalid');
  assert.equal(Buffer.from((await f.tx('b', { branch: 'release' }).get('a.md')).bytes).toString(), 'a');
  await assert.rejects(f.tx('wrong').list(), e => e.code === 'E_DEGRADED' && /branch/i.test(e.message));
  await assert.rejects(f.tx('invalid', { branch: '../bad' }).list(), { code: 'E_ARGUMENT' });
});

test('SSH subprocess is noninteractive, classifies host key failure and respects explicit command', async t => {
  const f = await fixture(t), bin = join(f.root, 'bin'); await mkdir(bin);
  const argv = join(f.root, 'argv'), prompt = join(f.root, 'prompt');
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGV_FILE"\nprintf "%s" "$GIT_TERMINAL_PROMPT" > "$PROMPT_FILE"\necho "Host key verification failed" >&2\nexit 255\n', { mode: 0o700 });
  const env = { ...f.env, PATH: `${bin}:${f.env.PATH}`, ARGV_FILE: argv, PROMPT_FILE: prompt };
  for (const [id, override] of [['default', undefined], ['custom', 'ssh -o ConnectTimeout=1']]) {
    const tx = f.tx(id, { remote: 'git@example.invalid:repo', env: { ...env, ...(override ? { GIT_SSH_COMMAND: override } : {}) } });
    await assert.rejects(tx.list(), e => ['E_AUTH', 'E_HOST_KEY'].includes(e.code));
    const args = await readFile(argv, 'utf8'); assert.equal(args.includes('BatchMode=yes'), !override); assert.equal(await readFile(prompt, 'utf8'), '0');
  }
});

test('HTTPS credentials never reach warning, status, command errors, journal or metrics', async t => {
  const f = await fixture(t), secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const remote = `https://user:${secret}@example.invalid/repo`, logs = [];
  const ctx = { config: { sync: { transport: 'git', options: { remote } }, vault: { path: join(f.root, 'vault') } }, paths: { stateDir: join(f.root, 'cred-state') }, env: f.env, logger: { warn: (...x) => logs.push(x), info: (...x) => logs.push(x), error: (...x) => logs.push(x) } };
  await mkdir(ctx.config.vault.path); await activate(ctx); assert.ok(logs.length); assert.ok(!JSON.stringify(logs).includes(secret));
  const status = await gitCommands.status(['--json'], ctx); assert.ok(!JSON.stringify(status).includes(secret));
  ctx.transport = createGitTransport({ stateDir: ctx.paths.stateDir, remote, env: f.env, runCommand: async () => ({ code: 1, stderr: `failed ${remote}`, stdout: '' }) });
  let error; try { await syncCommands.sync(ctx, { action: 'run' }); } catch (e) { error = e; }
  assert.ok(error); assert.ok(!JSON.stringify([String(error), error.stack, logs]).includes(secret));
  async function files(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await files(p)); else if (e.isFile()) out.push((await readFile(p)).toString()); } return out; }
  assert.ok(!JSON.stringify(await files(ctx.paths.stateDir)).includes(secret));
  const clean = { ...ctx, config: { ...ctx.config, sync: { transport: 'git', options: { remote: f.remote } } }, transport: undefined, logger: { warn: (...x) => logs.push(x) } }; const n = logs.length; await activate(clean); assert.equal(logs.length, n);
});

test('folder status explains degradation, normal transport does not; paths and symlinks stay scoped', async t => {
  const f = await fixture(t), vault = join(f.root, 'vault'), share = join(f.root, 'share'), outside = join(f.root, 'outside');
  await Promise.all([mkdir(vault), mkdir(share), mkdir(outside)]); await writeFile(join(outside, 'victim'), 'keep');
  const link = join(f.root, 'share-link'); await symlink(share, link); await symlink(outside, join(share, 'escape'));
  const transport = createFolderTransport({ path: link, vaultPath: vault });
  const ctx = { config: { vault: { path: vault } }, paths: { stateDir: join(f.root, 'state') }, transport };
  await transport.put('ok', Buffer.from('ok'), { ifAbsent: true });
  const status = await syncCommands.sync(ctx, { action: 'status' }); assert.equal(status.status, 'DEGRADED'); assert.match(status.degradedReason, /compare-and-swap/i);
  for (const path of ['../outside/victim', 'escape/victim']) await assert.rejects(transport.put(path, Buffer.from('bad'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
  assert.equal(await readFile(join(outside, 'victim'), 'utf8'), 'keep');
  assert.notEqual((await syncCommands.sync({ ...ctx, transport: createMemoryTransport() }, { action: 'status' })).status, 'DEGRADED');
});

test('atomic replacements keep previous bytes on rename failure for both transports', async t => {
  const f = await fixture(t), share = join(f.root, 'share'), vault = join(f.root, 'vault'); await mkdir(share); await mkdir(vault);
  const bad = (path, bytes, options) => atomicWriteFile(path, bytes, { ...options, fsOps: { ...fs, rename: async () => { throw Error('rename failure'); } } });
  const fs = await import('node:fs/promises');
  for (const kind of ['git', 'folder']) {
    const make = writer => kind === 'git' ? f.tx('atomic', { atomicWriter: writer }) : createFolderTransport({ path: share, vaultPath: vault, atomicWriter: writer });
    const good = make(atomicWriteFile), rev = (await good.put('file', Buffer.from('old'), { ifAbsent: true })).rev;
    await assert.rejects(make(bad).put('file', Buffer.from('new'), { ifRev: rev }), /rename failure/);
    assert.equal(Buffer.from((await good.get('file')).bytes).toString(), 'old');
  }
});

test('migration counts each root Git tree once, absent tree zero, and rejects nested destination', async t => {
  const f = await fixture(t), source = join(f.root, 'source'), target = join(f.root, 'target'); await mkdir(source);
  assert.equal((await planMigration(source, target)).summary.skipped.git, 0);
  await mkdir(join(source, '.git/objects/pack'), { recursive: true }); await writeFile(join(source, '.git/HEAD'), 'head'); await writeFile(join(source, '.git/objects/pack/data'), 'data');
  assert.equal((await planMigration(source, target)).summary.skipped.git, 1);
  await assert.rejects(planMigration(source, join(source, 'nested')), { code: 'E_TARGET_INVALID' });
});

test('installed CLI exposes Git JSON and folder degraded status without credential output', { timeout: 180_000 }, async t => {
  const f = await fixture(t), out = join(f.root, 'release'), key = join(f.root, 'key'), signers = join(f.root, 'signers'), vault = join(f.root, 'vault');
  await mkdir(out);
  const env = cleanEnv({ ...f.env, BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1', BRAINATLAS_ALLOWED_SIGNERS: signers, TMPDIR: f.root });
  const run = (file, args) => spawnSync(file, args, { cwd: process.cwd(), env, encoding: 'utf8', shell: false, maxBuffer: 4 * 1024 * 1024 });
  const success = r => { assert.equal(r.status, 0, `${r.stderr}${r.stdout}`); return r; };
  success(run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]));
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  const version = '0.1.0-sops.1';
  success(run(process.execPath, ['release/build-release.mjs', '--version', version, '--profile', 'full', '--out', out]));
  signRelease(key, join(out, 'SHA256SUMS'));
  success(run('sh', ['install.sh', '--from', join(out, `brainatlas-${version}-full.tgz`), '--profile', 'full', '--prefix-home', f.home, '--allowed-signers', signers, '--yes']));
  const cli = join(env.XDG_DATA_HOME, 'brainatlas/current/packages/cli/bin/brainatlas.mjs');
  const command = (...args) => run(process.execPath, [cli, ...args]);
  success(command('init', '--profile', 'full', '--yes', '--vault', vault, '--json'));
  success(command('config', 'set', 'sync.transport', 'git', '--json'));
  success(command('config', 'set', 'sync.options.remote', f.remote, '--json'));
  await mkdir(join(vault, 'wiki'), { recursive: true }); await writeFile(join(vault, 'wiki', 'sops.md'), '# Shared\n');
  success(command('sync', 'run', '--json'));
  const status = JSON.parse(success(command('sync', 'git', 'status', '--json')).stdout);
  assert.equal(status.branch, 'main'); assert.equal(status.remote, f.remote); assert.equal(status.clean, true); assert.equal(status.ahead, 0); assert.equal(status.behind, 0); assert.ok(status.lastSuccessfulSync);
  const share = join(f.root, 'share'); await mkdir(share);
  success(command('config', 'set', 'sync.transport', 'folder', '--json'));
  success(command('config', 'set', 'sync.options.path', share, '--json'));
  const folder = JSON.parse(success(command('sync', 'status', '--json')).stdout); assert.equal(folder.status, 'DEGRADED'); assert.match(folder.degradedReason, /compare-and-swap/i);
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-'); const remote = `https://user:${secret}@example.invalid/repo`;
  success(command('config', 'set', 'sync.transport', 'git', '--json'));
  const set = success(command('config', 'set', 'sync.options.remote', remote, '--json'));
  const check = command('sync', 'git', 'status', '--json');
  assert.ok(![set.stdout, set.stderr, check.stdout, check.stderr].join('').includes(secret));
});
