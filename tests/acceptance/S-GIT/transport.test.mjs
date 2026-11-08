// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from '../../../packages/core/src/util/index.mjs';
import { createGitTransport, activate } from '../../../modules/sync-git/src/index.mjs';

const bytes = (s) => Buffer.from(s);
const text = (o) => Buffer.from(o.bytes).toString();
const absentOrBytes = async (p) => readFile(p).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sgit-accept-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  const global = join(home, 'gitconfig'); await writeFile(global, '[user]\n\tname = isolated\n');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', BRAINATLAS_OFFLINE: '1' };
  const bare = join(root, 'remote.git');
  const init = await runCommand('git', ['init', '--bare', '--initial-branch=main', bare], { cwd: root, env });
  assert.equal(init.code, 0, init.stderr);
  const remote = pathToFileURL(bare).href;
  const make = (id, opts = {}) => createGitTransport({ stateDir: join(root, id, 'state'), remote, env, hostId: id, now: () => new Date('2026-01-02T03:04:05Z'), ...opts });
  return { root, home, env, global, remote, make };
}

test('activation, isolated clone, CAS create/update/delete and missing objects', async (t) => {
  const f = await fixture(t);
  const realConfig = join(homedir(), '.gitconfig'); const before = await absentOrBytes(realConfig);
  const vault = join(f.root, 'vault'); await mkdir(join(vault, '.git'), { recursive: true });
  const sentinel = join(vault, '.git', 'sentinel'); await writeFile(sentinel, 'vault-owned');
  const ctx = { config: { sync: { transport: 'git', options: { remote: f.remote } } }, paths: { stateDir: join(f.root, 'a', 'state') }, env: f.env };
  await activate(ctx); const a = ctx.transport; const b = f.make('b');
  assert.deepEqual(a.capabilities, { cas: true, mode: 'git' });
  assert.equal(await a.get('wiki/missing.md'), null);
  const r1 = (await a.put('wiki/a.md', bytes('first'), { ifAbsent: true })).rev;
  await assert.rejects(a.put('wiki/a.md', bytes('duplicate'), { ifAbsent: true }), { code: 'E_CONFLICT' });
  await assert.rejects(a.put('wiki/a.md', bytes('bad'), { ifRev: 'stale' }), { code: 'E_CONFLICT' });
  const r2 = (await a.put('wiki/a.md', bytes('second'), { ifRev: r1 })).rev;
  assert.notEqual(r1, r2); assert.deepEqual((await b.list('wiki/')).map(x => x.path), ['wiki/a.md']);
  assert.equal(text(await b.get('wiki/a.md')), 'second');
  await assert.rejects(b.delete('wiki/a.md', { ifRev: r1 }), { code: 'E_CONFLICT' });
  await b.delete('wiki/a.md', { ifRev: r2 }); await a.pull(); assert.equal(await a.get('wiki/a.md'), null);
  await assert.rejects(a.delete('wiki/a.md', { ifRev: r2 }), { code: 'E_NOT_FOUND' });
  assert.equal(await readFile(sentinel, 'utf8'), 'vault-owned');
  assert.equal((await lstat(join(f.root, 'a', 'state', 'sync', 'git', '.git'))).isDirectory(), true);
  assert.deepEqual(await absentOrBytes(realConfig), before);
  assert.equal(await readFile(f.global, 'utf8'), '[user]\n\tname = isolated\n');
  await assert.rejects(activate({}), { code: 'E_MODULE_CONTEXT' });
});

test('push race retries and both hosts retain independent updates', async (t) => {
  const f = await fixture(t); const seed = f.make('a'); const b = f.make('b');
  await seed.put('wiki/base.md', bytes('base'), { ifAbsent: true }); await b.list();
  let pushes = 0;
  const a = f.make('a', { runCommand: async (cmd, args, options) => {
    assert.equal(cmd, 'git'); assert.ok(Array.isArray(args));
    if (args.includes('push') && ++pushes === 1) await b.put('wiki/b.md', bytes('B'), { ifAbsent: true });
    return runCommand(cmd, args, options);
  } });
  await a.list(); await a.put('wiki/a.md', bytes('A'), { ifAbsent: true });
  assert.equal(pushes, 2); assert.deepEqual((await b.list('wiki/')).map(x => x.path), ['wiki/a.md', 'wiki/b.md', 'wiki/base.md']);
});

for (const [path, base, left, right, expected] of [
  ['wiki/index.md', '# Wiki Index\n\n## Notes\n\n- [Base](base.md)\n', '- [A](a.md)\n', '- [B](b.md)\n', ['a.md', 'b.md']],
  ['wiki/log.md', '# Wiki Log\n\nBase\n', '\nEntry A\n', '\nEntry B\n', ['Entry A', 'Entry B']],
]) test(`rebase conflict merges canonical ${path}`, async (t) => {
  const f = await fixture(t); const a = f.make('a'), b = f.make('b');
  const rev = (await a.put(path, bytes(base), { ifAbsent: true })).rev; await b.list();
  await a.put(path, bytes(base + left), { ifRev: rev }); await b.put(path, bytes(base + right), { ifRev: rev });
  const result = text(await b.get(path)); for (const term of expected) assert.ok(result.includes(term));
  assert.deepEqual((await a.list(path)).map(x => x.path), [path]); assert.equal(text(await a.get(path)), result);
});

