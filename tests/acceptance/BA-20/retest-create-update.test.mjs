// SPDX-License-Identifier: MIT
// BA-20 independent retest (blind, after fix1): wiki_create_entity / wiki_create_concept frontmatter and index lines, the
// unreadable-page case of wiki_update_index, and the refusal paths. Real stdio MCP server, temporary HOME and vault, no
// network, every value is fixed or built at run time. Refusal messages are checked for the absence of caller content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// BA20_TARGET=main runs the main checkout's server (executed only; every write goes to a temporary vault).
const ROOT = process.env.BA20_TARGET === 'main' ? resolve(WORKTREE, '..', '..', 'BrainAtlas') : WORKTREE;
const OPTS = { timeout: 60_000 };
const CONTROL_RE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]');

async function fixture(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ba20-retest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const vault = join(dir, 'vault');
  const wiki = join(vault, 'wiki');
  await mkdir(home);
  await mkdir(wiki, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(wiki, rel)), { recursive: true });
    await writeFile(join(wiki, rel), text);
  }
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = false;
  const configFile = join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'packages/mcp/bin/brainatlas-mcp.mjs')],
    cwd: ROOT,
    env: {
      HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
      BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? ''
    },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'ba20-retest', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { vault, wiki, client };
}

const call = (f, name, args) => f.client.callTool({ name, arguments: args });
const textOf = (r) => (r.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
const jsonOf = (r) => {
  assert.notEqual(r.isError, true, `unexpected refusal: ${textOf(r)}`);
  return JSON.parse(textOf(r));
};
const indexPath = (f) => join(f.wiki, 'index.md');
const indexText = (f) => readFile(indexPath(f), 'utf8');
const entryLines = (text) => text.split('\n').filter((line) => line.startsWith('- ['));

/** Byte snapshot of every entry under a directory (links recorded as links). */
async function snapshot(dir) {
  const out = {};
  async function walk(rel) {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = join(rel, entry.name);
      const abs = join(dir, child);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) out[child] = 'LINK';
      else if (st.isDirectory()) await walk(child);
      else out[child] = (await readFile(abs)).toString('base64');
    }
  }
  await walk('.');
  return out;
}

const page = (frontmatter, body = 'Gövde.\n') => `---\n${frontmatter}\n---\n${body}`;

/**
 * Creates the page through the tool in a fresh vault, then writes the same page bytes into a second fresh vault and
 * runs wiki_update_index there. Returns both index texts and the page bytes so the caller can compare the lines.
 */
async function createAndUpdate(t, { tool, name, content, relPath }) {
  const created = await fixture(t);
  const createdResult = jsonOf(await call(created, tool, { name, content }));
  assert.equal(createdResult.path, `wiki/${relPath}`);
  const pageBytes = await readFile(join(created.wiki, relPath));
  const fromCreate = await indexText(created);
  const scanned = await fixture(t, { [relPath]: pageBytes.toString('utf8') });
  jsonOf(await call(scanned, 'wiki_update_index', {}));
  const fromUpdate = await indexText(scanned);
  return { fromCreate, fromUpdate, pageBytes: pageBytes.toString('utf8') };
}

// ---- 1. create line equals the update line, for summary, description, tags and their combinations ----

const VARIANTS = [
  { label: 'summary with emoji', tool: 'wiki_create_entity', name: 'Ozet Sayfasi', relPath: 'entities/ozet-sayfasi.md',
    content: page('title: Baska\nsummary: Düz özet 🚀'), mustContain: 'Düz özet 🚀' },
  { label: 'description only', tool: 'wiki_create_entity', name: 'Aciklama Sayfasi', relPath: 'entities/aciklama-sayfasi.md',
    content: page('description: Açıklama metni ✅') },
  { label: 'tags only', tool: 'wiki_create_entity', name: 'Etiket Sayfasi', relPath: 'entities/etiket-sayfasi.md',
    content: page('tags: [alfa, beta]') },
  { label: 'summary + description + tags + title in content', tool: 'wiki_create_entity', name: 'Birlesik Sayfa', relPath: 'entities/birlesik-sayfa.md',
    content: page('title: Icerik Basligi\nsummary: "Özet: [x] (y)"\ndescription: Açıklama\ntags: [a, b]'), mustContain: 'Özet: [x] (y)' },
  { label: 'summary with a quoted colon and brackets (concept)', tool: 'wiki_create_concept', name: 'Kavram Ozeti', relPath: 'concepts/kavram-ozeti.md',
    content: page('summary: "a: b [c]"\ntags: [kavram]'), mustContain: 'a: b [c]' }
];

