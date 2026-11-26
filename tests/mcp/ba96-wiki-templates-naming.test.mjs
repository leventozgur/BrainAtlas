// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { initVault } from '../../packages/core/src/vault/index.mjs';
import { callToolInProcess } from '../../packages/mcp/src/index.mjs';

const TYPES = {
  entity: { folder: 'entities', headings: ['## Identity', '## Current state', '## Evidence', '## History'] },
  concept: { folder: 'concepts', headings: ['## Summary', '## Current state', '## Evidence', '## History'] },
  source: { folder: 'sources', headings: ['## Source', '## Key points', '## Reliability'] },
  summary: { folder: 'summaries', headings: ['## Scope', '## Summary', '## Sources'] },
  query: { folder: 'queries', headings: ['## Question', '## Answer', '## Evidence'] },
};

async function fixture(t, mutate) {
  const base = await mkdtemp(join(tmpdir(), 'ba96-wiki-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await initVault(vault);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  if (mutate) mutate(config);
  return {
    vault,
    options: {
      config,
      paths: { vaultDir: vault, stateDir: join(home, 'state') },
      env: { HOME: home, BRAINATLAS_PLATFORM: 'linux' },
    },
  };
}

async function call(options, name, args = {}) {
  const result = await callToolInProcess(options, name, args);
  return { ...result, value: result.isError ? null : JSON.parse(result.text) };
}

async function ok(options, name, args = {}) {
  const result = await call(options, name, args);
  assert.equal(result.isError, false, result.text);
  return result.value;
}

const missing = async (file) => {
  try {
    await readFile(file, 'utf8');
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
};

test('BA96 templates have the standard frontmatter and type-specific headings', async () => {
  for (const [type, { headings }] of Object.entries(TYPES)) {
    const text = await readFile(resolve('templates/pages', `${type}.md`), 'utf8');
    assert.match(text, /^title: ""$/m);
    assert.match(text, new RegExp(`^type: ${type}$`, 'm'));
    assert.match(text, /^generated: ""$/m);
    assert.match(text, /^status: proposed$/m);
    assert.match(text, /^sources: \[\]$/m);
    assert.match(text, /^verified: \[\]$/m);
    assert.match(text, /^stale_after: P90D$/m);
    for (const heading of headings) assert.ok(text.includes(`\n${heading}\n`), `${type}: ${heading}`);
  }
});

test('BA96 wiki_create creates every type from its template when content is empty', async (t) => {
  const f = await fixture(t);
  for (const [type, { folder, headings }] of Object.entries(TYPES)) {
    const name = `Template ${type}`;
    const result = await ok(f.options, 'wiki_create', { type, name, content: '' });
    assert.equal(result.path, `wiki/${folder}/template-${type}.md`);
    assert.equal(result.created, true);
    const text = await readFile(join(f.vault, result.path), 'utf8');
    assert.match(text, new RegExp(`^type: ${type}$`, 'm'));
    assert.match(text, /^status: proposed$/m);
    assert.match(text, /^sources: \[\]$/m);
    assert.match(text, /^verified: \[\]$/m);
    assert.match(text, /^stale_after: P90D$/m);
    assert.match(text, /^generated: ['"]?\d{4}-\d\d-\d\dT/m);
    for (const heading of headings) assert.ok(text.includes(`\n${heading}\n`), `${type}: ${heading}`);
    assert.match(
      await readFile(join(f.vault, 'wiki/index.md'), 'utf8'),
      new RegExp(`\\(${folder}/template-${type}\\.md\\)`)
    );
  }
});

test('BA96 frontmatter-only content keeps the template body and its frontmatter wins key by key', async (t) => {
  const f = await fixture(t);
  const result = await ok(f.options, 'wiki_create', {
    type: 'source',
    name: 'Evidence Source',
    content:
      '---\ntitle: Edited Source\nstatus: confirmed\nsources:\n  - wiki/raw/report.md\nverified:\n  - date: "2026-11-01"\n    evidence: Report\n    scope: claim\n    source: wiki/raw/report.md\nstale_after: P30D\n---\n',
  });
  const text = await readFile(join(f.vault, result.path), 'utf8');
  assert.match(text, /^title: Edited Source$/m);
  assert.match(text, /^status: confirmed$/m);
  assert.match(text, /^stale_after: P30D$/m);
  assert.match(text, /^ {2}- wiki\/raw\/report\.md$/m);
  assert.match(text, /^## Source$/m);
  assert.match(text, /^## Key points$/m);
  assert.match(text, /^## Reliability$/m);
  assert.doesNotMatch(text, /^## Question$/m);
});

test('BA96 naming violations are returned as warnings and existing files are not renamed', async (t) => {
  const f = await fixture(t);
  const badName = await ok(f.options, 'wiki_write_page', {
    path: 'concepts/Bad Name.md',
    content: '---\ntype: concept\n---\nBody.\n',
  });
  assert.deepEqual(badName.warnings, ['wiki/concepts/Bad Name.md: name is not lowercase kebab-case']);
  assert.equal(await missing(join(f.vault, 'wiki/concepts/Bad Name.md')), false);

  const longName = `${'a'.repeat(81)}.md`;
  const long = await ok(f.options, 'wiki_write_page', {
    path: `concepts/${longName}`,
    content: '---\ntype: concept\n---\nBody.\n',
  });
  assert.deepEqual(long.warnings, [`wiki/concepts/${longName}: name is longer than 80 characters`]);

  const folder = await ok(f.options, 'wiki_write_page', {
    path: 'notes/alpha.md',
    content: '---\ntitle: Alpha\n---\nBody.\n',
  });
  assert.deepEqual(folder.warnings, ['wiki/notes/alpha.md: folder notes is not a Wiki type folder']);

  const type = await ok(f.options, 'wiki_write_page', {
    path: 'concepts/source-page.md',
    content: '---\ntype: source\n---\nBody.\n',
  });
  assert.deepEqual(type.warnings, ['wiki/concepts/source-page.md: type source belongs in sources/']);

  assert.equal(await missing(join(f.vault, 'wiki/concepts/Bad Name.md')), false);
  assert.equal(await missing(join(f.vault, 'wiki/concepts', longName)), false);
  assert.equal(await missing(join(f.vault, 'wiki/notes/alpha.md')), false);
});

test('BA96 strict OKF refuses naming violations with E_OKF_INVALID and the same messages', async (t) => {
  const f = await fixture(t, (config) => {
    config.okf = { level: 'strict' };
  });
  const result = await call(f.options, 'wiki_write_page', {
    path: 'concepts/Bad Name.md',
    content: '---\ntype: concept\n---\nBody.\n',
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /^E_OKF_INVALID: /);
  assert.match(result.text, /wiki\/concepts\/Bad Name\.md: name is not lowercase kebab-case/);
  assert.equal(await missing(join(f.vault, 'wiki/concepts/Bad Name.md')), true);

  const created = await call(f.options, 'wiki_create', {
    type: 'query',
    name: 'a'.repeat(81),
    content: '',
  });
  assert.equal(created.isError, true);
  assert.equal(created.text, `E_OKF_INVALID: wiki/queries/${'a'.repeat(81)}.md: name is longer than 80 characters`);
});

test('BA96 wiki_lint reports naming violations for existing pages without renaming them', async (t) => {
  const f = await fixture(t);
  await ok(f.options, 'wiki_write_page', {
    path: 'entities/Bad Name.md',
    content: '---\ntype: entity\n---\nBody.\n',
  });
  const lint = await ok(f.options, 'wiki_lint');
  assert.ok(
    lint.findings.some(
      (finding) =>
        finding.category === 'naming' &&
        finding.severity === 'warning' &&
        finding.message === 'wiki/entities/Bad Name.md: name is not lowercase kebab-case'
    )
  );
  assert.equal(await missing(join(f.vault, 'wiki/entities/Bad Name.md')), false);
});

test('BA96 catalog describes the five create types', async () => {
  const { OPERATIONS } = await import('../../packages/core/src/meta/catalog.mjs');
  const summary = OPERATIONS.find(({ tool }) => tool === 'wiki_create').summary;
  for (const type of Object.keys(TYPES)) assert.match(summary, new RegExp(type));
});

const VALID = '---\ntype: concept\ntitle: X\n---\nBody.\n';

test('BA96 strict rewrite of an existing non-conforming page is allowed with warnings', async (t) => {
  const f = await fixture(t);
  await ok(f.options, 'wiki_write_page', { path: 'concepts/Bad Name.md', content: VALID });
  f.options.config.okf = { level: 'strict' };
  const again = await ok(f.options, 'wiki_write_page', { path: 'concepts/Bad Name.md', content: VALID });
  assert.equal(again.created, false);
  assert.deepEqual(again.warnings, ['wiki/concepts/Bad Name.md: name is not lowercase kebab-case']);
  const fresh = await call(f.options, 'wiki_write_page', { path: 'concepts/Other Bad.md', content: VALID });
  assert.equal(fresh.isError, true);
  assert.match(fresh.text, /^E_OKF_INVALID: /);
});

test('BA96 prototype-chain and non-string types are ignored by the naming rule', async (t) => {
  const f = await fixture(t);
  for (const type of ['constructor', '__proto__', 'toString']) {
    const result = await ok(f.options, 'wiki_write_page', {
      path: `concepts/proto-${type.replaceAll('_', 'x').toLowerCase()}.md`,
      content: `---\ntype: ${type}\n---\nBody.\n`,
    });
    assert.equal(result.warnings, undefined);
  }
  const array = await ok(f.options, 'wiki_write_page', {
    path: 'concepts/array-type.md',
    content: '---\ntype: [entity]\n---\nBody.\n',
  });
  assert.equal(array.warnings, undefined);
});

test('BA96 lint checks untyped pages, root-level pages and reports unreadable pages', async (t) => {
  const f = await fixture(t);
  await ok(f.options, 'wiki_write_page', { path: 'concepts/Untyped Page.md', content: 'Body.\n' });
  await ok(f.options, 'wiki_write_page', { path: 'root-page.md', content: 'Body.\n' });
  await mkdir(join(f.vault, 'wiki/concepts'), { recursive: true });
  await writeFile(join(f.vault, 'wiki/concepts/broken.md'), '---\n: : [\n---\nBody.\n');
  const lint = await ok(f.options, 'wiki_lint');
  const messages = lint.findings.filter((x) => x.category === 'naming').map((x) => x.message);
  assert.ok(messages.includes('wiki/concepts/Untyped Page.md: name is not lowercase kebab-case'));
  assert.ok(messages.includes('wiki/root-page.md: page is not in a Wiki type folder'));
  assert.ok(messages.includes('wiki/concepts/broken.md: page could not be read'));
});

test('BA96 wiki_update_page on a missing page keeps its not-found error in strict mode', async (t) => {
  const normal = await fixture(t);
  const strict = await fixture(t, (config) => {
    config.okf = { level: 'strict' };
  });
  const args = { path: 'concepts/Missing Page.md', content: VALID };
  const a = await call(normal.options, 'wiki_update_page', args);
  const b = await call(strict.options, 'wiki_update_page', args);
  assert.equal(a.isError, true);
  assert.equal(b.text, a.text);
  assert.doesNotMatch(b.text, /E_OKF_INVALID/);
});
