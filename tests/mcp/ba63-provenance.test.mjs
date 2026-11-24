// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '@brainatlas/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function fixture(t) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba63-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  await mkdir(resolve(wiki, 'concepts'), { recursive: true });
  await writeFile(resolve(wiki, 'index.md'), '# Index\n');
  await writeFile(resolve(wiki, 'log.md'), '# Log\n');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')],
    cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ba63', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { wiki, client };
}
const ok = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};

test('BA-63: written pages gain generated but never a status; author fields and evidence are untouched', async (t) => {
  const { wiki, client } = await fixture(t);
  await ok(client, 'wiki_write_page', { path: 'concepts/a.md', content: '---\ntitle: A\n---\nBody A.\n' });
  const a = await readFile(resolve(wiki, 'concepts/a.md'), 'utf8');
  assert.match(a, /^generated: '?\d{4}-\d\d-\d\dT[^\n]*Z'?$/m);
  assert.doesNotMatch(a, /^status:/m);
  assert.doesNotMatch(a, /^(sources|verified|stale_after):/m);

  await ok(client, 'wiki_write_page', {
    path: 'concepts/b.md',
    content: '---\ntitle: B\nstatus: confirmed\ngenerated: "2026-01-01"\n---\nBody B.\n',
  });
  const b = await readFile(resolve(wiki, 'concepts/b.md'), 'utf8');
  assert.match(b, /^status: confirmed$/m);
  assert.match(b, /^generated: ['"]?2026-01-01['"]?$/m);
  assert.doesNotMatch(b, /proposed/);

  await ok(client, 'wiki_create_concept', { name: 'New Idea', content: 'Plain body.' });
  const created = await readFile(resolve(wiki, 'concepts/new-idea.md'), 'utf8');
  assert.doesNotMatch(created, /^status:/m);
  assert.match(created, /^generated: /m);
});

test('BA-63: patch updates keep existing frontmatter and add nothing', async (t) => {
  const { wiki, client } = await fixture(t);
  await writeFile(resolve(wiki, 'concepts/legacy.md'), '---\ntitle: Legacy\n---\nOld body.\n');
  await ok(client, 'wiki_update_page', { path: 'concepts/legacy.md', patch: { append: '\nMore.\n' } });
  const page = await readFile(resolve(wiki, 'concepts/legacy.md'), 'utf8');
  assert.doesNotMatch(page, /^(generated|status):/m);
  assert.match(page, /More\./);
});

test('BA-63: query results report provenance none, partial or full', async (t) => {
  const { wiki, client } = await fixture(t);
  const body = 'zephyrite quorum disk replication notes.\n';
  await writeFile(resolve(wiki, 'concepts/none.md'), `---\ntitle: None page zephyrite\n---\n${body}`);
  await writeFile(
    resolve(wiki, 'concepts/partial.md'),
    `---\ntitle: Partial page zephyrite\nstatus: proposed\n---\n${body}`
  );
  await writeFile(resolve(wiki, 'concepts/other.md'), '---\ntitle: Other\n---\ngarden tomatoes basil.\n');
  const result = await ok(client, 'wiki_query', { query: 'zephyrite quorum disk', provenance: true });
  const by = Object.fromEntries(result.results.map((row) => [row.path, row.provenance]));
  assert.equal(by['wiki/concepts/none.md'] ?? by['concepts/none.md'], 'none');
  assert.equal(by['wiki/concepts/partial.md'] ?? by['concepts/partial.md'], 'partial');
});

test('BA-63: without the provenance argument query rows keep their previous keys', async (t) => {
  const { wiki, client } = await fixture(t);
  await writeFile(resolve(wiki, 'concepts/x.md'), '---\ntitle: X zephyrite\n---\nzephyrite quorum disk.\n');
  const result = await ok(client, 'wiki_query', { query: 'zephyrite quorum disk' });
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((row) => !Object.hasOwn(row, 'provenance')));
});

test('BA-69: a page written without status keeps neutral ranking and no [unverified] class', async (t) => {
  const { wiki, client } = await fixture(t);
  await ok(client, 'wiki_write_page', {
    path: 'concepts/rank.md',
    content: '---\ntitle: Rank zephyrite\n---\nzephyrite quorum disk.\n',
  });
  await writeFile(resolve(wiki, 'concepts/old.md'), '---\ntitle: Old zephyrite\n---\nzephyrite quorum disk.\n');
  const result = await ok(client, 'wiki_query', { query: 'zephyrite quorum disk' });
  const rows = Object.fromEntries(result.results.map((row) => [row.path.replace(/^wiki\//, ''), row]));
  assert.ok(rows['concepts/rank.md'] && rows['concepts/old.md']);
  assert.equal(rows['concepts/rank.md'].trust, undefined);
  assert.ok(Math.abs(rows['concepts/rank.md'].score - rows['concepts/old.md'].score) < 1e-9);
});

test('BA-69: empty sources or verified do not count as provenance', async (t) => {
  const { wiki, client } = await fixture(t);
  await writeFile(
    resolve(wiki, 'concepts/empty.md'),
    '---\ntitle: Empty zephyrite\ngenerated: "2026-01-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: ""\n---\nzephyrite quorum disk.\n'
  );
  const result = await ok(client, 'wiki_query', { query: 'zephyrite quorum disk', provenance: true });
  const row = result.results.find((r) => r.path.endsWith('concepts/empty.md'));
  assert.equal(row.provenance, 'partial');
});
