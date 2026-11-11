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
const page = (title, extra = '', body = 'evidence') => `---\ntype: entity\ntitle: ${title}\n${extra}---\n${body}\n`;

// Fixture: a small wiki with one indexed page, one new page and one new concept page.
async function fixture(t, { index, indexEol = '\n', withIndex = true } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), 'ba14-index-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  await mkdir(resolve(vault, 'wiki/entities'), { recursive: true });
  await mkdir(resolve(vault, 'wiki/concepts'), { recursive: true });
  await writeFile(resolve(vault, 'wiki/log.md'), '# Wiki log\n');
  await writeFile(resolve(vault, 'wiki/entities/sample-01.md'), page('Sample One'));
  await writeFile(resolve(vault, 'wiki/entities/new-page.md'), page('New Page', 'summary: "Yeni özet"\ntags:\n  - yeni\n'));
  await writeFile(resolve(vault, 'wiki/concepts/alpha.md'), page('Alpha [v2] (taslak)', 'description: "Açıklama"\n'));
  if (withIndex) await writeFile(resolve(vault, 'wiki/index.md'), index.replace(/\n/g, indexEol));
  const config = defaultConfig('lite');
  config.vault.path = vault;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'ba14-index-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { vault, client, indexPath: resolve(vault, 'wiki/index.md') };
}

async function updateIndex(client) {
  const result = await client.callTool({ name: 'wiki_update_index', arguments: {} });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

// Hand-edited index: a description paragraph, a blockquote note, a custom summary with tags, a stale entry,
// a non-entry line inside a category and a second hand-written category.
const handEdited = [
  '# Wiki Index',
  '',
  'Elle yazılmış giriş paragrafı.',
  '',
  '> Not satırı.',
  '',
  '## entities',
  '',
  '- [Sample One](entities/sample-01.md) — Elle yazılmış özet #manuel #ozel',
  '- [Silinmiş](entities/gone.md) — artık yok',
  'Serbest satır (giriş değil).',
  '',
  '## Özel Bölüm',
  '',
  'Metin.',
  ''
].join('\n');

// Expected result: stale entry removed; new entities page inserted after the last entities entry;
// new concept category appended at the end. Every other line is byte-identical.
const handEditedExpected = [
  '# Wiki Index',
  '',
  'Elle yazılmış giriş paragrafı.',
  '',
  '> Not satırı.',
  '',
  '## entities',
  '',
  '- [Sample One](entities/sample-01.md) — Elle yazılmış özet #manuel #ozel',
  '- [New Page](entities/new-page.md) — Yeni özet #yeni',
  'Serbest satır (giriş değil).',
  '',
  '## Özel Bölüm',
  '',
  'Metin.',
  '',
  '## concepts',
  '',
  '- [Alpha \\[v2\\] \\(taslak\\)](concepts/alpha.md) — Açıklama',
  ''
].join('\n');

test('wiki_update_index keeps a hand-edited index byte-identical except for entry lines', async (t) => {
  const f = await fixture(t, { index: handEdited });
  const result = await updateIndex(f.client);
  assert.deepEqual(result, { indexed: 3, added: 2, removed: 1 });
  assert.equal(await readFile(f.indexPath, 'utf8'), handEditedExpected);
});

test('wiki_update_index preserves CRLF line endings for kept and added lines', async (t) => {
  const f = await fixture(t, { index: handEdited, indexEol: '\r\n' });
  await updateIndex(f.client);
  assert.equal(await readFile(f.indexPath, 'utf8'), handEditedExpected.replace(/\n/g, '\r\n'));
});

test('wiki_update_index is idempotent once the index matches the pages', async (t) => {
  const f = await fixture(t, { index: handEdited });
  await updateIndex(f.client);
  const once = await readFile(f.indexPath, 'utf8');
  assert.deepEqual(await updateIndex(f.client), { indexed: 3, added: 0, removed: 0 });
  assert.equal(await readFile(f.indexPath, 'utf8'), once);
});

test('wiki_update_index without an index file rebuilds it from page frontmatter', async (t) => {
  const f = await fixture(t, { withIndex: false });
  assert.equal((await updateIndex(f.client)).indexed, 3);
  const text = await readFile(f.indexPath, 'utf8');
  assert.ok(text.startsWith('# Wiki Index\n'));
  assert.match(text, /\n## entities\n/);
  assert.match(text, /\n## concepts\n/);
  assert.match(text, /- \[Sample One\]\(entities\/sample-01\.md\)/);
});

test('wiki_update_index on an empty wiki writes a bare index', async (t) => {
  const f = await fixture(t, { withIndex: false });
  await rm(resolve(f.vault, 'wiki/entities'), { recursive: true });
  await rm(resolve(f.vault, 'wiki/concepts'), { recursive: true });
  assert.equal((await updateIndex(f.client)).indexed, 0);
  assert.equal(await readFile(f.indexPath, 'utf8'), '# Wiki Index\n');
});

test('wiki_update_index places pages under their folder heading across many categories without a trailing newline', async (t) => {
  const index = [
    '# Wiki Index',
    '',
    '## sources',
    '',
    '- [Old source](sources/gone-src.md) — stale',
    '- [External](https://example.com/a.md) — kept',
    '',
    '## queries',
    '',
    'Bu bölümde henüz giriş yok.',
    '',
    '## entities',
    '',
    '- [Sample One](entities/sample-01.md)'
  ].join('\n');
  const f = await fixture(t, { index });
  for (const [dir, name] of [['summaries', 's-1'], ['queries', 'q-1'], ['sources', 'src-1']]) {
    await mkdir(resolve(f.vault, 'wiki', dir), { recursive: true });
    await writeFile(resolve(f.vault, 'wiki', dir, `${name}.md`), page(`Title ${name}`));
  }
  assert.deepEqual(await updateIndex(f.client), { indexed: 6, added: 5, removed: 1 });
  const lines = (await readFile(f.indexPath, 'utf8')).split('\n');
  const section = {};
  let current = '';
  for (const line of lines) {
    const heading = line.match(/^## (.+)$/);
    if (heading) { current = heading[1]; section[current] = []; continue; }
    const entry = line.match(/^- \[.*\]\((.+?)\)/);
    if (entry && current) section[current].push(entry[1]);
  }
  assert.deepEqual(section.sources, ['https://example.com/a.md', 'sources/src-1.md']);
  assert.deepEqual(section.queries, ['queries/q-1.md']);
  assert.deepEqual(section.entities, ['entities/sample-01.md', 'entities/new-page.md']);
  assert.deepEqual(section.summaries, ['summaries/s-1.md']);
  assert.deepEqual(section.concepts, ['concepts/alpha.md']);
  assert.equal(lines.some((line) => line.includes('gone-src')), false);
  assert.ok(lines.includes('Bu bölümde henüz giriş yok.'));
  // The input had no trailing newline; the file keeps that style.
  assert.equal((await readFile(f.indexPath, 'utf8')).endsWith('\n'), false);
});
