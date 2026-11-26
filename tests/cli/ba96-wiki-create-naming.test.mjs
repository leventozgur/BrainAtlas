// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const TYPES = {
  entity: { folder: 'entities', headings: ['## Identity', '## Current state', '## Evidence', '## History'] },
  concept: { folder: 'concepts', headings: ['## Summary', '## Current state', '## Evidence', '## History'] },
  source: { folder: 'sources', headings: ['## Source', '## Key points', '## Reliability'] },
  summary: { folder: 'summaries', headings: ['## Scope', '## Summary', '## Sources'] },
  query: { folder: 'queries', headings: ['## Question', '## Answer', '## Evidence'] },
};

async function write(dir, rel, text) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fixture(t, mutate) {
  const base = await mkdtemp(join(tmpdir(), 'ba96-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await write(vault, 'wiki/index.md', '# Wiki Index\n');
  await write(vault, 'wiki/log.md', '# Log\n');
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_VAULT: vault,
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  if (mutate) {
    const config = defaultConfig('lite');
    config.vault.path = vault;
    mutate(config);
    env.BRAINATLAS_CONFIG = join(home, 'config.json');
    await writeFile(env.BRAINATLAS_CONFIG, JSON.stringify(config));
  }
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [BIN, 'wiki', ...args], {
      env: options.env ?? env,
      input: options.input,
      encoding: 'utf8',
      shell: false,
      timeout: 15000,
    });
  const json = (args, options = {}) => {
    const result = run([...args, '--json'], options);
    assert.equal(result.error, undefined, 'command timed out');
    return { ...result, value: JSON.parse(result.stdout) };
  };
  return { base, home, vault, env, run, json };
}

test('BA96 CLI create accepts every type without stdin and writes the template', async (t) => {
  const f = await fixture(t);
  for (const [type, { folder, headings }] of Object.entries(TYPES)) {
    const result = f.json(['create', type, `CLI ${type}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.value, { ok: true, path: `wiki/${folder}/cli-${type}.md`, created: true, dryRun: false });
    const text = await readFile(join(f.vault, result.value.path), 'utf8');
    assert.match(text, new RegExp(`^type: ${type}$`, 'm'));
    assert.match(text, /^status: proposed$/m);
    for (const heading of headings) assert.ok(text.includes(`\n${heading}\n`), `${type}: ${heading}`);
  }
});

test('BA96 CLI create treats empty stdin as the template and frontmatter-only content as overrides', async (t) => {
  const f = await fixture(t);
  const empty = f.json(['create', 'summary', 'Empty Summary'], { input: '' });
  assert.equal(empty.status, 0, empty.stderr);
  const summary = await readFile(join(f.vault, 'wiki/summaries/empty-summary.md'), 'utf8');
  assert.match(summary, /^## Scope$/m);
  assert.match(summary, /^## Summary$/m);
  assert.match(summary, /^## Sources$/m);

  const frontmatterOnly = f.json(['create', 'source', 'CLI Source'], {
    input: '---\nstatus: confirmed\nsources:\n  - wiki/raw/report.md\nverified: []\nstale_after: P30D\n---\n',
  });
  assert.equal(frontmatterOnly.status, 0, frontmatterOnly.stderr);
  const source = await readFile(join(f.vault, 'wiki/sources/cli-source.md'), 'utf8');
  assert.match(source, /^status: confirmed$/m);
  assert.match(source, /^stale_after: P30D$/m);
  assert.match(source, /^## Source$/m);
  assert.match(source, /^## Key points$/m);
  assert.match(source, /^## Reliability$/m);
});

test('BA96 CLI create rejects an unknown type and treats whitespace-only input as empty', async (t) => {
  const f = await fixture(t);
  const type = f.json(['create', 'other', 'Name'], { input: 'x' });
  assert.equal(type.status, 1);
  assert.equal(type.value.error.code, 'E_ARGUMENT');
  assert.equal(type.value.error.message, 'wiki create type must be entity, concept, source, summary or query.');
  const empty = f.json(['create', 'concept', 'Empty'], { input: '  \n' });
  assert.equal(empty.status, 0, empty.stderr);
  const page = await readFile(join(f.vault, 'wiki/concepts/empty.md'), 'utf8');
  assert.match(page, /^## Summary$/m);
});

test('BA96 CLI write and lint use the same naming rule and strict refusal', async (t) => {
  const f = await fixture(t);
  const written = f.json(['write', 'concepts/Bad Name.md'], {
    input:
      '---\ntype: concept\ntitle: Bad Name\ngenerated: "2026-11-26"\nstatus: proposed\nsources: []\nverified: []\nstale_after: P90D\naliases: []\nkeywords: []\n---\nBody.\n',
  });
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(written.value, {
    ok: true,
    path: 'wiki/concepts/Bad Name.md',
    created: true,
    updated: false,
    dryRun: false,
    okfFindings: [],
    warnings: ['wiki/concepts/Bad Name.md: name is not lowercase kebab-case'],
  });
  const lint = f.json(['lint']);
  assert.equal(lint.status, 0, lint.stderr);
  assert.ok(
    lint.value.findings.some(
      (finding) =>
        finding.category === 'naming' &&
        finding.message === 'wiki/concepts/Bad Name.md: name is not lowercase kebab-case'
    )
  );

  const strict = await fixture(t, (config) => {
    config.okf = { level: 'strict' };
  });
  const refused = strict.json(['write', 'concepts/Bad Name.md'], {
    input: '---\ntype: concept\n---\nBody.\n',
  });
  assert.equal(refused.status, 1);
  assert.equal(refused.value.error.code, 'E_OKF_INVALID');
  assert.match(refused.stderr, /wiki\/concepts\/Bad Name\.md: name is not lowercase kebab-case/u);
  await assert.rejects(readFile(join(strict.vault, 'wiki/concepts/Bad Name.md')), { code: 'ENOENT' });
});
