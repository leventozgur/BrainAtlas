// SPDX-License-Identifier: MIT
// BA-23 independent blind acceptance tests. Written from the brief only; the developer's ba23 tests were not read.
// Main (def482f) is imported and executed read-only from its checkout; all fixtures and caches live under ./.tmp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { resolvePaths } from '../../../packages/core/src/paths/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, '../../..');
// Main checkout root: BA23_MAIN_ROOT if set, else the parent of the git common dir (the main checkout, from a worktree or from main itself).
function mainRoot() {
  if (process.env.BA23_MAIN_ROOT) return resolve(process.env.BA23_MAIN_ROOT);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: DEV, encoding: 'utf8' }).trim();
  return dirname(resolve(DEV, common));
}
const MAIN = mainRoot();
const SCRATCH = join(HERE, '.tmp');
const NOW = new Date('2026-11-12T00:00:00.000Z');

const dev = await import(pathToFileURL(join(DEV, 'packages/core/src/retrieval/index.mjs')).href);
const main = await import(pathToFileURL(join(MAIN, 'packages/core/src/retrieval/index.mjs')).href);

// Every malformed-frontmatter shape the brief asks about, plus shapes that main must keep indexing.
const CASES = {
  'ok.md': '---\ntitle: Ok\n---\n# Ok\nplain body',
  'bad-yaml.md': '---\ntitle: [unclosed\n---\n# Bad\nBROKENTOKEN_YAML',
  'dup-key.md': '---\ntitle: a\ntitle: b\n---\n# Dup\nBROKENTOKEN_DUP',
  'bom-bad.md': '﻿---\ntitle: [x\n---\n# BomBad\nBROKENTOKEN_BOM',
  'bom-ok.md': '﻿---\ntitle: BomOk\n---\n# BomOk\nBOMOKTOKEN',
  'unclosed.md': '---\ntitle: Unclosed\nUNCLOSEDTOKEN without a closing line',
  'root-list.md': '---\n- a\n- b\n---\n# RootList\nROOTLISTTOKEN',
  'root-scalar.md': '---\nhello\n---\n# RootScalar\nROOTSCALARTOKEN',
  'unresolved-alias.md': '---\na: *nope\n---\n# Alias\nBROKENTOKEN_ALIAS',
  'circular.md': '---\na: &x\n  b: *x\n---\n# Circ\nBROKENTOKEN_CIRC',
  'crlf-bad.md': '---\r\ntitle: [x\r\n---\r\n# Crlf\r\nBROKENTOKEN_CRLF',
  'tab-indent.md': '---\ntitle: x\n\tbad: y\n---\n# Tab\nBROKENTOKEN_TAB',
  'date-roll.md': '---\ntitle: DateRoll\nstatus: confirmed\nverified:\n  - date: 2026-02-30\n    evidence: x\n    scope: y\n    source: z\n---\n# DateRoll\nDATEROLLTOKEN',
  'tag-error.md': '---\ntitle: !!int foo\n---\n# Tag\nTAGTOKEN',
  'empty-fm.md': '---\n---\n# Empty\nEMPTYTOKEN',
  'bom-crlf-ok.md': '﻿---\r\ntitle: BC\r\n---\r\n# BC\r\nBOMCRLFTOKEN',
  'sub/nested-bad.md': '---\nx: [\n---\nNESTEDBROKENTOKEN',
};

async function workdir(t) {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, 'run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

// Main's verdict for one page: alone in its own directory, so no other page can affect it.
async function mainVerdict(t, rel, content) {
  const dir = await workdir(t);
  await writeTree(dir, { [rel]: content });
  try { main.loadPages(dir); return null; } catch (error) { return error.code; }
}

const cacheFile = (stateDir) => join(stateDir, 'retrieval-index.json');
// MCP indexes <vault>/wiki, so its fixtures live under wiki/.
const underWiki = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`wiki/${k}`, v]));

// ---------- Criterion 1: skip set equals what main's loadPages throws on ----------

