// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const page = (title) => `---\ntitle: ${title}\n---\nGövde.\n`;

async function fixture(t, files) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba14-fix2-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  const wiki = resolve(vault, 'wiki');
  await mkdir(wiki, { recursive: true });
  await writeFile(resolve(wiki, 'log.md'), '# Wiki log\n');
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(resolve(wiki, rel)), { recursive: true });
    await writeFile(resolve(wiki, rel), content);
  }
  const config = defaultConfig('lite');
  config.vault.path = vault;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'ba14-fix2-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { wiki, client };
}
async function update(client) {
  const r = await client.callTool({ name: 'wiki_update_index', arguments: {} });
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
}

test('fenced code blocks: a stale-looking entry inside a fence is neither removed nor counted, a fenced heading is not a heading', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n```\n- [Kod](entities/silinmis.md) — örnek\n```\n\n- [A](entities/a.md)\n';
  const f = await fixture(t, { 'entities/a.md': page('A'), 'index.md': index });
  assert.deepEqual(await update(f.client), { indexed: 1, added: 0, removed: 0 });
  assert.equal(await readFile(resolve(f.wiki, 'index.md'), 'utf8'), index);
});

test('fenced heading does not count as a category; new entry goes to a real heading or a new one after the fence', async (t) => {
  const index = '# Wiki Index\n\n## concepts\n\n~~~\n## entities\n- [X](entities/x.md)\n~~~\n';
  const f = await fixture(t, { 'entities/x.md': page('X'), 'index.md': index });
  assert.deepEqual(await update(f.client), { indexed: 1, added: 1, removed: 0 });
  const out = await readFile(resolve(f.wiki, 'index.md'), 'utf8');
  assert.equal(out, `${index}\n## entities\n\n- [X](entities/x.md)\n`);
});

test('a file that ends inside an open fence gets the new entry outside the fence', async (t) => {
  const index = '# Wiki Index\n\n## concepts\n\n```\ncode';
  const f = await fixture(t, { 'concepts/k.md': page('K'), 'index.md': index });
  assert.deepEqual(await update(f.client), { indexed: 1, added: 1, removed: 0 });
  const out = await readFile(resolve(f.wiki, 'index.md'), 'utf8');
  const fenceAt = out.indexOf('```\ncode');
  assert.ok(fenceAt > out.indexOf('- [K](concepts/k.md)'), 'entry must come before the open fence');
});

test('a page at the Wiki root is listed under the Pages category', async (t) => {
  const f = await fixture(t, { 'loose.md': page('Loose'), 'index.md': '# Wiki Index\n' });
  assert.deepEqual(await update(f.client), { indexed: 1, added: 1, removed: 0 });
  const out = await readFile(resolve(f.wiki, 'index.md'), 'utf8');
  assert.match(out, /## Pages\n\n- \[Loose\]\(loose\.md\)/);
  assert.equal(out.includes('## loose.md'), false);
});

test('parentheses in a page path: escaped form written, balanced unescaped form read as linked, second run adds nothing', async (t) => {
  const index = '# Wiki Index\n\n## entities\n\n- [C](entities/c(d).md) — elle\n';
  const f = await fixture(t, { 'entities/a(b).md': page('Parantezli'), 'entities/c(d).md': page('C'), 'index.md': index });
  assert.deepEqual(await update(f.client), { indexed: 2, added: 1, removed: 0 });
  const out = await readFile(resolve(f.wiki, 'index.md'), 'utf8');
  assert.ok(out.includes('- [Parantezli](entities/a\\(b\\).md)'), out);
  assert.ok(out.includes('- [C](entities/c(d).md) — elle'), 'existing balanced line is kept byte for byte');
  const after = await readFile(resolve(f.wiki, 'index.md'));
  assert.deepEqual(await update(f.client), { indexed: 2, added: 0, removed: 0 });
  assert.deepEqual(await readFile(resolve(f.wiki, 'index.md')), after);
});

test('wiki_update_page: a patch that is null or an array is refused with E_INVALID_INPUT', async (t) => {
  const f = await fixture(t, { 'entities/p.md': page('P') });
  for (const patch of [null, ['body']]) {
    const r = await f.client.callTool({ name: 'wiki_update_page', arguments: { path: 'entities/p.md', patch } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /E_INVALID_INPUT/);
  }
});