test('ordinary conflicting edits preserve both values in a conflict copy', async (t) => {
  const f = await fixture(t); const a = f.make('a'), b = f.make('b');
  const rev = (await a.put('wiki/page.md', bytes('base'), { ifAbsent: true })).rev; await b.list();
  await a.put('wiki/page.md', bytes('remote'), { ifRev: rev }); await b.put('wiki/page.md', bytes('local'), { ifRev: rev });
  assert.equal(text(await b.get('wiki/page.md')), 'local');
  const paths = (await b.list('wiki/')).map(x => x.path); const copy = paths.find(p => p.includes('.conflict-'));
  assert.ok(copy); assert.equal(text(await b.get(copy)), 'remote');
});

test('offline blocks network remotes without calling runner but permits file remotes', async (t) => {
  const f = await fixture(t);
  for (const remote of ['https://example.invalid/repo', 'http://example.invalid/repo', 'ssh://example.invalid/repo', 'git@example.invalid:repo']) {
    let calls = 0; const a = f.make('offline', { remote, runCommand: async () => { calls++; throw Error('unexpected'); } });
    await assert.rejects(a.list(), { code: 'E_OFFLINE' }); assert.equal(calls, 0);
  }
  assert.deepEqual(await f.make('local').list(), []);
});

test('credential and content are absent from emitted error, logs and status on command failure', async (t) => {
  const f = await fixture(t); const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const remote = `https://user:${secret}@example.invalid/repo`; const logs = []; let calls = 0;
  const previousOffline = process.env.BRAINATLAS_OFFLINE; delete process.env.BRAINATLAS_OFFLINE;
  t.after(() => { if (previousOffline === undefined) delete process.env.BRAINATLAS_OFFLINE; else process.env.BRAINATLAS_OFFLINE = previousOffline; });
  const a = f.make('credential', { remote, env: { ...f.env, BRAINATLAS_OFFLINE: '0' }, runCommand: async (cmd, args, opts) => {
    calls++; assert.equal(cmd, 'git'); assert.ok(Array.isArray(args)); assert.ok(opts.env); return { code: 1, stdout: '', stderr: `fatal ${remote} ${secret}` };
  } });
  let error; try { await a.list(); } catch (e) { error = e; }
  assert.ok(error); assert.equal(calls, 1); logs.push(String(error), JSON.stringify(error), error.stack);
  for (const output of logs) assert.ok(!output.includes(secret));
  const b = f.make('content', { runCommand: async () => { throw Error(secret); } });
  await assert.rejects(b.put('wiki/a.md', bytes(secret), { ifAbsent: true }), (e) => !String(e.stack).includes(secret));
});

test('invalid paths and unsafe file symlinks do not reach outside the clone', async (t) => {
  const f = await fixture(t); const a = f.make('a');
  for (const path of ['', '../escape', 'wiki/../../escape', '/absolute', 'wiki//x', 'wiki/./x', '.git/config', 'x\\y', 'x\0y']) {
    await assert.rejects(a.put(path, bytes('x'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
  }
  await assert.rejects(a.put('wiki/valid.md', 'not bytes', {}), TypeError);
  await a.put('wiki/valid.md', bytes('ok'), { ifAbsent: true });
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'target.md'), 'unchanged');
  const clone = join(f.root, 'a', 'state', 'sync', 'git');
  await symlink(outside, join(clone, 'link'));
  await assert.rejects(a.put('link/target.md', bytes('changed'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
  assert.equal(await a.get('link/target.md'), null); assert.equal(await readFile(join(outside, 'target.md'), 'utf8'), 'unchanged');
});

test('a symlinked state directory cannot redirect writes outside its owned location', { skip: 'PM: the state ROOT itself (XDG_STATE_HOME / app state dir) may be a user-directed symlink (cross-track policy); symlinks INSIDE the sync clone are rejected (previous test).' }, async (t) => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
  const link = join(f.root, 'state-link'); await symlink(outside, link);
  const a = f.make('unused', { stateDir: link });
  await assert.rejects(a.put('wiki/a.md', bytes('x'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
  assert.equal(await absentOrBytes(join(outside, 'sync', 'git', 'wiki', 'a.md')), null);
});

test('runner implementation uses argv and disables shell expansion', async () => {
  const src = await readFile(new URL('../../../packages/core/src/util/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /spawn\(cmd,\s*args,\s*\{[^}]*shell:\s*false/s);
  await assert.rejects(runCommand('git', 'status', {}));
});

test('repeated rejected pushes stop after bounded retries and report conflict', async (t) => {
  const f = await fixture(t); const seed = f.make('a');
  await seed.put('wiki/base.md', bytes('base'), { ifAbsent: true });
  let pushes = 0;
  const a = f.make('a', { runCommand: async (cmd, args, opts) => {
    if (args.includes('push')) { pushes++; return { code: 1, stdout: '', stderr: 'non-fast-forward' }; }
    return runCommand(cmd, args, opts);
  } });
  await assert.rejects(a.put('wiki/second.md', bytes('second'), { ifAbsent: true }), { code: 'E_CONFLICT' });
  assert.equal(pushes, 3);
});