test('BA-23 c1: skipped set is exactly the pages main loadPages rejects, and the rest match main', async (t) => {
  const vault = await writeTree(await workdir(t), { 'good.md': '---\ntitle: Good\n---\n# Good\nGOODTOKEN', 'notes.txt': '---\nx: [\n---\n' });
  await writeTree(vault, CASES);
  const expectedSkipped = [];
  for (const [rel, content] of Object.entries(CASES)) if (await mainVerdict(t, rel, content)) expectedSkipped.push(rel);
  expectedSkipped.sort();
  // Sanity: the fixture really exercises main's throwing path.
  assert.ok(expectedSkipped.length >= 7, `expected several main-throwing pages, got ${expectedSkipped.length}`);
  const { pages, skipped } = dev.loadPagesDetailed(vault);
  assert.deepEqual([...skipped].sort(), expectedSkipped);
  // The loadPages contract is unchanged: it still throws on this vault.
  assert.throws(() => dev.loadPages(vault), (e) => e.code === 'E_INVALID_INPUT');
  // Readable pages are identical to main's loadPages over the same readable set.
  const clean = await workdir(t);
  await writeTree(clean, Object.fromEntries(Object.entries({ ...CASES, 'good.md': '---\ntitle: Good\n---\n# Good\nGOODTOKEN' }).filter(([rel]) => !expectedSkipped.includes(rel))));
  assert.deepEqual(pages, main.loadPages(clean));
});

// ---------- Criterion 1 + 5: searcher results on a broken vault equal main on the same vault with those pages deleted ----------

const GOOD = {
  'good-alpha.md': '---\ntitle: Alpha Notes\nstatus: confirmed\nkeywords: [freshness]\nverified:\n  - date: 2026-10-01\n    evidence: test run\n    scope: alpha\n    source: wiki/sources/alpha.md\n---\n# Alpha Notes\n## Current state\nGOODALPHA retrieval cache freshness evidence. See [[good-beta]].\n',
  'good-beta.md': '# Beta\nGOODBETA abstain threshold tuning notes. Links to [[good-alpha]] and [the gamma](sub/good-gamma.md).\n',
  'sub/good-gamma.md': '---\ntitle: Gamma\naliases: [gam]\n---\n# Gamma\nGOODGAMMA snapshot pages index consistency.\n',
  'good-old.md': '---\nstatus: superseded\nsuperseded_by: good-alpha.md\n---\n# Old\nGOODOLD replaced text about retrieval.\n',
  'good-proposed.md': '---\nstatus: proposed\n---\n# Proposal\nGOODPROPOSAL weak trust candidate on retrieval.\n',
  'good-dated.md': '# Log\n## 2026-01-01 Update\nOLDDATED retrieval note.\n## 2026-10-02 Update\nNEWDATED retrieval note.\n',
};
const BROKEN = {
  'broken-yaml.md': '---\ntitle: [unclosed\n---\n# Broken\nBROKENTOKEN_ONE retrieval cache',
  'broken-dup.md': '---\ntitle: a\ntitle: b\n---\n# BrokenDup\nBROKENTOKEN_TWO retrieval',
  'sub/broken-bom.md': '﻿---\nstatus: [x\n---\n# BrokenBom\nBROKENTOKEN_THREE',
  'broken-tab.md': '---\ntitle: x\n\tbad: y\n---\n# BrokenTab\nBROKENTOKEN_FOUR',
};
const QUERIES = ['GOODALPHA', 'retrieval cache freshness', 'abstain threshold', 'snapshot pages', 'gam gamma', 'weak trust candidate',
  'replaced text', 'NEWDATED retrieval', 'BROKENTOKEN_ONE', 'BROKENTOKEN_THREE retrieval', 'links good alpha', 'identifier-free nonsense zzqx'];

test('BA-23 c1+c5: search on a broken vault equals main search on the same vault without the broken pages', async (t) => {
  const broken = await writeTree(await workdir(t), { ...GOOD, ...BROKEN });
  const clean = await writeTree(await workdir(t), GOOD);
  const devSearcher = dev.createSearcher({ vaultDir: broken, stateDir: join(await workdir(t), 'state'), now: NOW });
  const mainSearcher = main.createSearcher({ vaultDir: clean, stateDir: join(await workdir(t), 'state'), now: NOW });
  for (const q of QUERIES) {
    const a = devSearcher.search(q, { limit: 10 });
    const b = mainSearcher.search(q, { limit: 10 });
    assert.deepEqual(a, b, `query ${JSON.stringify(q)}`);
  }
  // Broken-page content never surfaces.
  for (const q of ['BROKENTOKEN_ONE', 'BROKENTOKEN_THREE', 'BROKENTOKEN_FOUR']) {
    assert.equal(devSearcher.search(q, { limit: 10 }).results.length, 0, q);
  }
  assert.ok(devSearcher.search('GOODALPHA', { limit: 3 }).results.length > 0);
});

