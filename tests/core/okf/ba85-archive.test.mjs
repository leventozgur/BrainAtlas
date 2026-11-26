// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { checkPage, checkVault } from '../../../packages/core/src/okf/index.mjs';
import { parseFrontmatter } from '../../../packages/core/src/vault/index.mjs';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { createServer } from '../../../packages/mcp/src/index.mjs';
import { cleanEnv } from '../../cli/clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const ARCHIVE = 'wiki/archive/concepts--x-history.md';

const head = () =>
  '---\ntype: concept\ntitle: "Compaction Page"\ngenerated: "2026-11-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: "P90D"\naliases: []\nkeywords: []\n---\n\n# Compaction Page\n\n';
const section = (date, label) => `## ${date} — ${label}\n\n${label} body.\n`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba85-okf-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  const state = join(base, 'state');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');
  await writeFile(join(vault, 'wiki', 'log.md'), '# Log\n');
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false });
  return { base, home, vault, state, env, run };
}

async function compact(f) {
  await writeFile(
    join(f.vault, 'wiki', 'concepts', 'x.md'),
    head() +
      section('2026-10-16', 'S3') +
      section('2026-10-12', 'S5') +
      section('2026-10-10', 'S1') +
      section('2026-10-05', 'S4') +
      section('2026-10-01', 'S2')
  );
  const result = f.run('compact', '--page', 'wiki/concepts/x.md', '--apply', '--keep', '3', '--vault', f.vault);
  assert.equal(result.status, 0, result.stderr);
  return readFile(join(f.vault, ...ARCHIVE.split('/')), 'utf8');
}

const pageFor = (path, data) => ({ path, data, raw: '' });
const archiveData = (overrides = {}) => ({
  type: 'archive',
  status: 'archived',
  archived_from: 'wiki/concepts/x.md',
  generated: '2026-11-01T00:00:00.000Z',
  ...overrides,
});
const rules = (findings) => findings.map((item) => item.rule);

test('the exact compact archive header has no errors and no required warnings', async (t) => {
  const f = await fixture(t);
  const raw = await compact(f);
  const parsed = parseFrontmatter(raw).data;
  const findings = checkPage({ path: ARCHIVE, data: parsed, raw });
  assert.deepEqual(
    findings.filter((item) => item.severity === 'error'),
    []
  );
  assert.deepEqual(
    findings.filter((item) => item.rule.startsWith('required.')),
    []
  );

  const withoutGenerated = raw.replace(/^generated: .*\n/m, '');
  const missing = checkPage({
    path: ARCHIVE,
    data: parseFrontmatter(withoutGenerated).data,
    raw: withoutGenerated,
  });
  assert.ok(rules(missing).includes('required.generated'));
});

test('archive type and status are accepted only on archive pages', () => {
  assert.ok(rules(checkPage(pageFor('wiki/concepts/x.md', archiveData()))).includes('type.invalid'));
  assert.ok(
    rules(checkPage(pageFor('wiki/concepts/x.md', archiveData({ type: 'concept' })))).includes('status.invalid')
  );

  const confirmed = checkPage(pageFor(ARCHIVE, archiveData({ status: 'confirmed' })));
  assert.equal(rules(confirmed).includes('status.invalid'), false);
  const bogus = checkPage(pageFor(ARCHIVE, archiveData({ status: 'bogus' })));
  assert.ok(rules(bogus).includes('status.invalid'));
});

test('archive pages still need a valid archived_from wiki path', () => {
  const missing = checkPage(pageFor(ARCHIVE, archiveData({ archived_from: undefined })));
  const escaping = checkPage(pageFor(ARCHIVE, archiveData({ archived_from: '../x.md' })));
  const outside = checkPage(pageFor(ARCHIVE, archiveData({ archived_from: 'raw/x.md' })));
  for (const findings of [missing, escaping, outside]) assert.ok(rules(findings).includes('archive.source-missing'));
  assert.equal(rules(checkPage(pageFor(ARCHIVE, archiveData()))).includes('archive.source-missing'), false);
});

test('archive pages still apply generated.future', () => {
  const findings = checkPage(pageFor(ARCHIVE, archiveData({ generated: '2027-01-01T00:00:00.000Z' })), {
    asOf: new Date('2026-11-01T00:00:00Z'),
  });
  assert.ok(rules(findings).includes('generated.future'));
});

test('checkVault reports no errors after compact --apply', async (t) => {
  const f = await fixture(t);
  await compact(f);
  const findings = await checkVault(f.vault);
  assert.deepEqual(
    findings.filter((item) => item.severity === 'error'),
    []
  );
});

test('MCP wiki_status reports okfErrorCount 0 after compact --apply', async (t) => {
  const f = await fixture(t);
  await compact(f);
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  config.stateDir = f.state;
  const server = createServer({
    config,
    paths: { vaultDir: f.vault, stateDir: f.state },
    env: { HOME: f.home },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba85-okf-test', version: '1' });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: 'wiki_status', arguments: {} });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const status = JSON.parse(result.content.find((item) => item.type === 'text').text);
  assert.equal(status.okfErrorCount, 0);
});
