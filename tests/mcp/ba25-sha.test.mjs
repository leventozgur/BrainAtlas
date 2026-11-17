// SPDX-License-Identifier: MIT
// BA-25: wiki_read_page returns the SHA-256 of the file's bytes; wiki_update_page and wiki_write_page accept an optional
// expectedSha256. A mismatch (or a missing file with an expectation) is refused with E_CONFLICT before anything is written
// or logged. Calls without expectedSha256 behave as before. Real stdio MCP server, temporary HOME and vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const PAGE = '---\ntitle: Shared\n---\nAlpha body.\n';

async function fixture(t, { readOnly = false } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba25-sha-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  await mkdir(resolve(wiki, 'concepts'), { recursive: true });
  await writeFile(resolve(wiki, 'log.md'), '# Wiki log\n');
  await writeFile(resolve(wiki, 'index.md'), '# Wiki Index\n');
  await writeFile(resolve(wiki, 'concepts/shared.md'), PAGE);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = readOnly;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')],
    cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ba25-sha-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return { wiki, client, page: resolve(wiki, 'concepts/shared.md'), log: resolve(wiki, 'log.md') };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    text: result.content[0].text,
    data: result.isError ? undefined : JSON.parse(result.content[0].text),
  };
}

async function ok(client, name, args = {}) {
  const result = await call(client, name, args);
  assert.equal(result.isError, false, result.text);
  return result.data;
}

test('wiki_read_page returns the SHA-256 of the file bytes next to the content', async (t) => {
  const { client } = await fixture(t);
  const read = await ok(client, 'wiki_read_page', { path: 'concepts/shared.md' });
  assert.equal(read.path, 'wiki/concepts/shared.md');
  assert.equal(read.content, PAGE);
  assert.equal(read.truncated, false);
  assert.equal(read.sha256, sha(PAGE));
});

test('wiki_read_page hashes the whole file even when the content is truncated', async (t) => {
  const { wiki, client } = await fixture(t);
  const big = `---\ntitle: Big\n---\n${'x'.repeat(25_000)}\n`;
  await writeFile(resolve(wiki, 'concepts/big.md'), big);
  const read = await ok(client, 'wiki_read_page', { path: 'concepts/big.md' });
  assert.equal(read.truncated, true);
  assert.equal(read.sha256, sha(big));
});

test('wiki_update_page with a matching expectedSha256 writes and returns the new hash', async (t) => {
  const { client, page } = await fixture(t);
  const next = '---\ntitle: Shared\n---\nBeta body.\n';
  const result = await ok(client, 'wiki_update_page', {
    path: 'concepts/shared.md',
    content: next,
    expectedSha256: sha(PAGE),
  });
  assert.equal(result.updated, true);
  assert.equal(result.sha256, sha(next));
  assert.equal(await readFile(page, 'utf8'), next);
});

test('wiki_update_page with a stale expectedSha256 is refused and changes neither the page nor the log', async (t) => {
  const { client, page, log } = await fixture(t);
  const logBefore = await readFile(log, 'utf8');
  const result = await call(client, 'wiki_update_page', {
    path: 'concepts/shared.md',
    content: '---\ntitle: Shared\n---\nChanged body.\n',
    expectedSha256: sha('other'),
  });
  assert.equal(result.isError, true);
  assert.ok(result.text.startsWith('E_CONFLICT:'), result.text);
  assert.ok(!result.text.includes('Changed') && !result.text.includes(sha(PAGE)), 'no content or hash echo');
  assert.equal(await readFile(page, 'utf8'), PAGE);
  assert.equal(await readFile(log, 'utf8'), logBefore);
});

test('wiki_write_page with a matching expectedSha256 writes; a stale one is refused', async (t) => {
  const { client, page, log } = await fixture(t);
  const next = '---\ntitle: Shared\n---\nGamma.\n';
  const written = await ok(client, 'wiki_write_page', {
    path: 'concepts/shared.md',
    content: next,
    expectedSha256: sha(PAGE),
  });
  assert.equal(written.written, true);
  assert.equal(written.sha256, sha(next));
  const logBefore = await readFile(log, 'utf8');
  const refused = await call(client, 'wiki_write_page', {
    path: 'concepts/shared.md',
    content: PAGE,
    expectedSha256: sha(PAGE),
  });
  assert.equal(refused.isError, true);
  assert.ok(refused.text.startsWith('E_CONFLICT:'), refused.text);
  assert.equal(await readFile(page, 'utf8'), next);
  assert.equal(await readFile(log, 'utf8'), logBefore);
});

test('a missing page with an expectedSha256 is E_CONFLICT for both write tools and creates nothing', async (t) => {
  const { wiki, client } = await fixture(t);
  const upd = await call(client, 'wiki_update_page', {
    path: 'concepts/missing.md',
    content: PAGE,
    expectedSha256: sha(PAGE),
  });
  assert.ok(upd.isError && upd.text.startsWith('E_CONFLICT:'), upd.text);
  const wr = await call(client, 'wiki_write_page', {
    path: 'concepts/missing.md',
    content: PAGE,
    expectedSha256: sha(PAGE),
  });
  assert.ok(wr.isError && wr.text.startsWith('E_CONFLICT:'), wr.text);
  await assert.rejects(readFile(resolve(wiki, 'concepts/missing.md'), 'utf8'), { code: 'ENOENT' });
});

test('an expectedSha256 that is not a SHA-256 hex digest is refused as invalid input', async (t) => {
  const { client, page } = await fixture(t);
  const result = await call(client, 'wiki_update_page', {
    path: 'concepts/shared.md',
    content: PAGE,
    expectedSha256: 'abc',
  });
  assert.equal(result.isError, true);
  assert.equal(await readFile(page, 'utf8'), PAGE);
});

test('calls without expectedSha256 keep the previous behaviour, including overwrite of a changed page', async (t) => {
  const { client, page } = await fixture(t);
  const next = '---\ntitle: Shared\n---\nDelta.\n';
  const result = await ok(client, 'wiki_update_page', { path: 'concepts/shared.md', content: next });
  assert.equal(result.updated, true);
  assert.equal(result.sha256, undefined, 'no hash in the response without expectedSha256');
  assert.equal(await readFile(page, 'utf8'), next);
});

test('readOnly mode still offers no write tool, and wiki_read_page still returns the hash', async (t) => {
  const { client } = await fixture(t, { readOnly: true });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    'wiki_write_page',
    'wiki_update_page',
    'wiki_create_entity',
    'wiki_create_concept',
    'wiki_update_index',
  ]) {
    assert.ok(!names.includes(name), `${name} must not be offered in readOnly mode`);
  }
  const read = await ok(client, 'wiki_read_page', { path: 'concepts/shared.md' });
  assert.equal(read.sha256, sha(PAGE));
});
