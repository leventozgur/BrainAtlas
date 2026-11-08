// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signRelease } from '../../../release/sign.mjs';
import { createSyncEngine, createMemoryTransport } from '../../../modules/sync-engine/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
async function temp(t) { const p = await mkdtemp(join(tmpdir(), 'seed-blind-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }
async function put(p, data) { await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); }
function run(file, args, env, cwd) {
  const r = spawnSync(file, args, { env, cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.status, 0, `${file} ${args.slice(0, 2).join(' ')}: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
function json(s) { return JSON.parse(s.slice(s.indexOf('{'))); }
async function conflicts(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await conflicts(p));
    else if (e.name.includes('.conflict-')) out.push(p);
  }
  return out;
}

test('signed full release: two installed init hosts converge without a B push; edited seed conflicts', { timeout: 300000 }, async t => {
  const dir = await temp(t), out = join(dir, 'out'), key = join(dir, 'key'), signers = join(dir, 'signers'), remote = join(dir, 'remote.git');
  await mkdir(out);
  const common = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: join(dir, 'build-home'), TMPDIR: dir, BRAINATLAS_OFFLINE: '1', npm_config_offline: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  await mkdir(common.HOME); await writeFile(common.GIT_CONFIG_GLOBAL, '[user]\nname = Test\nemail = test@invalid\n');
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], common, dir);
  await writeFile(signers, `brainatlas-release ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
  run(process.execPath, [join(root, 'release/build-release.mjs'), '--version', '0.1.0-blind-seed', '--profile', 'full', '--out', out], common, dir);
  signRelease(key, join(out, 'SHA256SUMS'));
  run('git', ['init', '--bare', '--initial-branch=main', remote], common, dir);
  const archive = join(out, 'brainatlas-0.1.0-blind-seed-full.tgz');
  async function host(id) {
    const home = join(dir, id), vault = join(home, 'vault'); await mkdir(home);
    const env = { ...common, HOME: home, BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_HOST_ID: id, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state') };
    run('sh', [join(root, 'install.sh'), '--from', archive, '--profile', 'full', '--prefix-home', home, '--allowed-signers', signers, '--vault', vault, '--yes'], env, dir);
    const cli = join(home, 'data/brainatlas/current/packages/cli/bin/brainatlas.mjs');
    const call = (...args) => json(run(process.execPath, [cli, ...args, '--json'], env, dir));
    call('init', '--profile', 'full', '--yes', '--vault', vault);
    call('config', 'set', 'sync.transport', 'git'); call('config', 'set', 'sync.options.remote', pathToFileURL(remote).href);
    return { vault, call };
  }
  const a = await host('host-a'), b = await host('host-b'), c = await host('host-c');
  const files = ['AGENTS.md', 'wiki/index.md', 'wiki/log.md', 'planning/backlog.md'];
  for (const p of files) await put(join(a.vault, p), `# Shared ${p}\n\nRemote content.\n`);
  await put(join(a.vault, 'wiki/entities/example.md'), '# Example\n');
  await writeFile(join(c.vault, 'AGENTS.md'), Buffer.concat([await readFile(join(c.vault, 'AGENTS.md')), Buffer.from('x')]));
  assert.equal(a.call('sync', 'run').status, 'SYNCED');
  const head = run('git', ['--git-dir', remote, 'rev-parse', 'HEAD'], common, dir).trim();
  const result = b.call('sync', 'run');
  assert.equal(result.status, 'SYNCED'); assert.equal(result.pushed, 0); assert.equal(result.merged, 0); assert.deepEqual(result.conflicts, []);
  for (const p of files) assert.deepEqual(await readFile(join(b.vault, p)), await readFile(join(a.vault, p)), p);
  assert.deepEqual(await conflicts(b.vault), []);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'HEAD'], common, dir).trim(), head);
  const edited = c.call('sync', 'run'); assert.equal(edited.status, 'CONFLICT');
  const row = edited.conflicts.find(x => x.path === 'AGENTS.md'); assert.ok(row?.conflictCopy);
  assert.deepEqual(await readFile(join(c.vault, row.conflictCopy)), await readFile(join(a.vault, 'AGENTS.md')));
});

test('seed matching requires exact bytes, correct path, and absent base', async t => {
  const dir = await temp(t), tx = createMemoryTransport();
  const template = await readFile(join(root, 'templates/policy/AGENTS.md'));
  const remote = Buffer.from('# Remote policy\n');
  await tx.put('AGENTS.md', remote, { ifAbsent: true });
  for (const [id, local, expectConflict] of [['exact', template, false], ['extra-byte', Buffer.concat([template, Buffer.from(' ')]), true], ['empty', Buffer.alloc(0), true]]) {
    const vault = join(dir, id, 'vault'); await put(join(vault, 'AGENTS.md'), local);
    const result = await createSyncEngine({ vaultPath: vault, stateDir: join(dir, id, 'state'), transport: tx, hostId: id, env: { HOME: join(dir, id) } }).run();
    assert.equal(result.conflicts.some(x => x.path === 'AGENTS.md'), expectConflict, id);
    assert.deepEqual(await readFile(join(vault, 'AGENTS.md')), expectConflict ? local : remote);
  }
  const vault = join(dir, 'wrong-path/vault'); await put(join(vault, 'planning/backlog.md'), template);
  await tx.put('planning/backlog.md', Buffer.from('# Remote backlog\n'), { ifAbsent: true });
  const result = await createSyncEngine({ vaultPath: vault, stateDir: join(dir, 'wrong-path/state'), transport: tx, hostId: 'wrong-path', env: { HOME: dir } }).run();
  assert.ok(result.conflicts.some(x => x.path === 'planning/backlog.md'));
});

test('malformed state, traversal, symlink, transport errors and secret output are contained', async t => {
  const dir = await temp(t), vault = join(dir, 'vault'), state = join(dir, 'state'), tx = createMemoryTransport();
  await mkdir(vault); const logs = []; const logger = { info: (...x) => logs.push(x), error: (...x) => logs.push(x) };
  const engine = createSyncEngine({ vaultPath: vault, stateDir: state, transport: tx, hostId: 'blind', env: { HOME: dir }, logger });
  await assert.rejects(tx.put('../escape.md', Buffer.from('bad'), { ifAbsent: true }), { code: 'E_INVALID_PATH' });
  await put(join(state, 'sync/last-synced-manifest.json'), '{');
  await assert.rejects(engine.run(), { code: 'E_STATE_INVALID' });
  await rm(join(state, 'sync/last-synced-manifest.json'));
  const outside = join(dir, 'outside.md'); await writeFile(outside, 'untouched');
  await symlink(outside, join(vault, 'AGENTS.md'));
  await tx.put('AGENTS.md', Buffer.from('# Remote\n'), { ifAbsent: true });
  try { await engine.run(); } catch (e) { assert.equal(e.code, 'E_INVALID_PATH'); }
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  await rm(join(vault, 'AGENTS.md'));
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  await put(join(vault, 'wiki/entities/private.md'), `api_key: "${secret}"\n`);
  const result = await engine.run();
  assert.ok(result.refused.some(x => x.path === 'wiki/entities/private.md'));
  assert.ok(!JSON.stringify([result, logs]).includes(secret));
  assert.equal(await tx.inspect('wiki/entities/private.md'), null);
  await tx.injectFailure({ type: 'network', operation: 'list' });
  await assert.rejects(engine.run(), { code: 'E_NETWORK' });
});

test('a previously synced file reverted to seed is still a user edit', async t => {
  const dir = await temp(t), vault = join(dir, 'vault'), tx = createMemoryTransport();
  const template = await readFile(join(root, 'templates/policy/AGENTS.md'));
  const base = Buffer.from('# Initial shared policy\n'), next = Buffer.from('# Updated shared policy\n');
  const first = await tx.put('AGENTS.md', base, { ifAbsent: true });
  await mkdir(vault);
  const engine = createSyncEngine({ vaultPath: vault, stateDir: join(dir, 'state'), transport: tx, hostId: 'based', env: { HOME: dir } });
  assert.equal((await engine.run()).pulled, 1);
  await writeFile(join(vault, 'AGENTS.md'), template);
  await tx.put('AGENTS.md', next, { ifRev: first.rev });
  const result = await engine.run();
  const conflict = result.conflicts.find(x => x.path === 'AGENTS.md');
  assert.ok(conflict?.conflictCopy);
  assert.deepEqual(await readFile(join(vault, 'AGENTS.md')), template);
  assert.deepEqual(await readFile(join(vault, conflict.conflictCopy)), next);
});

test('untrusted remote traversal is ignored and cannot write outside vault', async t => {
  const dir = await temp(t), vault = join(dir, 'vault'), outside = join(dir, 'escape.md');
  await mkdir(vault); await writeFile(outside, 'safe');
  const tx = createMemoryTransport();
  const transport = { ...tx, list: async prefix => prefix ? [] : [{ path: '../escape.md', rev: 'x', size: 4 }], get: async () => ({ bytes: Buffer.from('evil'), rev: 'x' }) };
  const result = await createSyncEngine({ vaultPath: vault, stateDir: join(dir, 'state'), transport, hostId: 'traversal', env: { HOME: dir } }).run();
  assert.equal(result.pulled, 0); assert.equal(await readFile(outside, 'utf8'), 'safe');
});