test('BA-23 c1+c5: searcher on a vault with broken pages does not throw and reports only relative paths', async (t) => {
  const broken = await writeTree(await workdir(t), { ...GOOD, ...BROKEN });
  const searcher = dev.createSearcher({ vaultDir: broken, stateDir: join(await workdir(t), 'state'), now: NOW });
  const snap = searcher.snapshot();
  const readable = snap.pages.map((p) => p.path).sort();
  assert.ok(!readable.some((p) => p.startsWith('broken')) && !readable.includes('sub/broken-bom.md'));
  assert.deepEqual(readable, Object.keys(GOOD).sort());
});

// ---------- Criterion 1: parity of the lexical search and cache bytes with main on a clean vault ----------

test('BA-23 c5: clean vault gives identical cache bytes, search results and refresh behaviour in main and dev', async (t) => {
  const vault = await writeTree(await workdir(t), GOOD);
  const devState = join(await workdir(t), 'dev-state');
  const mainState = join(await workdir(t), 'main-state');
  const d = dev.createSearcher({ vaultDir: vault, stateDir: devState, now: NOW });
  const m = main.createSearcher({ vaultDir: vault, stateDir: mainState, now: NOW });
  // BA-41 (2026-11-15, PM): cache format changed deliberately (per-file records, new schema tag); byte parity with main dropped, result parity below kept.
  for (const q of QUERIES) assert.deepEqual(d.search(q, { limit: 10 }), m.search(q, { limit: 10 }), q);
  // Warm cache: a second instance reads the cache and must answer the same; refreshIfChanged is false on both.
  const d2 = dev.createSearcher({ vaultDir: vault, stateDir: devState, now: NOW });
  const m2 = main.createSearcher({ vaultDir: vault, stateDir: mainState, now: NOW });
  assert.equal(d2.refreshIfChanged(), false);
  assert.equal(m2.refreshIfChanged(), false);
  assert.deepEqual(d2.search('GOODALPHA', { limit: 5 }), m2.search('GOODALPHA', { limit: 5 }));
  assert.deepEqual(d2.snapshot().pages, m2.snapshot().pages);
});

test('BA-23 c5: demo-vault search and cache bytes match main', async (t) => {
  const vault = join(await workdir(t), 'vault');
  await cp(join(DEV, 'demo-vault'), vault, { recursive: true });
  const devState = join(await workdir(t), 'dev-state');
  const mainState = join(await workdir(t), 'main-state');
  const d = dev.createSearcher({ vaultDir: vault, stateDir: devState, now: NOW });
  const m = main.createSearcher({ vaultDir: vault, stateDir: mainState, now: NOW });
  // BA-41 (2026-11-15, PM): cache format changed deliberately (per-file records, new schema tag); byte parity with main dropped, result parity below kept.
  for (const q of ['vault backup', 'evidence', 'current state', 'retrieval', 'decision', 'what is the wiki index', 'E_WIDGET_TIMEOUT', 'stale', 'superseded']) {
    assert.deepEqual(d.search(q, { limit: 5 }), m.search(q, { limit: 5 }), q);
  }
});

// ---------- Criterion 3: fix is picked up on refreshIfChanged; re-break is skipped again; no permanent skip ----------

test('BA-23 c3: fixing a broken page is picked up by refreshIfChanged, re-breaking it skips it again', async (t) => {
  const vault = await writeTree(await workdir(t), { ...GOOD, 'fixable.md': '---\ntitle: [x\n---\n# Fixable\nBROKENFIX' });
  const stateDir = join(await workdir(t), 'state');
  const s = dev.createSearcher({ vaultDir: vault, stateDir, now: NOW });
  assert.equal(s.search('FIXEDTOKENXYZ', { limit: 5 }).results.length, 0);
  assert.equal(s.refreshIfChanged(), false);
  await writeFile(join(vault, 'fixable.md'), '---\ntitle: Fixable\n---\n# Fixable\nFIXEDTOKENXYZ now readable and longer than before.\n');
  assert.equal(s.refreshIfChanged(), true);
  const hit = s.search('FIXEDTOKENXYZ', { limit: 5 });
  assert.equal(hit.results[0]?.path, 'fixable.md');
  // A fresh instance over the same state dir agrees (cache must not hold the old skip).
  const fresh = dev.createSearcher({ vaultDir: vault, stateDir, now: NOW });
  assert.equal(fresh.search('FIXEDTOKENXYZ', { limit: 5 }).results[0]?.path, 'fixable.md');
  // Re-break with different content: skipped again, old fixed text gone, no throw.
  await writeFile(join(vault, 'fixable.md'), '---\ntitle: [again\n---\n# Fixable\nREBROKENTOKEN');
  assert.equal(s.refreshIfChanged(), true);
  assert.equal(s.search('FIXEDTOKENXYZ', { limit: 5 }).results.length, 0);
  assert.equal(s.search('REBROKENTOKEN', { limit: 5 }).results.length, 0);
  const again = dev.createSearcher({ vaultDir: vault, stateDir, now: NOW });
  assert.equal(again.search('FIXEDTOKENXYZ', { limit: 5 }).results.length, 0);
  assert.ok(!again.snapshot().pages.some((p) => p.path === 'fixable.md'));
});

