// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createSyncEngine } from '../../modules/sync-engine/src/index.mjs';
import {
  activate, commands, createCredentialStore, createDropboxTokenProvider, createDropboxTransport, enrollDropbox,
} from '../../modules/sync-dropbox/src/index.mjs';

function reply(status, body = null, headers = {}) {
  const values = new Headers(headers);
  const bytes = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(typeof body === 'string' ? body : '');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: values,
    async json() { if (body === null) throw new Error('no body'); return body; },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

function fakeDropbox({ pageSize = 2 } = {}) {
  const objects = new Map();
  const folders = new Set();
  const calls = [];
  let revision = 0;
  const notFound = () => reply(409, { error: { '.tag': 'path', path: { '.tag': 'not_found' } } });
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    const path = url.pathname;
    const args = options.headers?.['Dropbox-API-Arg'] ? JSON.parse(options.headers['Dropbox-API-Arg']) : JSON.parse(options.body || '{}');
    calls.push({ path, args, headers: options.headers, body: options.body });
    if (path.endsWith('/files/create_folder_v2')) {
      folders.add(args.path);
      return reply(200, { metadata: { path_display: args.path } });
    }
    if (path.endsWith('/files/list_folder')) {
      const entries = [...objects.entries()].filter(([key]) => key.startsWith('/BrainAtlas/')).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, row]) => ({ '.tag': 'file', path_display: key, rev: row.rev, size: row.bytes.byteLength }));
      const page = entries.slice(0, pageSize);
      return reply(200, { entries: page, has_more: entries.length > pageSize, cursor: entries.length > pageSize ? 'cursor-1' : undefined });
    }
    if (path.endsWith('/files/list_folder/continue')) {
      const entries = [...objects.entries()].filter(([key]) => key.startsWith('/BrainAtlas/')).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, row]) => ({ '.tag': 'file', path_display: key, rev: row.rev, size: row.bytes.byteLength }));
      return reply(200, { entries: entries.slice(pageSize), has_more: false });
    }
    if (path.endsWith('/files/download')) {
      const row = objects.get(args.path);
      if (!row) return notFound();
      return reply(200, row.bytes, { 'Dropbox-API-Result': JSON.stringify({ rev: row.rev }) });
    }
    if (path.endsWith('/files/upload')) {
      const existing = objects.get(args.path);
      if (args.mode['.tag'] === 'add' && existing) return reply(409, { error: { '.tag': 'path', path: { '.tag': 'conflict' } } });
      if (args.mode['.tag'] === 'update' && existing?.rev !== args.mode.update) return reply(409, { error: { '.tag': 'path', path: { '.tag': 'conflict' } } });
      if (args.mode['.tag'] === 'update' && !existing) return reply(409, { error: { '.tag': 'path', path: { '.tag': 'not_found' } } });
      revision += 1;
      const bytes = new Uint8Array(options.body);
      const rev = `r${revision}`;
      objects.set(args.path, { bytes, rev });
      return reply(200, { rev });
    }
    if (path.endsWith('/files/delete_v2')) {
      const existing = objects.get(args.path);
      if (!existing) return notFound();
      if (existing.rev !== args.parent_rev) return reply(409, { error: { '.tag': 'path', path: { '.tag': 'conflict' } } });
      objects.delete(args.path);
      return reply(200, { metadata: { path_display: args.path } });
    }
    return reply(404, {});
  };
  return { fetch, objects, calls };
}

function transportFor(fake) {
  return createDropboxTransport({ fetch: fake.fetch, getAccessToken: async () => 'test-access-token' });
}

