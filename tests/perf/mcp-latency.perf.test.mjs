// SPDX-License-Identifier: MIT
// Performance suite: MCP write-lock wait bounds. Two real MCP server processes write the same vault; the tests
// compare measured waits with fixed bounds, so they run only in the `perf` CI job (`npm run test:perf`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK = '.brainatlas-write.lock';

async function fixture(t) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba25-conc-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(resolve(wiki, 'log.md'), '# Wiki log\n');
  await writeFile(resolve(wiki, 'index.md'), '# Wiki Index\n');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = false;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const start = async (name) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
      env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe'
    });
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(transport);
    t.after(async () => { await client.close(); });
    return client;
  };
  return { home, wiki, a: await start('ba25-a'), b: await start('ba25-b') };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: result.content[0].text, data: result.isError ? undefined : JSON.parse(result.content[0].text) };
}

async function ok(client, name, args = {}) {
  const result = await call(client, name, args);
  assert.equal(result.isError, false, result.text);
  return result.data;
}

test('a write lock left by a dead process is taken over at once', async (t) => {
  const { wiki, a } = await fixture(t);
  const { spawn } = await import('node:child_process');
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((done) => dead.on('exit', done));
  await writeFile(resolve(wiki, LOCK), JSON.stringify({ pid: dead.pid, time: Date.now(), token: 'x' }));
  const started = Date.now();
  await ok(a, 'wiki_create_entity', { name: 'After Crash', content: '---\ntitle: After Crash\n---\nz\n' });
  assert.ok(Date.now() - started < 4000, 'a dead holder must not block the write');
});

test('a fresh lock held by a live process makes writers wait, then refuse with E_BUSY', async (t) => {
  const { wiki, a } = await fixture(t);
  await writeFile(resolve(wiki, LOCK), JSON.stringify({ pid: process.pid, time: Date.now(), token: 'held' }));
  const started = Date.now();
  const result = await call(a, 'wiki_create_entity', { name: 'Blocked', content: '---\ntitle: Blocked\n---\nz\n' });
  const waited = Date.now() - started;
  assert.equal(result.isError, true);
  assert.ok(result.text.startsWith('E_BUSY:'), result.text);
  assert.ok(waited >= 4000 && waited < 15_000, `bounded wait expected, got ${waited} ms`);
  await assert.rejects(readFile(resolve(wiki, 'blocked.md'), 'utf8'), { code: 'ENOENT' }, 'nothing is written while busy');
  assert.equal(JSON.parse(await readFile(resolve(wiki, LOCK), 'utf8')).token, 'held', 'a live lock is not taken over');
});