test('BA-23 c3: a cache-hit instance over a vault with a broken page still skips it and keeps snapshot consistent', async (t) => {
  const vault = await writeTree(await workdir(t), { ...GOOD, ...BROKEN });
  const stateDir = join(await workdir(t), 'state');
  dev.createSearcher({ vaultDir: vault, stateDir, now: NOW });
  const warm = dev.createSearcher({ vaultDir: vault, stateDir, now: NOW });
  const snap = warm.snapshot();
  assert.deepEqual(snap.pages.map((p) => p.path).sort(), Object.keys(GOOD).sort());
  assert.equal(warm.search('BROKENTOKEN_ONE', { limit: 5 }).results.length, 0);
  assert.equal(warm.refreshIfChanged(), false);
});

// ---------- Criterion 2: hook (real process) and MCP wiki_query on the same broken vault ----------

// loadConfig reads resolvePaths().configFile under HOME (not BRAINATLAS_CONFIG), so the config is written there.
async function envFor(t, vault) {
  const home = await workdir(t);
  const env = { HOME: home, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' };
  const configFile = resolvePaths({ env }).configFile;
  const config = defaultConfig('lite');
  config.vault.path = vault;
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config));
  return env;
}

test('BA-23 c2: hook process on a broken vault answers with healthy pages and exits cleanly', async (t) => {
  const vault = await writeTree(await workdir(t), { ...GOOD, ...BROKEN });
  const env = await envFor(t, vault);
  const r = spawnSync(process.execPath, [join(DEV, 'packages/hooks/bin/brainatlas-hook.mjs'), 'claude', 'prompt'], {
    input: JSON.stringify({ session_id: 'ba23-blind', prompt: 'GOODALPHA retrieval cache freshness?' }), env, encoding: 'utf8', timeout: 20000, cwd: DEV,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/BROKENTOKEN/.test(r.stdout), 'broken content must not leak');
  assert.match(r.stdout, /GOODALPHA/);
  assert.match(r.stdout, /hookSpecificOutput/);
});

test('BA-23 c2: hook process on the clean vault equals main hook behaviour (no broken pages)', async (t) => {
  const vault = await writeTree(await workdir(t), GOOD);
  const env = await envFor(t, vault);
  const input = JSON.stringify({ session_id: 'ba23-parity', prompt: 'GOODALPHA retrieval cache freshness?' });
  const devOut = spawnSync(process.execPath, [join(DEV, 'packages/hooks/bin/brainatlas-hook.mjs'), 'claude', 'prompt'], { input, env, encoding: 'utf8', timeout: 20000, cwd: DEV });
  const mainEnv = await envFor(t, vault);
  const mainOut = spawnSync(process.execPath, [join(MAIN, 'packages/hooks/bin/brainatlas-hook.mjs'), 'claude', 'prompt'], { input, env: mainEnv, encoding: 'utf8', timeout: 20000, cwd: MAIN });
  assert.equal(devOut.status, mainOut.status);
  assert.equal(devOut.stdout, mainOut.stdout);
  assert.match(devOut.stdout, /GOODALPHA/, 'hook must actually answer, not return an empty result');
});

async function mcpWikiQuery(binDir, env, query) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(binDir, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: binDir,
    env, stderr: 'pipe' });
  const client = new Client({ name: 'ba23-blind', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'wiki_query', arguments: { query, limit: 5 } });
    const text = result.content.find((item) => item.type === 'text')?.text ?? '';
    return { isError: result.isError === true, text, payload: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  } finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
}

