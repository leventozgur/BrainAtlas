import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDropboxTransport, createCredentialStore, createDropboxTokenProvider, commands, activate } from '../../../modules/sync-dropbox/src/index.mjs';
import { createSyncEngine } from '../../../modules/sync-engine/src/index.mjs';
import { readModuleManifest, resolveProfileModules } from '../../../packages/core/src/modules/index.mjs';

const token = ['sk', 'test' + 'x'.repeat(24)].join('-');
const refresh = ['refresh', 'value' + 'z'.repeat(24)].join('-');
const isCode = code => e => e.code === code;
const reply = (status, body = {}, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body, arrayBuffer: async () => Uint8Array.from(body).buffer });
function server() {
  const objects = new Map(), calls = []; let seq = 0, failUpload = false;
  const missing = () => reply(409, { error_summary: 'path/not_found/' });
  const conflict = () => reply(409, { error: { '.tag': 'conflict' } });
  async function fetch(url, opts) {
    const endpoint = new URL(url).pathname; const args = JSON.parse(opts.headers['Dropbox-API-Arg'] ?? opts.body ?? '{}'); calls.push({ endpoint, args });
    if (endpoint.endsWith('/create_folder_v2')) return reply(200);
    if (endpoint.endsWith('/list_folder')) {
      const entries = [...objects].map(([path, v]) => ({ '.tag': 'file', path_display: path, rev: v.rev, size: v.bytes.length }));
      return reply(200, { entries: entries.slice(0, 1), has_more: entries.length > 1, cursor: 'next' });
    }
    if (endpoint.endsWith('/list_folder/continue')) return reply(200, { entries: [...objects].slice(1).map(([path, v]) => ({ '.tag': 'file', path_display: path, rev: v.rev, size: v.bytes.length })), has_more: false });
    if (endpoint.endsWith('/download')) { const v = objects.get(args.path); return v ? reply(200, v.bytes, { 'dropbox-api-result': JSON.stringify({ rev: v.rev }) }) : missing(); }
    if (endpoint.endsWith('/upload')) {
      const old = objects.get(args.path); if (failUpload) { failUpload = false; return conflict(); }
      if (args.mode['.tag'] === 'add' ? !!old : !old || old.rev !== args.mode.update) return conflict();
      const rev = `r${++seq}`; objects.set(args.path, { rev, bytes: Uint8Array.from(opts.body) }); return reply(200, { rev });
    }
    if (endpoint.endsWith('/delete_v2')) { const old = objects.get(args.path); if (!old || old.rev !== args.parent_rev) return conflict(); objects.delete(args.path); return reply(200); }
    throw new Error(`unexpected endpoint ${endpoint}`);
  }
  return { fetch, calls, objects, failNextUpload: () => { failUpload = true; } };
}
const transport = s => createDropboxTransport({ fetch: s.fetch, getAccessToken: async () => token });
async function files(dir) { const out = []; for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await files(p)); else if (e.isFile()) out.push(await readFile(p, 'utf8')); } return out; }

test('mock API: pagination, get, add/update/delete CAS and missing objects', async () => {
  const s = server(), tx = transport(s), b = Buffer.from('body'); assert.deepEqual(tx.capabilities, { cas: true, mode: 'object' });
  assert.equal(await tx.get('absent'), null); assert.deepEqual(await tx.list(), []);
  const { rev } = await tx.put('dir/a.md', b, { ifAbsent: true }); await tx.put('b.md', Buffer.from('b'), { ifAbsent: true });
  assert.deepEqual((await tx.list()).map(x => x.path), ['b.md', 'dir/a.md']); assert.equal((await tx.list('dir/')).length, 1);
  assert.ok(s.calls.some(x => x.endpoint.endsWith('/continue'))); assert.equal(Buffer.from((await tx.get('dir/a.md')).bytes).toString(), 'body');
  await assert.rejects(tx.put('dir/a.md', b, { ifAbsent: true }), isCode('E_CONFLICT'));
  await assert.rejects(tx.put('dir/a.md', b, { ifRev: 'stale' }), isCode('E_CONFLICT'));
  const next = await tx.put('dir/a.md', Buffer.from('new'), { ifRev: rev });
  await assert.rejects(tx.delete('dir/a.md', { ifRev: rev }), isCode('E_CONFLICT')); await tx.delete('dir/a.md', { ifRev: next.rev }); assert.equal(await tx.get('dir/a.md'), null);
  assert.ok(s.calls.some(x => x.endpoint.endsWith('/delete_v2') && x.args.parent_rev === next.rev));
});