test('Dropbox object transport paginates, maps paths, downloads bytes and uses CAS revisions', async () => {
  const fake = fakeDropbox({ pageSize: 1 });
  const transport = transportFor(fake);
  const first = await transport.put('wiki/a.md', Buffer.from('one'), { ifAbsent: true });
  const second = await transport.put('wiki/b.md', Buffer.from('two'), { ifAbsent: true });
  const rows = await transport.list('wiki/');
  assert.deepEqual(rows.map(({ path }) => path), ['wiki/a.md', 'wiki/b.md']);
  assert.ok(fake.calls.some(({ path }) => path.endsWith('/files/list_folder/continue')));
  assert.deepEqual(Buffer.from((await transport.get('wiki/a.md')).bytes).toString(), 'one');
  assert.equal((await transport.get('wiki/missing.md')), null);
  assert.ok(fake.calls.filter(({ path }) => path.endsWith('/files/upload')).every(({ args }) => args.autorename === false));
  assert.deepEqual(fake.calls.filter(({ path }) => path.endsWith('/files/upload')).map(({ args }) => args.mode), [
    { '.tag': 'add' }, { '.tag': 'add' },
  ]);
  await assert.rejects(transport.put('wiki/a.md', Buffer.from('stale'), { ifRev: 'stale-revision' }), { code: 'E_CONFLICT' });
  const updated = await transport.put('wiki/a.md', Buffer.from('updated'), { ifRev: first.rev });
  await transport.delete('wiki/b.md', { ifRev: second.rev });
  assert.equal((await transport.get('wiki/a.md')).rev, updated.rev);
  assert.equal(fake.calls.find(({ path }) => path.endsWith('/files/delete_v2')).args.parent_rev, second.rev);
  await assert.rejects(transport.get('../escape.md'), { code: 'E_INVALID_PATH' });
});

test('Dropbox API failures map to stable codes without response bodies or credentials', async () => {
  const cases = [
    { status: 401, headers: {}, code: 'E_AUTH' },
    { status: 429, headers: { 'retry-after': '17' }, code: 'E_QUOTA' },
    { status: 409, headers: {}, code: 'E_CONFLICT' },
  ];
  for (const item of cases) {
    const transport = createDropboxTransport({ fetch: async () => reply(item.status, { error_summary: 'private response content' }, item.headers), getAccessToken: async () => 'private-access-token' });
    await assert.rejects(transport.list(), (error) => {
      assert.equal(error.code, item.code);
      assert.doesNotMatch(error.message, /private|token|content/i);
      if (item.code === 'E_QUOTA') assert.equal(error.retryAfterSeconds, 17);
      return true;
    });
  }
  const network = createDropboxTransport({ fetch: async () => { throw new Error('private-access-token'); }, getAccessToken: async () => 'private-access-token' });
  await assert.rejects(network.list(), { code: 'E_NETWORK' });
});

test('PKCE enrollment exchanges the pasted code and stores tokens without returning them', async () => {
  let stored = null;
  let authorizeText = '';
  let tokenForm;
  const result = await enrollDropbox({
    appKey: 'sample-app-key',
    stdin: Readable.from(['authorization-code\n']),
    stdout: (text) => { authorizeText += text; },
    now: () => 1000,
    random: () => Buffer.from('a'.repeat(32)),
    credentialStore: { async set(value) { stored = value; } },
    fetch: async (_url, options) => {
      tokenForm = new URLSearchParams(options.body);
      return reply(200, { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
    },
  });
  const authorize = new URL(authorizeText.split('\n')[1]);
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('token_access_type'), 'offline');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(tokenForm.get('code'), 'authorization-code');
  assert.equal(tokenForm.get('grant_type'), 'authorization_code');
  assert.equal(tokenForm.get('code_verifier'), Buffer.from('a'.repeat(32)).toString('base64url'));
  assert.deepEqual(result, { status: 'ENROLLED' });
  assert.equal(JSON.parse(stored).accessToken, 'access-secret');
  assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret/);
});

test('expired access tokens refresh once and persist the replacement token', async () => {
  let stored = JSON.stringify({ version: 1, appKey: 'sample-app-key', accessToken: 'old-secret', refreshToken: 'refresh-secret', expiresAt: 1 });
  let refreshCount = 0;
  const getAccessToken = createDropboxTokenProvider({
    credentialStore: { async get() { return stored; }, async set(value) { stored = value; } },
    now: () => 10_000,
    fetch: async (_url, options) => {
      refreshCount += 1;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'refresh-secret');
      return reply(200, { access_token: 'new-secret', expires_in: 3600 });
    },
  });
  assert.deepEqual(await Promise.all([getAccessToken(), getAccessToken()]), ['new-secret', 'new-secret']);
  assert.equal(refreshCount, 1);
  assert.equal(JSON.parse(stored).accessToken, 'new-secret');
  assert.equal(JSON.parse(stored).refreshToken, 'refresh-secret');
});