for (const v of VARIANTS) {
  test(`${v.tool} "${v.label}": create index line equals the update line for the same page`, OPTS, async (t) => {
    const { fromCreate, fromUpdate, pageBytes } = await createAndUpdate(t, v);
    const createLines = entryLines(fromCreate);
    assert.equal(createLines.length, 1, `one entry line, got ${JSON.stringify(createLines)}`);
    assert.deepEqual(createLines, entryLines(fromUpdate), 'create line and update line are byte-equal');
    assert.equal(fromCreate, fromUpdate, 'whole index is byte-equal on a fresh vault');
    if (v.mustContain) assert.ok(createLines[0].includes(v.mustContain), `line carries the summary: ${JSON.stringify(createLines[0])}`);
    assert.match(pageBytes, /^---\n/, 'the page has frontmatter on disk');
    assert.ok(!CONTROL_RE.test(createLines[0]), 'line has no control characters');
  });
}

test('create keeps summary, description and tags in the page frontmatter on disk', OPTS, async (t) => {
  const f = await fixture(t);
  jsonOf(await call(f, 'wiki_create_entity', { name: 'Alan Kontrol', content: page('summary: Özet\ndescription: Tanım\ntags: [x, y]') }));
  const onDisk = await readFile(join(f.wiki, 'entities/alan-kontrol.md'), 'utf8');
  assert.match(onDisk, /^summary: Özet$/m);
  assert.match(onDisk, /^description: Tanım$/m);
  assert.match(onDisk, /^tags:\n\s+- x\n\s+- '?y'?$/m, 'tags kept as a list (quoting by the serializer is not asserted)');
  assert.match(onDisk, /^title: Alan Kontrol$/m);
});

// ---- 2. no frontmatter in the content: behavior as before (name as label, no summary) ----

test('create without frontmatter in the content: name is the label, no summary suffix, body kept, update line equal', OPTS, async (t) => {
  const { fromCreate, fromUpdate, pageBytes } = await createAndUpdate(t, {
    tool: 'wiki_create_entity', name: 'Plain Page', content: 'Sadece gövde.\n', relPath: 'entities/plain-page.md'
  });
  assert.deepEqual(entryLines(fromCreate), ['- [Plain Page](entities/plain-page.md)']);
  assert.equal(fromCreate, fromUpdate);
  assert.match(pageBytes, /^title: Plain Page$/m, 'title is the create name');
  assert.match(pageBytes, /^type: entity$/m, 'default type is entity');
  assert.match(pageBytes, /Sadece gövde\./, 'body kept');
});

test('create concept without frontmatter: concept type default and plain label', OPTS, async (t) => {
  const f = await fixture(t);
  jsonOf(await call(f, 'wiki_create_concept', { name: 'Plain Concept', content: 'Gövde.\n' }));
  const page = await readFile(join(f.wiki, 'concepts/plain-concept.md'), 'utf8');
  assert.match(page, /^type: concept$/m);
  assert.deepEqual(entryLines(await indexText(f)), ['- [Plain Concept](concepts/plain-concept.md)']);
});

// ---- 3. broken frontmatter: E_INVALID_INPUT, nothing written, no caller content in the message ----

const BROKEN = [
  { label: 'unclosed flow list', content: '---\ntitle: X\ntags: [a, SENTINEL_TAG\n---\nSENTINEL_BODY\n' },
  { label: 'missing closing delimiter', content: '---\ntitle: X\nsummary: SENTINEL_SUM\nSENTINEL_BODY\n' },
  { label: 'duplicate key', content: '---\nsummary: SENTINEL_ONE\nsummary: SENTINEL_TWO\n---\nSENTINEL_BODY\n' }
];

