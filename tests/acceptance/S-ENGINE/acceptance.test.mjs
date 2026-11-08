import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createMemoryTransport, createSyncEngine, commands, planScheduler, planSchedulerUninstall, mergeIndexThreeWay, mergeLogThreeWay, classifySyncError } from '../../../modules/sync-engine/src/index.mjs';

const fixed = () => new Date('2025-01-02T03:04:05Z');
const code = value => e => e.code === value;
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 's-engine-accept-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = createMemoryTransport();
  const logs = [];
  async function host(id, config = {}) {
    const vault = join(root, id, 'vault'), state = join(root, id, 'state');
    await mkdir(vault, { recursive: true });
    const engine = createSyncEngine({ vaultPath: vault, stateDir: state, transport, hostId: id, now: fixed, config, logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args), warn: (...args) => logs.push(args) } });
    return { vault, state, engine };
  }
  return { root, transport, logs, a: await host('a', options.config), b: await host('b', options.config) };
}
async function put(h, path, data) { const p = join(h.vault, path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); }
const read = (h, p) => readFile(join(h.vault, p), 'utf8');
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function allFiles(dir) { let out = []; for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await allFiles(p)); else if (e.isFile()) out.push(await readFile(p, 'utf8')); } return out; }

test('create, pull, modify, manifest v3 and peer command return path-only drift', async t => {
  const { a, b, transport } = await setup(t);
  const canary = ['private', 'body', 'canary'].join('_');
  await put(a, 'notes/a.md', canary); await a.engine.run(); await b.engine.run();
  assert.equal(await read(b, 'notes/a.md'), canary);
  const manifest = await a.engine.buildManifest(); assert.equal(manifest.version, 3); assert.equal(manifest.files[0].path, 'notes/a.md');
  const ctx = { config: { vault: { path: a.vault } }, paths: { stateDir: a.state }, transport };
  assert.equal((await commands.sync(ctx, { action: 'check', peer: b.state })).status, 'PASS');
  await put(a, 'notes/a.md', 'updated'); await a.engine.run();
  const drift = await commands.sync(ctx, { action: 'check', peer: b.state });
  assert.deepEqual(drift, { status: 'DRIFT', differences: [{ path: 'notes/a.md', kind: 'modified' }] });
  assert.ok(!JSON.stringify(drift).includes(canary)); await b.engine.run(); assert.equal(await read(b, 'notes/a.md'), 'updated');
  assert.equal((await a.engine.checkPeer(b.state)).status, 'PASS');
  assert.equal((await a.engine.checkPeer(join(a.state, 'missing'))).status, 'DRIFT');
});

test('divergent edits preserve both versions and record a content-free journal', async t => {
  const { a, b } = await setup(t); await put(a, 'note.md', 'base'); await a.engine.run(); await b.engine.run();
  const left = ['left', 'unique', 'content'].join('_'), right = ['right', 'unique', 'content'].join('_');
  await put(a, 'note.md', left); await put(b, 'note.md', right); await a.engine.run();
  const result = await b.engine.run(); assert.equal(result.status, 'CONFLICT'); assert.equal(await read(b, 'note.md'), right);
  assert.equal(result.conflicts.length, 1); assert.equal(await read(b, result.conflicts[0].conflictCopy), left);
  const journal = await readFile(b.engine.journalPath, 'utf8'); assert.match(journal, /conflict/); assert.ok(!journal.includes(left) && !journal.includes(right));
});

test('deletion requires approval and rejects unknown paths', async t => {
  const { a, b, transport } = await setup(t); await put(a, 'note.md', 'keep'); await a.engine.run(); await b.engine.run();
  await rm(join(a.vault, 'note.md')); const result = await a.engine.run(); assert.equal(result.pendingDeletes, 1);
  await b.engine.run(); assert.equal(await read(b, 'note.md'), 'keep'); assert.ok(await transport.get('note.md'));
  await assert.rejects(a.engine.approveDeletes(['missing.md']), code('E_NOT_FOUND'));
  await a.engine.approveDeletes(['note.md']); assert.equal(await transport.get('note.md'), null);
  await b.engine.run(); await assert.rejects(read(b, 'note.md'), code('ENOENT'));
});

