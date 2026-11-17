// SPDX-License-Identifier: MIT
// BA-32: wiki_read_page reads one section by anchor (path fragment, `anchor` and `maxChars`) and wiki_query has a compact
// (snippet-free) form. Hermetic: temporary vault, state and HOME directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { createServer } from '../../packages/mcp/src/index.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PAGE =
  '---\ntitle: Sections\n---\n# Alpha\nalpha body\n\n## Beta\nbeta body\n\n## Beta\nsecond beta\n\n```md\n## Fake\nfake\n```\n';

async function fixture(t, files) {
  const home = await mkdtemp(join(tmpdir(), 'ba32-mcp-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = join(home, 'vault'),
    wiki = join(vault, 'wiki'),
    state = join(home, 'state');
  await mkdir(join(wiki, 'concepts'), { recursive: true });
  await mkdir(state);
  await writeFile(join(wiki, 'log.md'), '# Wiki log\n');
  await writeFile(join(wiki, 'index.md'), '# Wiki Index\n');
  for (const [name, body] of Object.entries(files)) await writeFile(join(wiki, name), body);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.stateDir = state;
  const server = createServer({ config, paths: { vaultDir: vault, stateDir: state }, env: { HOME: home } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba32-section-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { wiki, client };
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

test('BA-32: without anchor and maxChars the wiki_read_page response is byte-identical to before', async (t) => {
  const { client } = await fixture(t, { 'concepts/section.md': PAGE });
  const result = await call(client, 'wiki_read_page', { path: 'concepts/section.md' });
  assert.equal(
    result.text,
    JSON.stringify({ path: 'wiki/concepts/section.md', content: PAGE, truncated: false, sha256: sha(PAGE) })
  );
});

test('BA-32: a path fragment or an anchor returns the matching section with its heading and path', async (t) => {
  const { client } = await fixture(t, { 'concepts/section.md': PAGE });
  const expected = {
    path: 'wiki/concepts/section.md',
    anchor: 'beta',
    heading: 'Beta',
    headingPath: 'Alpha > Beta',
    content: '## Beta\nbeta body',
    truncated: false,
    sha256: sha(PAGE),
  };
  assert.deepEqual(await ok(client, 'wiki_read_page', { path: 'concepts/section.md#beta' }), expected);
  assert.deepEqual(await ok(client, 'wiki_read_page', { path: 'concepts/section.md', anchor: '#beta' }), expected);
  assert.deepEqual(await ok(client, 'wiki_read_page', { path: 'concepts/section.md#beta', anchor: 'beta' }), expected);
});

test('BA-32: repeated headings get the -1 anchor and a heading inside a fence is not a section', async (t) => {
  const { client } = await fixture(t, { 'concepts/section.md': PAGE });
  const second = await ok(client, 'wiki_read_page', { path: 'concepts/section.md', anchor: 'beta-1' });
  assert.equal(second.heading, 'Beta');
  assert.equal(second.content, '## Beta\nsecond beta\n\n```md\n## Fake\nfake\n```');
  for (const anchor of ['fake', 'missing']) {
    const refused = await call(client, 'wiki_read_page', { path: 'concepts/section.md', anchor });
    assert.equal(refused.isError, true, anchor);
    assert.equal(refused.text, 'E_INVALID_INPUT: Unknown anchor.');
    assert.equal(refused.text.includes(PAGE), false);
  }
});

test('BA-32: a conflicting fragment/anchor, an empty anchor and an invalid maxChars are E_INVALID_INPUT', async (t) => {
  const { client } = await fixture(t, { 'concepts/section.md': PAGE });
  for (const args of [
    { path: 'concepts/section.md#alpha', anchor: 'beta' },
    { path: 'concepts/section.md', anchor: '#' },
    { path: 'concepts/section.md', anchor: '' },
    { path: 'concepts/section.md', anchor: 5 },
    { path: 'concepts/section.md#' },
    { path: 'concepts/section.md', anchor: 'beta', maxChars: 0 },
    { path: 'concepts/section.md', anchor: 'beta', maxChars: 20_001 },
    { path: 'concepts/section.md', anchor: 'beta', maxChars: 1.5 },
    { path: 'concepts/section.md', anchor: 'beta', maxChars: '100' },
  ]) {
    const refused = await call(client, 'wiki_read_page', args);
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.ok(refused.text.startsWith('E_INVALID_INPUT:'), refused.text);
  }
});

test('BA-32: path checks still run first for a section read', async (t) => {
  const { client } = await fixture(t, { 'concepts/section.md': PAGE });
  const refused = await call(client, 'wiki_read_page', { path: '../outside.md#alpha' });
  assert.equal(refused.isError, true);
  assert.ok(refused.text.startsWith('E_PATH_ESCAPE:'), refused.text);
  const lock = await call(client, 'wiki_read_page', { path: '.brainatlas-write.lock#alpha' });
  assert.equal(lock.isError, true);
  assert.ok(lock.text.startsWith('E_PATH_ESCAPE:'), lock.text);
});

test('BA-32: maxChars cuts with prefixKeepingPairs and never splits an astral pair', async (t) => {
  const astral = `# Astral\n${'a'.repeat(10)}😀${'b'.repeat(10)}\n`;
  const { client } = await fixture(t, { 'concepts/astral.md': astral });
  const read = await ok(client, 'wiki_read_page', { path: 'concepts/astral.md', anchor: 'astral', maxChars: 20 });
  assert.equal(read.content, `# Astral\n${'a'.repeat(10)}`);
  assert.equal(read.content.length, 19);
  assert.equal(read.truncated, true);
  assert.doesNotMatch(read.content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  const whole = await ok(client, 'wiki_read_page', { path: 'concepts/astral.md', anchor: 'astral' });
  assert.equal(whole.content, `# Astral\n${'a'.repeat(10)}😀${'b'.repeat(10)}`);
  assert.equal(whole.truncated, false);
});

test('BA-32: maxChars without an anchor cuts the whole file and keeps the previous response keys', async (t) => {
  const { client } = await fixture(t, { 'concepts/section.md': PAGE });
  const read = await ok(client, 'wiki_read_page', { path: 'concepts/section.md', maxChars: 10 });
  assert.deepEqual(Object.keys(read), ['path', 'content', 'truncated', 'sha256']);
  assert.equal(read.content, PAGE.slice(0, 10));
  assert.equal(read.truncated, true);
});

test('BA-32: compact drops only the snippet key; absent or false is unchanged', async (t) => {
  const { client } = await fixture(t, { 'concepts/term.md': '# Term\nzebrafish evidence note.\n' });
  const plain = await ok(client, 'wiki_query', { query: 'zebrafish' });
  assert.ok(plain.results.length > 0);
  assert.ok(plain.results.every((result) => typeof result.snippet === 'string'));
  const compact = await ok(client, 'wiki_query', { query: 'zebrafish', compact: true });
  assert.deepEqual(Object.keys(compact), Object.keys(plain));
  assert.equal(JSON.stringify(compact.results), JSON.stringify(plain.results.map(({ snippet, ...rest }) => rest)));
  const off = await ok(client, 'wiki_query', { query: 'zebrafish', compact: false });
  assert.equal(JSON.stringify(off), JSON.stringify(plain));
});

test('BA-32: the anchor a result reports reads back the section whose heading the pointer names', async (t) => {
  const { client } = await fixture(t, { 'concepts/term.md': '# Term\nzebrafish evidence note.\n' });
  const [hit] = (await ok(client, 'wiki_query', { query: 'zebrafish' })).results;
  assert.equal(hit.heading, 'Term');
  const section = await ok(client, 'wiki_read_page', { path: `${hit.path}#${hit.anchor}` });
  assert.equal(section.heading, hit.heading);
  assert.equal(section.content, hit.snippet);
});