for (const b of BROKEN) {
  test(`broken frontmatter (${b.label}) is E_INVALID_INPUT, writes nothing, message has no input`, OPTS, async (t) => {
    const f = await fixture(t, {
      'index.md': '# Wiki Index\n\n## Entities\n\n- [Mevcut](entities/mevcut.md)\n',
      'entities/mevcut.md': page('title: Mevcut'),
      'log.md': '# Wiki log\n'
    });
    const before = await snapshot(f.vault);
    const r = await call(f, 'wiki_create_entity', { name: 'Bozuk Girdi', content: b.content });
    assert.equal(r.isError, true, 'refused');
    const msg = textOf(r);
    assert.match(msg, /E_INVALID_INPUT/);
    for (const forbidden of ['SENTINEL', 'Bozuk Girdi', 'bozuk-girdi', 'tags', 'summary']) {
      assert.ok(!msg.includes(forbidden), `message must not include ${JSON.stringify(forbidden)}: ${msg}`);
    }
    assert.deepEqual(await snapshot(f.vault), before, 'vault bytes unchanged (index, log, pages)');
    await assert.rejects(lstat(join(f.wiki, 'entities/bozuk-girdi.md')), { code: 'ENOENT' });
  });
}

// ---- 4. title in the content does not change the create name ----

test('a title in the content does not replace the create name (page title and label)', OPTS, async (t) => {
  const f = await fixture(t);
  const res = jsonOf(await call(f, 'wiki_create_entity', { name: 'Create Adi', content: page('title: Icerik Basligi\nsummary: x') }));
  assert.equal(res.path, 'wiki/entities/create-adi.md');
  const onDisk = await readFile(join(f.wiki, 'entities/create-adi.md'), 'utf8');
  assert.match(onDisk, /^title: Create Adi$/m);
  assert.doesNotMatch(onDisk, /Icerik Basligi/);
  const lines = entryLines(await indexText(f));
  assert.deepEqual(lines, ['- [Create Adi](entities/create-adi.md) — x']);
});

// ---- 5. unreadable page (raw C0 in frontmatter) plus five normal pages ----

const BAD = '---\ntype: entity\ntitle: A\u0001B\n---\nG.\n';

test('unreadable page plus five normal pages: update succeeds, normal lines are right, unreadable page is one line; runs 2 and 3 are idempotent', OPTS, async (t) => {
  const files = { 'entities/bad.md': BAD };
  for (let i = 1; i <= 5; i++) files[`entities/n${i}.md`] = page(`title: Normal ${i}\nsummary: Özet ${i}`);
  const f = await fixture(t, files);
  const first = jsonOf(await call(f, 'wiki_update_index', {}));
  assert.deepEqual(first, { indexed: 6, added: 6, removed: 0 });
  const text = await indexText(f);
  for (let i = 1; i <= 5; i++) {
    assert.ok(text.split('\n').includes(`- [Normal ${i}](entities/n${i}.md) — Özet ${i}`), `normal page ${i} line`);
  }
  const badLines = entryLines(text).filter((line) => line.includes('entities/bad.md'));
  assert.equal(badLines.length, 1, 'unreadable page has exactly one line');
  assert.ok(badLines[0].startsWith('- ['), 'line has the entry shape');
  assert.ok(!CONTROL_RE.test(badLines[0]), 'unreadable page line has no raw control characters');
  assert.equal(entryLines(text).length, 6, 'six entry lines in total');
  for (let run = 2; run <= 3; run++) {
    const again = jsonOf(await call(f, 'wiki_update_index', {}));
    assert.deepEqual(again, { indexed: 6, added: 0, removed: 0 }, `run ${run}`);
    assert.equal(await indexText(f), text, `run ${run} keeps the index bytes`);
  }
});

// ---- 6. secret-shaped summary: refused, nothing written ----

// Built at run time from fragments; it matches the content rule for an Anthropic-style key but is not a credential.
const SECRET = ['sk', 'ant'].join('-') + '-' + 'Q'.repeat(24);

for (const tool of ['wiki_create_entity', 'wiki_create_concept']) {
  test(`${tool} with a secret-shaped summary is refused (E_SECRET_DETECTED), nothing is written, message has no value`, OPTS, async (t) => {
    const f = await fixture(t, {
      'index.md': '# Wiki Index\n\n## Entities\n\n- [Mevcut](entities/mevcut.md)\n',
      'entities/mevcut.md': page('title: Mevcut'),
      'log.md': '# Wiki log\n'
    });
    const before = await snapshot(f.vault);
    const r = await call(f, tool, { name: 'Sır Testi', content: page(`summary: ${SECRET}`) });
    assert.equal(r.isError, true, 'refused');
    const msg = textOf(r);
    assert.match(msg, /E_SECRET_DETECTED/);
    assert.ok(!msg.includes('QQQQ') && !msg.includes(SECRET), 'message does not echo the value');
    assert.deepEqual(await snapshot(f.vault), before, 'vault bytes unchanged');
  });
}