test('invalid paths, inputs, malformed responses and error redaction', async () => {
  const s = server(), tx = transport(s); const n = s.calls.length;
  for (const path of ['', '../outside', '/absolute', 'a/../b', 'a//b', 'a\\b', 'a\0b']) await assert.rejects(tx.put(path, Buffer.from('x'), { ifAbsent: true }), isCode('E_INVALID_PATH'));
  assert.equal(s.calls.length, n); await assert.rejects(tx.put('x', 'bad'), TypeError); await assert.rejects(tx.delete('x', {}), isCode('E_CONFLICT'));
  for (const root of ['relative', '/a/../b', '/a//b']) assert.throws(() => createDropboxTransport({ fetch: s.fetch, getAccessToken: async () => token, root }), isCode('E_INVALID_PATH'));
  for (const [response, code] of [[reply(401, { error: token }), 'E_AUTH'], [reply(429, {}, { 'retry-after': '12' }), 'E_QUOTA'], [reply(200, { entries: 'broken' }), 'E_NETWORK']]) {
    const broken = createDropboxTransport({ fetch: async () => response, getAccessToken: async () => token });
    await assert.rejects(broken.list(), e => { assert.equal(e.code, code); assert.ok(!JSON.stringify(e).includes(token)); if (code === 'E_QUOTA') assert.equal(e.retryAfterSeconds, 12); return true; });
  }
  const broken = createDropboxTransport({ fetch: async () => { throw Error(token); }, getAccessToken: async () => token }); await assert.rejects(broken.list(), e => e.code === 'E_NETWORK' && !String(e).includes(token));
});

test('PKCE enrollment through module command and refresh with no token output', async () => {
  let stored, output = '', form; const store = { set: async s => { stored = s; }, get: async () => stored };
  const fetch = async (url, opts) => { form = new URLSearchParams(opts.body); return reply(200, { access_token: token, refresh_token: refresh, expires_in: 3600 }); };
  const result = await commands.dropbox(['enroll', '--app-key', 'user-key'], { credentialStore: store, fetch, stdin: 'authorization-code', stdout: { write: s => { output += s; } } });
  assert.deepEqual(result, { status: 'ENROLLED' }); const url = new URL(output.match(/https:\/\/\S+/)[0]);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(form.get('code_verifier')).digest('base64url')); assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('client_id'), 'user-key');
  assert.ok(!output.includes(token) && !output.includes(refresh)); assert.equal(JSON.parse(stored).refreshToken, refresh);
  let refreshForm; const provider = createDropboxTokenProvider({ credentialStore: store, now: () => Date.now() + 7200000, fetch: async (u, o) => { refreshForm = new URLSearchParams(o.body); return reply(200, { access_token: token, expires_in: 3600 }); } });
  assert.equal(await provider(), token); assert.equal(refreshForm.get('refresh_token'), refresh); assert.equal(refreshForm.get('grant_type'), 'refresh_token');
  await assert.rejects(commands.dropbox(['enroll'], { credentialStore: store, fetch, stdin: 'code', stdout: () => {} }), isCode('E_ARGUMENT'));
  await assert.rejects(commands.dropbox(['enroll', '--app-key', 'user-key'], { credentialStore: store, fetch: async () => reply(401, { error: token }), stdin: 'code', stdout: () => {} }), e => e.code === 'E_AUTH' && !String(e).includes(token));
  stored = '{broken'; await assert.rejects(createDropboxTokenProvider({ credentialStore: store, fetch })(), isCode('E_AUTH'));
});

test('macOS and Linux credential stores use stdin, redact failure and handle missing tools', async () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = []; const store = createCredentialStore({ platform, runCommand: async (cmd, args, opts) => { calls.push({ cmd, args, ...opts }); return token + '\n'; } });
    await store.set(token); assert.equal(await store.get(), token); await store.delete(); assert.ok(calls[0].input.includes(token)); assert.ok(!JSON.stringify(calls.map(x => [x.cmd, x.args])).includes(token));
    await assert.rejects(store.set(''), isCode('E_CREDENTIAL_STORE')); await assert.rejects(store.set('a\0b'), isCode('E_CREDENTIAL_STORE'));
    const unavailable = createCredentialStore({ platform, runCommand: async () => { throw Error(token); } }); await assert.rejects(unavailable.set(token), e => e.code === 'E_CREDENTIAL_STORE' && !String(e).includes(token));
  }
  assert.throws(() => createCredentialStore({ platform: 'unknown' }), isCode('E_CREDENTIAL_STORE'));
});