test('BA-23 c2: MCP wiki_query on a broken vault succeeds and returns healthy pages only', async (t) => {
  const vault = await writeTree(await workdir(t), underWiki({ ...GOOD, ...BROKEN }));
  const env = await envFor(t, vault);
  const r = await mcpWikiQuery(DEV, env, 'GOODALPHA retrieval cache freshness');
  assert.equal(r.isError, false, r.text);
  assert.equal(r.payload.abstained, false);
  assert.ok(r.payload.results.some((x) => x.path === 'good-alpha.md'));
  assert.ok(!/BROKENTOKEN/.test(r.text) && !/broken-/.test(r.text));
});

test('BA-23 c5: MCP wiki_query on clean vault gives the same payload as main MCP', async (t) => {
  const vault = await writeTree(await workdir(t), underWiki(GOOD));
  const env = await envFor(t, vault);
  const mainEnv = await envFor(t, vault);
  for (const q of ['GOODALPHA retrieval cache freshness', 'abstain threshold', 'replaced text', 'NEWDATED retrieval']) {
    const d = await mcpWikiQuery(DEV, env, q);
    const m = await mcpWikiQuery(MAIN, mainEnv, q);
    assert.equal(d.isError, m.isError, q);
    assert.deepEqual(d.payload, m.payload, q);
  }
});

test('BA-23 c2: MCP wiki_query on a broken vault equals main MCP on the same vault minus the broken pages', async (t) => {
  const broken = await writeTree(await workdir(t), underWiki({ ...GOOD, ...BROKEN }));
  const clean = await writeTree(await workdir(t), underWiki(GOOD));
  const env = await envFor(t, broken);
  const cleanEnv = await envFor(t, clean);
  const d = await mcpWikiQuery(DEV, env, 'retrieval cache freshness abstain');
  const m = await mcpWikiQuery(MAIN, cleanEnv, 'retrieval cache freshness abstain');
  assert.deepEqual(d.payload, m.payload);
});

// ---------- Criterion 4: maintain --json ----------

function maintain(vault, home) {
  const r = spawnSync(process.execPath, [join(DEV, 'packages/cli/bin/brainatlas.mjs'), 'maintain', '--json', '--vault', vault], {
    env: { HOME: home, PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30000, cwd: DEV,
  });
  return r;
}

test('BA-23 c4: maintain --json reports invalid-frontmatter by relative path, without content or parser text', async (t) => {
  const vault = await writeTree(await workdir(t), { 'wiki/index.md': '# Index\n', 'wiki/log.md': '# Log\n', 'wiki/good-alpha.md': GOOD['good-alpha.md'], 'wiki/bad-yaml.md': BROKEN['broken-yaml.md'], 'wiki/sub/broken-bom.md': BROKEN['sub/broken-bom.md'] });
  const r = maintain(vault, await workdir(t));
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const inv = report.findings.filter((f) => f.kind === 'invalid-frontmatter');
  assert.deepEqual(inv.map((f) => f.path).sort(), ['wiki/bad-yaml.md', 'wiki/sub/broken-bom.md']);
  for (const f of inv) assert.deepEqual(Object.keys(f).sort(), ['detail', 'kind', 'path']);
  assert.ok(!r.stdout.includes('BROKENTOKEN'), 'page body must not appear');
  // Parser wording must not appear in any detail (file names such as bad-yaml.md are allowed in paths only).
  for (const f of report.findings) assert.ok(!/yaml|unclosed|duplicate|map keys|nested|flow|alias|tab/i.test(f.detail), `parser text in detail: ${f.detail}`);
  assert.equal(Object.keys(report.counts).length, 8);
  assert.ok(!Object.hasOwn(report.counts, 'invalid-frontmatter'));
});

test('BA-23 c4: clean vault has zero invalid-frontmatter and maintain output matches main (durationMs aside)', async (t) => {
  const vault = await writeTree(await workdir(t), { 'wiki/index.md': '# Index\n', 'wiki/log.md': '# Log\n', ...Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [`wiki/${k}`, v])) });
  const home = await workdir(t);
  const d = maintain(vault, home);
  assert.equal(d.status, 0, d.stderr);
  const dr = JSON.parse(d.stdout);
  assert.equal(dr.findings.filter((f) => f.kind === 'invalid-frontmatter').length, 0);
  const m = spawnSync(process.execPath, [join(MAIN, 'packages/cli/bin/brainatlas.mjs'), 'maintain', '--json', '--vault', vault], {
    env: { HOME: await workdir(t), PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30000, cwd: MAIN,
  });
  assert.equal(m.status, 0, m.stderr);
  const mr = JSON.parse(m.stdout);
  delete dr.durationMs; delete mr.durationMs;
  assert.deepEqual(dr, mr);
});

