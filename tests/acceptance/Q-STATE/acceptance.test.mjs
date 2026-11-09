// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../packages/mcp/src/index.mjs';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { resolvePaths } from '../../../packages/core/src/paths/index.mjs';
import { inventoryVault, resolveSyncScope } from '../../../modules/sync-engine/src/scope.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'q-state-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vault = join(base, 'vault');
  await cp(resolve('demo-vault'), vault, { recursive: true });
  const config = defaultConfig('lite'); config.vault.path = vault;
  return { base, vault, config };
}
async function tree(root, prefix = '') {
  const rows = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    rows.push(rel + (entry.isDirectory() ? '/' : ''));
    if (entry.isDirectory()) rows.push(...await tree(root, rel));
  }
  return rows.sort();
}
async function connect(t, options) {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'acceptance', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const call = (client, name, args) => client.callTool({ name, arguments: args });
const linuxEnv = (base) => ({ HOME: join(base, 'home'), XDG_STATE_HOME: join(base, 'state'), BRAINATLAS_PLATFORM: 'linux' });

test('implicit state: read operations preserve the entire vault tree; writes only add the requested page', async (t) => {
  const { base, vault, config } = await fixture(t);
  const env = linuxEnv(base), before = await tree(vault);
  const client = await connect(t, { config, paths: {}, env });
  assert.notEqual((await call(client, 'wiki_query', { query: 'synthetic evidence' })).isError, true);
  assert.notEqual((await call(client, 'wiki_status', {})).isError, true);
  assert.deepEqual(await tree(vault), before);
  assert.notEqual((await call(client, 'wiki_write_page', { path: 'entities/acceptance.md', content: '---\ntype: entity\ntitle: Acceptance\n---\nOrdinary evidence.' })).isError, true);
  assert.deepEqual(await tree(vault), [...before, 'wiki/entities/acceptance.md'].sort());
  assert.ok((await stat(join(resolvePaths({ env, platform: 'linux' }).stateDir, 'retrieval-index.json'))).isFile());
});

test('platform override and explicit state directory locate caches outside vault', async (t) => {
  const { base, vault, config } = await fixture(t);
  for (const platform of ['linux', 'darwin']) {
    const env = { ...linuxEnv(base), BRAINATLAS_PLATFORM: platform };
    const before = await tree(vault);
    const client = await connect(t, { config, paths: {}, env });
    assert.notEqual((await call(client, 'wiki_query', { query: 'evidence', limit: 0 })).isError, true);
    assert.ok((await stat(join(resolvePaths({ env, platform }).stateDir, 'retrieval-index.json'))).isFile());
    assert.deepEqual(await tree(vault), before);
  }
  const custom = join(base, 'custom-state');
  const client = await connect(t, { config, paths: { stateDir: custom }, env: linuxEnv(base) });
  assert.notEqual((await call(client, 'wiki_query', { query: 'evidence', limit: 20 })).isError, true);
  assert.ok((await stat(join(custom, 'retrieval-index.json'))).isFile());
  assert.throws(() => createServer({ config, paths: {}, env: { ...linuxEnv(base), BRAINATLAS_PLATFORM: 'unsupported' } }), { code: 'E_PLATFORM' });
});

test('missing HOME isolates each vault in private hashed temporary state', async (t) => {
  const a = await fixture(t), b = await fixture(t);
  const paths = [a, b].map(({ vault }) => join(tmpdir(), 'brainatlas-state', createHash('sha256').update(vault).digest('hex').slice(0, 16)));
  t.after(async () => { for (const path of paths) await rm(path, { recursive: true, force: true }); });
  assert.notEqual(paths[0], paths[1]);
  for (const [i, item] of [a, b].entries()) {
    const before = await tree(item.vault);
    const client = await connect(t, { config: item.config, paths: {}, env: {} });
    assert.notEqual((await call(client, 'wiki_query', { query: 'evidence' })).isError, true);
    assert.equal((await stat(paths[i])).mode & 0o777, 0o700);
    assert.ok((await stat(join(paths[i], 'retrieval-index.json'))).isFile());
    assert.deepEqual(await tree(item.vault), before);
  }
});

test('inventory excludes old caches and symlinks even under universal include', async (t) => {
  const { base, vault } = await fixture(t);
  const files = ['.brainatlas-state/old.md', 'nested/.brainatlas-state/deep/x.md', 'retrieval-index.json', 'nested/retrieval-index.json', 'semantic/item.md', 'nested/semantic/data.md', 'wiki/ordinary.md'];
  for (const path of files) { await mkdir(dirname(join(vault, path)), { recursive: true }); await writeFile(join(vault, path), 'ordinary content'); }
  const outside = join(base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'exposed.md'), 'outside');
  await symlink(outside, join(vault, 'linked-state'));
  await symlink(outside, join(vault, 'other', '.brainatlas-state')).catch(async (error) => { if (error.code !== 'ENOENT') throw error; await mkdir(join(vault, 'other')); await symlink(outside, join(vault, 'other', '.brainatlas-state')); });
  const result = await inventoryVault({ vaultPath: vault, config: { sync: { include: ['**/*'] } } });
  assert.ok(result.files.has('wiki/ordinary.md'));
  for (const path of files.slice(0, -1)) assert.equal(result.files.has(path), false, path);
  assert.equal([...result.files.keys()].some((path) => path.includes('exposed.md')), false);
  const explicit = await inventoryVault({ vaultPath: vault, stateDir: join(vault, 'wiki'), config: { sync: { include: ['**/*'] } } });
  assert.equal(explicit.files.has('wiki/ordinary.md'), false);
});

test('invalid sync paths fail closed; secret and unsafe MCP writes reveal no value or outside writes', async (t) => {
  const { base, vault, config } = await fixture(t);
  for (const pattern of ['../*', 'wiki/../*', 'wiki\\*.md', '/absolute', '', 4]) assert.throws(() => resolveSyncScope({ sync: { include: [pattern] } }), { code: 'E_STATE_INVALID' });
  await assert.rejects(inventoryVault({ vaultPath: join(base, 'missing') }), { code: 'E_NOT_FOUND' });
  const client = await connect(t, { config, paths: {}, env: linuxEnv(base) });
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const outside = join(base, 'outside.md'); await writeFile(outside, 'untouched');
  await symlink(outside, join(vault, 'wiki/entities/escape.md'));
  for (const [path, content] of [['../outside.md', 'plain'], ['entities\\escape.md', 'plain'], ['entities/escape.md', 'plain'], ['entities/secret.md', secret]]) {
    const response = await call(client, 'wiki_write_page', { path, content });
    assert.equal(response.isError, true, path);
    assert.equal(JSON.stringify(response).includes(secret), false);
  }
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  assert.equal((await readFile(join(vault, 'wiki/log.md'), 'utf8')).includes(secret), false);
});