test('OS credential helpers receive secret values through stdin and never in argv', async () => {
  const secret = 'credential-secret-value';
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return command === 'secret-tool' ? 'credential-secret-value\n' : 'credential-secret-value\n';
  };
  const linux = createCredentialStore({ platform: 'linux', runCommand });
  await linux.set(secret);
  assert.equal(await linux.get(), secret);
  await linux.delete();
  const mac = createCredentialStore({ platform: 'darwin', runCommand });
  await mac.set(secret);
  assert.equal(await mac.get(), secret);
  await mac.delete();
  assert.ok(calls.some(({ command }) => command === 'secret-tool'));
  assert.ok(calls.some(({ command }) => command === 'swift'));
  assert.ok(calls.filter(({ input }) => input).every(({ input }) => input.includes(secret)));
  assert.ok(calls.every(({ args }) => !args.includes(secret) && !args.join(' ').includes(secret)));
});

test('two hosts sync over the fake Dropbox API through the sync engine', async (t) => {
  const fake = fakeDropbox();
  const transport = transportFor(fake);
  const root = await mkdtemp(join(tmpdir(), 'sync-dropbox-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function host(name) {
    const vaultPath = join(root, name, 'vault');
    const stateDir = join(root, name, 'state');
    await mkdir(vaultPath, { recursive: true });
    return { vaultPath, stateDir, engine: createSyncEngine({ vaultPath, stateDir, transport, config: { sync: { options: {} } }, env: { BRAINATLAS_HOST_ID: name } }) };
  }
  const first = await host('replica-one');
  const second = await host('replica-two');
  await mkdir(join(first.vaultPath, 'wiki'), { recursive: true });
  await writeFile(join(first.vaultPath, 'wiki', 'page.md'), '# Shared\n');
  assert.equal((await first.engine.run()).pushed, 1);
  assert.equal((await second.engine.run()).pulled, 1);
  assert.equal(await readFile(join(second.vaultPath, 'wiki', 'page.md'), 'utf8'), '# Shared\n');
  await writeFile(join(first.vaultPath, 'wiki', 'page.md'), '# Updated\n');
  assert.equal((await first.engine.run()).pushed, 1);
  assert.equal((await second.engine.run()).pulled, 1);
  assert.equal(await readFile(join(second.vaultPath, 'wiki', 'page.md'), 'utf8'), '# Updated\n');
});

test('nested Dropbox sync command parses the explicit app-key option', async () => {
  let saved;
  const context = {
    credentialStore: { async set(value) { saved = value; } },
    stdin: Readable.from(['authorization-code\n']),
    stdout: () => {},
    fetch: async (_url, options) => {
      assert.equal(new URLSearchParams(options.body).get('client_id'), 'sample-app-key');
      return reply(200, { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
    },
  };
  assert.deepEqual(await commands.sync(['dropbox', 'enroll', '--app-key', 'sample-app-key'], context), { status: 'ENROLLED' });
  assert.equal(JSON.parse(saved).appKey, 'sample-app-key');
});

test('module activation installs the configured Dropbox object transport', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'sync-dropbox-state-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const fake = fakeDropbox();
  const context = {
    config: { sync: { transport: 'dropbox', options: { root: '/BrainAtlas' } } },
    paths: { stateDir: join(stateRoot, 'state') },
    env: {},
    credentialStore: { async get() { return JSON.stringify({ version: 1, appKey: 'sample-app-key', accessToken: 'active-token', refreshToken: 'refresh-token', expiresAt: Date.now() + 60_000_000 }); }, async set() {} },
    fetch: fake.fetch,
  };
  assert.equal(await activate(context), undefined);
  assert.equal(context.transport.capabilities.mode, 'object');
  assert.match(context.transport.hostId, /^[a-z0-9-]+$/);
  assert.deepEqual(await context.transport.list(), []);
});