test('two hosts synchronize through Dropbox; CAS race preserves remote and local content, no credential leak', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dropbox-accept-')); t.after(() => rm(root, { recursive: true, force: true }));
  const s = server(), logs = []; const hosts = [];
  for (const id of ['a', 'b']) { const vault = join(root, id, 'vault'), state = join(root, id, 'state'); await mkdir(vault, { recursive: true }); const engine = createSyncEngine({ vaultPath: vault, stateDir: state, transport: transport(s), hostId: id, now: () => new Date('2025-01-02T03:04:05Z'), logger: { info: (...v) => logs.push(v), warn: (...v) => logs.push(v), error: (...v) => logs.push(v) } }); hosts.push({ vault, state, engine }); }
  const [a, b] = hosts; await writeFile(join(a.vault, 'note.md'), 'initial'); const first = await a.engine.run(); await b.engine.run(); assert.equal(await readFile(join(b.vault, 'note.md'), 'utf8'), 'initial');
  await writeFile(join(a.vault, 'note.md'), 'changed'); s.failNextUpload(); const conflict = await a.engine.run(); assert.equal(conflict.status, 'CONFLICT'); assert.ok(conflict.conflicts.some(c => c.kind === 'cas-conflict')); assert.equal(Buffer.from((await transport(s).get('note.md')).bytes).toString(), 'initial'); assert.equal(await readFile(join(a.vault, 'note.md'), 'utf8'), 'changed');
  await a.engine.run(); await b.engine.run(); assert.equal(await readFile(join(b.vault, 'note.md'), 'utf8'), 'changed');
  assert.ok(!JSON.stringify([first, conflict, logs, await files(a.state), await files(b.state)]).includes(token));
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'victim.md'), 'safe'); await symlink(outside, join(b.vault, 'link')); await transport(s).put('link/victim.md', Buffer.from('unsafe'), { ifAbsent: true }); await assert.rejects(b.engine.run(), isCode('E_INVALID_PATH')); assert.equal(await readFile(join(outside, 'victim.md'), 'utf8'), 'safe');
});

test('manifest profiles, dependency, activation and embedded key scan', async () => {
  const manifest = readModuleManifest('modules/sync-dropbox'); assert.deepEqual(manifest.profiles, ['full', 'custom']); assert.ok(manifest.requires.includes('sync-engine'));
  const engine = readModuleManifest('modules/sync-engine'); assert.ok(!resolveProfileModules('lite', [engine, manifest]).includes('sync-dropbox')); assert.ok(resolveProfileModules('full', [engine, manifest]).includes('sync-dropbox'));
  const ctx = { config: { sync: { transport: 'dropbox' } }, paths: {}, credentialStore: { get: async () => null, set: async () => {} }, fetch: async () => reply(401) }; await activate(ctx); assert.equal(ctx.transport.capabilities.cas, true);
  const other = { config: { sync: { transport: 'folder' } }, paths: {} }; await activate(other); assert.equal(other.transport, undefined);
  const sources = await files('modules/sync-dropbox/src'); for (const source of sources) assert.doesNotMatch(source, /(?:app[_-]?key|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_-]{8,}['"]/i);
});

test('built Full archive includes Dropbox and Lite archive excludes it', async t => {
  const { buildRelease } = await import('../../../release/build-release.mjs');
  const { gunzipSync } = await import('node:zlib');
  const root = await mkdtemp(join(tmpdir(), 'dropbox-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const [full] = await buildRelease({ version: 'acceptance', profile: 'full', out: root });
  const [lite] = await buildRelease({ version: 'acceptance', profile: 'lite', out: root });
  const fullTar = gunzipSync(await readFile(full)); const liteTar = gunzipSync(await readFile(lite));
  assert.ok(fullTar.includes(Buffer.from('modules/sync-dropbox/module.json')));
  assert.ok(!liteTar.includes(Buffer.from('modules/sync-dropbox/')));
});

test('Dropbox account root is a valid root path', { skip: 'PM: syncing the whole Dropbox account root is refused on purpose (safe default; migration plan requires a dedicated folder, default /BrainAtlas).' }, async () => {
  const s = server();
  const tx = createDropboxTransport({ fetch: s.fetch, getAccessToken: async () => token, root: '/' });
  await tx.put('note.md', Buffer.from('root'), { ifAbsent: true });
  assert.ok(s.objects.has('/note.md'));
});