test('secret and local scopes refuse upload and never expose canaries in output or state', async t => {
  const { a, b, transport, logs } = await setup(t, { config: { sync: { options: { localOnly: ['private/**'] } } } });
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const body = ['opaque', 'body', 'marker'].join('_');
  await put(a, 'secret.md', `token ${secret}`); await put(a, 'front.md', '---\nsync: local\n---\nlocal');
  await put(a, 'private/hidden.md', 'hidden'); await put(a, 'public.md', body);
  const result = await a.engine.run(); assert.ok(result.refused.some(r => r.path === 'secret.md' && r.ruleId));
  for (const path of ['secret.md', 'front.md', 'private/hidden.md']) assert.equal(await transport.get(path), null);
  assert.ok(await transport.get('public.md')); await b.engine.run(); assert.equal(await read(b, 'public.md'), body);
  const emitted = JSON.stringify([result, logs, await allFiles(a.state)]); assert.ok(!emitted.includes(secret)); assert.ok(!emitted.includes(body));
  await transport.put('remote-secret.md', Buffer.from(secret), { ifAbsent: true }); const remoteResult = await b.engine.run();
  assert.ok(remoteResult.refused.some(r => r.path === 'remote-secret.md')); await assert.rejects(read(b, 'remote-secret.md'), code('ENOENT'));
  assert.ok(!JSON.stringify([remoteResult, logs, await allFiles(b.state)]).includes(secret));
});

test('three-way index and log preserve distinct additions once on both hosts', async t => {
  const { a, b } = await setup(t);
  const bases = { 'wiki/index.md': '# Wiki Index\n\n## Notes\n\n- [Base](base.md)\n', 'wiki/log.md': '# Wiki Log\n\n## Base\nbase\n' };
  for (const [p, v] of Object.entries(bases)) await put(a, p, v);
  await a.engine.run(); await b.engine.run();
  await put(a, 'wiki/index.md', bases['wiki/index.md'] + '- [Alpha](alpha.md)\n');
  await put(b, 'wiki/index.md', bases['wiki/index.md'] + '- [Beta](beta.md)\n');
  await put(a, 'wiki/log.md', bases['wiki/log.md'] + '\n## Alpha\nalpha\n');
  await put(b, 'wiki/log.md', bases['wiki/log.md'] + '\n## Beta\nbeta\n');
  await a.engine.run(); const result = await b.engine.run(); assert.equal(result.merged, 2); await a.engine.run();
  for (const host of [a, b]) for (const [p, values] of [['wiki/index.md', ['alpha.md', 'beta.md']], ['wiki/log.md', ['## Alpha', '## Beta']]]) {
    const text = await read(host, p); for (const value of values) assert.equal(text.split(value).length - 1, 1);
  }
  const idx = mergeIndexThreeWay(bases['wiki/index.md'], bases['wiki/index.md'].replace('Base]', 'One]'), bases['wiki/index.md'].replace('Base]', 'Two]')); assert.ok(idx.conflicts.length); assert.equal(idx.content, null);
  const log = mergeLogThreeWay(bases['wiki/log.md'], bases['wiki/log.md'].replace('base\n', 'one\n'), bases['wiki/log.md'].replace('base\n', 'two\n')); assert.ok(log.conflicts.length); assert.equal(log.content, null);
});

test('interruption after one put recovers idempotently; CAS conflict is surfaced without overwrite', async t => {
  const { a, b, transport } = await setup(t); await put(a, 'one.md', 'one'); await put(a, 'two.md', 'two');
  await transport.injectFailure({ type: 'interruption', operation: 'put', after: 1 });
  await assert.rejects(a.engine.run(), code('E_INTERRUPTED')); assert.equal((await json(a.engine.journalPath)).phase, 'interrupted');
  await a.engine.run(); await a.engine.run(); await b.engine.run(); assert.equal(await read(b, 'one.md'), 'one'); assert.equal(await read(b, 'two.md'), 'two');
  await put(a, 'one.md', 'changed'); await transport.injectFailure({ type: 'conflict', operation: 'put' });
  const result = await a.engine.run(); assert.equal(result.status, 'CONFLICT'); assert.ok(result.conflicts.some(c => c.kind === 'cas-conflict'));
  assert.equal(Buffer.from((await transport.get('one.md')).bytes).toString(), 'one'); assert.equal(await read(a, 'one.md'), 'changed');
});

