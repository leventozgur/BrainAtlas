// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFile, runCommand } from '../../packages/core/src/util/index.mjs';
import { readModuleManifest, resolveModuleOrder } from '../../packages/core/src/modules/index.mjs';
import { createGitTransport, activate } from '../../modules/sync-git/src/index.mjs';

async function fixture(t) {
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
  const initialized = await runCommand('git', ['init', '--bare', '--initial-branch=main', bare], { cwd: root, env, timeoutMs: 10_000 });
  assert.equal(initialized.code, 0);
  const remote = pathToFileURL(bare).href;
  const create = (id, options = {}) => createGitTransport({
    stateDir: join(root, id, 'state'), remote, env, hostId: id, now: () => new Date('2026-11-08T10:11:12.000Z'), ...options,
  });
  return { root, home, env, bare, remote, create };
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

  const second = fx.create('worker-b');
  const rows = await second.list('wiki/');
  assert.deepEqual(rows.map(({ path }) => path), ['wiki/data.bin']);
  assert.equal(rows[0].rev, stored.rev);
  assert.equal((await second.status()).mode, 'git');
  await second.delete('wiki/data.bin', { ifRev: stored.rev });
  await first.pull();
  assert.equal(await first.get('wiki/data.bin'), null);
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
    { name: 'sync-engine', version: '0.1.0-dev', description: 'engine', requires: [], provides: ['sync'], profiles: ['full'], entry: 'src/index.mjs' },
  ]).map((item) => item.name), ['sync-engine', 'sync-git']);
  const ctx = {
    config: { sync: { transport: 'git', options: { remote: fx.remote } } },
    paths: { stateDir: join(fx.root, 'activated', 'state') }, env: fx.env, core: {},
  };
  await activate(ctx);
  assert.deepEqual(ctx.transport.capabilities, { cas: true, mode: 'git' });
  assert.deepEqual(await ctx.transport.list(), []);
});