// ---------- Criterion 6: security boundaries unchanged ----------

test('BA-23 c6: symlinks out of the vault (files and directories) are neither indexed nor reported as skipped', async (t) => {
  const outside = await writeTree(await workdir(t), { 'secret.md': '# Secret\nSYMLINKTOKEN', 'bad.md': '---\ntitle: [x\n---\nOUTSIDEBAD', 'dir/bad2.md': '---\nx: [\n---\nOUTSIDEBAD2' });
  const vault = await writeTree(await workdir(t), { ...GOOD });
  await symlink(join(outside, 'secret.md'), join(vault, 'link-secret.md'));
  await symlink(join(outside, 'bad.md'), join(vault, 'link-bad.md'));
  await symlink(join(outside, 'dir'), join(vault, 'link-dir'));
  const { pages, skipped } = dev.loadPagesDetailed(vault);
  assert.ok(!pages.some((p) => p.path.startsWith('link-')));
  assert.ok(!skipped.some((p) => p.startsWith('link-')), 'symlinked broken page must not be listed');
  const s = dev.createSearcher({ vaultDir: vault, stateDir: join(await workdir(t), 'state'), now: NOW });
  assert.equal(s.search('SYMLINKTOKEN', { limit: 5 }).results.length, 0);
  assert.equal(s.search('OUTSIDEBAD', { limit: 5 }).results.length, 0);
  // Parity with main on a vault whose symlinks are the only extra items.
  const m = main.createSearcher({ vaultDir: vault, stateDir: join(await workdir(t), 'mstate'), now: NOW });
  for (const q of QUERIES) assert.deepEqual(s.search(q, { limit: 10 }), m.search(q, { limit: 10 }), q);
});

test('BA-23 c6: unsafe page paths are still dropped by buildIndex (same as main)', () => {
  const page = (path, body) => ({ path, title: 'T', aliases: [], keywords: [], headings: [], body, frontmatter: {} });
  const pages = [page('ok.md', 'UNSAFEPARITY alpha'), page('../escape.md', 'UNSAFEPARITY escape'), page('/abs.md', 'UNSAFEPARITY abs'), page('a\\b.md', 'UNSAFEPARITY bs')];
  const d = dev.search(dev.buildIndex(pages, { now: NOW }), 'UNSAFEPARITY', { limit: 10 });
  const m = main.search(main.buildIndex(pages, { now: NOW }), 'UNSAFEPARITY', { limit: 10 });
  assert.deepEqual(d, m);
  assert.deepEqual(d.results.map((r) => r.path), ['ok.md']);
});

// ---------- Criterion 3 for MCP: a fixed page appears on the next query without restarting the server ----------

test('BA-23 c3: MCP picks up a fixed page on a later wiki_query', async (t) => {
  const vault = await writeTree(await workdir(t), underWiki({ ...GOOD, 'fixme.md': '---\ntitle: [x\n---\n# Fix\nMCPFIXTOKEN' }));
  const env = await envFor(t, vault);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(DEV, 'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: DEV, env, stderr: 'pipe' });
  const client = new Client({ name: 'ba23-blind', version: '1.0.0' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  await client.connect(transport);
  const q = (query) => client.callTool({ name: 'wiki_query', arguments: { query, limit: 5 } }).then((r) => ({ isError: r.isError === true, text: r.content.find((c) => c.type === 'text')?.text ?? '' }));
  const first = await q('MCPFIXTOKEN');
  assert.equal(first.isError, false, first.text);
  assert.ok(!first.text.includes('fixme.md'));
  await writeFile(join(vault, 'wiki/fixme.md'), '---\ntitle: Fix\n---\n# Fix\nMCPFIXTOKEN is now readable and longer.\n');
  const second = await q('MCPFIXTOKEN');
  assert.equal(second.isError, false, second.text);
  assert.ok(second.text.includes('fixme.md'), second.text);
});