test('transport CAS, malformed paths and failure taxonomy', async () => {
  const tx = createMemoryTransport(); const payload = Buffer.from('x'); const { rev } = await tx.put('x.md', payload, { ifAbsent: true });
  await assert.rejects(tx.put('x.md', payload, { ifAbsent: true }), code('E_CONFLICT'));
  await assert.rejects(tx.delete('x.md', { ifRev: 'wrong' }), code('E_CONFLICT'));
  await tx.delete('x.md', { ifRev: rev }); assert.equal(await tx.get('x.md'), null);
  for (const p of ['../escape', '/absolute', 'a/../b', 'a//b', 'a\\b', '']) await assert.rejects(tx.put(p, payload, { ifAbsent: true }), code('E_INVALID_PATH'));
  await assert.rejects(tx.put('x.md', 'bad', {}), TypeError);
  for (const [type, expected] of [['network', 'E_NETWORK'], ['quota', 'E_QUOTA'], ['conflict', 'E_CONFLICT']]) { await tx.injectFailure({ type, operation: 'get' }); await assert.rejects(tx.get('x.md'), code(expected)); }
  assert.equal(classifySyncError({ code: 'ECONNRESET' }), 'E_NETWORK');
});

test('unsafe symlinks and malformed state do not write outside vault', async t => {
  const { root, a, transport } = await setup(t); const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'victim.md'), 'untouched');
  await symlink(outside, join(a.vault, 'link')); await transport.put('link/victim.md', Buffer.from('replacement'), { ifAbsent: true });
  await assert.rejects(a.engine.run(), code('E_INVALID_PATH')); assert.equal(await readFile(join(outside, 'victim.md'), 'utf8'), 'untouched');
  await rm(join(a.vault, 'link')); await mkdir(dirname(a.engine.manifestPath), { recursive: true }); await writeFile(a.engine.manifestPath, '{broken');
  await assert.rejects(a.engine.run(), code('E_STATE_INVALID')); assert.equal(await readFile(join(outside, 'victim.md'), 'utf8'), 'untouched');
});

test('scheduler generates plans and uninstall only, validates bounds and escapes XML', () => {
  let calls = 0; const paths = { binPath: '/tmp/bin & tool', stateDir: '/tmp/state', configDir: '/tmp/config' }; const runCommand = () => { calls++; };
  const mac = planScheduler({ platform: 'darwin', paths, intervalMin: 1, runCommand }); assert.match(mac.text, /bin &amp; tool/); assert.match(mac.text, /<integer>60<\/integer>/);
  const linux = planScheduler({ platform: 'linux', paths, intervalMin: 1440, runCommand }); assert.equal(linux.files.length, 2); assert.match(linux.text, /1440min/);
  assert.deepEqual(planSchedulerUninstall({ platform: 'linux', paths, runCommand }).files, linux.uninstall); assert.equal(calls, 0);
  for (const intervalMin of [0, 1441, 1.5]) assert.throws(() => planScheduler({ platform: 'linux', paths, intervalMin }), code('E_STATE_INVALID'));
  assert.throws(() => planScheduler({ platform: 'other', paths }), code('E_STATE_INVALID'));
});

test('public CLI sync check --peer reports PASS for equal host states', { skip: 'PM: module commands are loaded only from an installed release (Lite/Full separation); with no install the CLI correctly answers E_COMMAND_UNKNOWN. The public-CLI path is covered by E2E-FULL with an installed Full release.' }, async t => {
  const { root, a, b } = await setup(t); await put(a, 'note.md', 'same'); await a.engine.run(); await b.engine.run();
  const { main } = await import('../../../packages/cli/src/index.mjs');
  const fakeHome = join(root, 'home'); await mkdir(fakeHome);
  const env = { HOME: fakeHome, XDG_CONFIG_HOME: join(fakeHome, 'config'), XDG_DATA_HOME: join(fakeHome, 'data'), XDG_STATE_HOME: join(fakeHome, 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1' };
  await main(['sync', 'check', '--peer', b.state, '--json'], env);
});

test('three-way log accepts a change made by just one host', () => {
  const base = '# Wiki Log\n\n## Entry\noriginal\n';
  const changed = '# Wiki Log\n\n## Entry\nupdated\n';
  const merged = mergeLogThreeWay(base, changed, base);
  assert.deepEqual(merged.conflicts, []);
  assert.match(merged.content, /updated/);
  assert.doesNotMatch(merged.content, /original/);
});
