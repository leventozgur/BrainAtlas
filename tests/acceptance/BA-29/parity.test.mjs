// SPDX-License-Identifier: MIT
// BA-29 independent acceptance, hypothesis 3 (legacy parity). The candidate (this worktree) must return byte-identical output to
// the main checkout for: core search(), the prompt hook and the MCP wiki_query, on vaults with no excludable file and no wiki/
// directory, and with retrieval.exclude: [] on every vault that the brief names (see the comments on each case).
// Main is the checkout that holds the git common directory. When main already has the BA-29 scope (searchScope), the parity
// tests skip. Hermetic: temporary directories only, no network, no sockets (the MCP runs in memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = dirname(fileURLToPath(import.meta.url));
const CAND = resolve(here, '..', '..', '..');
const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: CAND, encoding: 'utf8' }).stdout.trim();
const MAIN = resolve(CAND, common, '..');
const NOW = new Date('2026-11-12T00:00:00Z');
const dirs = [];
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), `ba29-parity-${p}-`)); dirs.push(d); return d; };

const mainHasScope = (await import(pathToFileURL(join(MAIN, 'packages/core/src/retrieval/index.mjs')).href)).searchScope !== undefined;
const skip = mainHasScope ? 'main already has the BA-29 scope; legacy parity is not measurable' : false;

async function load(root) {
  const retrieval = await import(pathToFileURL(join(root, 'packages/core/src/retrieval/index.mjs')).href);
  const hooks = await import(pathToFileURL(join(root, 'packages/hooks/src/index.mjs')).href);
  const mcp = await import(pathToFileURL(join(root, 'packages/mcp/src/index.mjs')).href);
  const config = await import(pathToFileURL(join(root, 'packages/core/src/config/index.mjs')).href);
  return { retrieval, hooks, mcp, config };
}

function writeVault(files) {
  const vault = tmp('vault');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), body, 'utf8');
  }
  return vault;
}

// Pages with no excludable name at the vault root or the wiki root (nested names such as sub/index.md are not excluded).
const PLAIN = {
  'alpha.md': '---\ntitle: Zyqorvex gateway\nstatus: confirmed\n---\n# Zyqorvex gateway\n\n## Timeouts\nThe zyqorvex gateway applies a thirty second timeout.\n',
  'sub/index.md': '# Nested index\n\nzyqorvex nested navigation page.\n',
  'sub/planning/plan.md': '# Nested planning\n\nzyqorvex planning note under a folder that is not a root folder.\n',
  'turkce.md': '---\ntitle: Kuantum notları\nstatus: proposed\n---\n# Kuantum notları\n\nşifreleme anahtarı rotasyonu ve güvenlik notları.\n',
  'old.md': '---\ntitle: Old quokka\nstatus: superseded\nsuperseded_by: alpha.md\n---\n# Old quokka\n\nquokka legacy text.\n',
};
// Vaults with no excludable file and no wiki/ directory.
const VAULTS = {
  plain: PLAIN,
  wikiLess2: { 'notes/one.md': '# One\n\nquillfrost ledger entry one.\n', 'notes/two.md': '# Two\n\nquillfrost ledger entry two, longer text about ledgers and entries.\n' },
  nonMarkdown: { 'alpha.md': '# Alpha\n\nzyqorvex alpha page.\n', 'data.txt': 'zyqorvex in a text file that is not a page\n' },
};
const QUERIES = ['zyqorvex timeout', 'quillfrost ledger', 'kuantum şifreleme', 'quokka', 'zyqorvex', 'unknownterm xqzzy'];

function hookOut(hooks, vault, prompt, extraConfig = {}) {
  const stateDir = tmp('state');
  const config = { vault: { path: vault }, stateDir, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0.35 }, ...extraConfig };
  return hooks.runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ session_id: 'ba29-parity', prompt }), env: { HOME: tmp('home') }, config, now: NOW });
}

async function mcpOut(mcp, config, vault, query) {
  const stateDir = tmp('mcp-state');
  const cfg = JSON.parse(JSON.stringify(config));
  cfg.vault.path = vault;
  let server;
  try {
    server = mcp.createServer({ config: cfg, paths: { vaultDir: vault, stateDir }, env: { HOME: tmp('mcp-home') } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ba29-parity', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name: 'wiki_query', arguments: { query } });
    await client.close(); await server.close();
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? null };
  } catch (error) {
    try { await server?.close(); } catch { /* ignore */ }
    return { thrown: error?.code ?? error?.message ?? String(error) };
  }
}

const cfgOf = (C, extra = {}) => ({ ...C.config.defaultConfig('lite'), retrieval: { budgetChars: 4000, abstainThreshold: 0.35, ...extra } });

test('parity 3a: core search() is identical to main on wiki-less vaults', { skip }, async () => {
  const M = await load(MAIN), C = await load(CAND);
  for (const [name, files] of Object.entries(VAULTS)) {
    const vault = writeVault(files);
    const mIndex = M.retrieval.buildIndex(M.retrieval.loadPages(vault), { now: NOW });
    const cIndex = C.retrieval.buildIndex(C.retrieval.loadPages(vault), { now: NOW });
    for (const q of QUERIES) {
      const a = JSON.stringify(M.retrieval.search(mIndex, q, { limit: 10, abstainThreshold: 0.35 }));
      const b = JSON.stringify(C.retrieval.search(cIndex, q, { limit: 10, abstainThreshold: 0.35 }));
      assert.equal(b, a, `search differs on vault ${name} for "${q}"`);
    }
  }
});

test('parity 3b: prompt hook stdout is identical to main on wiki-less vaults (default and retrieval.exclude: [])', { skip }, async () => {
  const M = await load(MAIN), C = await load(CAND);
  for (const [name, files] of Object.entries(VAULTS)) {
    const vault = writeVault(files);
    for (const q of QUERIES) {
      const a = await hookOut(M.hooks, vault, q);
      const b = await hookOut(C.hooks, vault, q);
      assert.equal(b.stdout, a.stdout, `hook differs on vault ${name} for "${q}" (default)`);
      assert.equal(b.exitCode, a.exitCode);
      const c = await hookOut(C.hooks, vault, q, { retrieval: { abstainThreshold: 0.35, exclude: [] } });
      assert.equal(c.stdout, a.stdout, `hook differs on vault ${name} for "${q}" (exclude [])`);
    }
  }
});

test('parity 3c: MCP wiki_query on wiki-less vaults is identical to main (results or error)', { skip }, async () => {
  const M = await load(MAIN), C = await load(CAND);
  for (const [name, files] of Object.entries(VAULTS)) {
    for (const q of QUERIES.slice(0, 3)) {
      const vaultA = writeVault(files), vaultB = writeVault(files);
      const a = await mcpOut(M.mcp, cfgOf(M), vaultA, q);
      const b = await mcpOut(C.mcp, cfgOf(C), vaultB, q);
      assert.deepEqual(b, a, `MCP differs on wiki-less vault ${name} for "${q}"`);
    }
  }
});

test('parity 3d: retrieval.exclude: [] reproduces main on a vault with excludable files inside wiki/ (MCP and hook)', { skip }, async () => {
  const M = await load(MAIN), C = await load(CAND);
  // Every page is inside wiki/, so the candidate's hook search root (wiki/) holds the same pages main's vault-root search sees.
  const files = {
    'wiki/index.md': '# Index\n\nzyqorvex navigation page listing the wiki.\n',
    'wiki/log.md': '# Log\n\nzyqorvex log entry.\n',
    'wiki/alpha.md': '---\ntitle: Zyqorvex gateway\nstatus: confirmed\n---\n# Zyqorvex gateway\n\n## Timeouts\nthe zyqorvex gateway timeout.\n',
    'wiki/sub/beta.md': '# Beta\n\nquillfrost ledger page in a nested folder.\n',
  };
  const vault = writeVault(files);
  for (const q of ['zyqorvex timeout', 'quillfrost ledger', 'zyqorvex']) {
    const a = await hookOut(M.hooks, vault, q);
    const c = await hookOut(C.hooks, vault, q, { retrieval: { abstainThreshold: 0.35, exclude: [] } });
    assert.equal(c.stdout, a.stdout, `hook with exclude [] differs from main for "${q}"`);
    const mq = await mcpOut(M.mcp, cfgOf(M), writeVault(files), q);
    const cq = await mcpOut(C.mcp, cfgOf(C, { exclude: [] }), writeVault(files), q);
    assert.deepEqual(cq, mq, `MCP with exclude [] differs from main for "${q}"`);
  }
});

// Candidate-only scope check (main has no exclusion, so this is not a parity case). In a vault with wiki/, retrieval.exclude: []
// turns the exclusion off inside wiki/ (root navigation pages of the wiki come back), while the search root stays wiki/
// (pages outside wiki/, such as planning/ and a vault-root index.md, never come back).
test('parity 3e: exclude [] in a wiki vault returns wiki/index.md and wiki/log.md, never pages outside wiki/', { skip: CAND === MAIN ? 'main equals candidate' : false }, async () => {
  const C = await load(CAND);
  const files = {
    'wiki/index.md': '# Index\n\nzyqorvex navigation page of the wiki.\n',
    'wiki/log.md': '# Log\n\nzyqorvex log line of the wiki.\n',
    'wiki/alpha.md': '# Alpha\n\nzyqorvex gateway page.\n',
    'planning/p.md': '# Plan\n\nzyqorvex plan outside the wiki.\n',
    'index.md': '# Root index\n\nzyqorvex root navigation outside the wiki.\n',
  };
  const vault = writeVault(files);
  const hook = await hookOut(C.hooks, vault, 'zyqorvex', { retrieval: { abstainThreshold: 0.35, exclude: [] } });
  const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /\(wiki\/index\.md\)/u, 'wiki/index.md must come back with exclude []');
  assert.match(context, /\(wiki\/log\.md\)/u, 'wiki/log.md must come back with exclude []');
  assert.ok(!context.includes('(planning/p.md)'), 'planning/ is outside the wiki search root');
  assert.ok(!context.includes('(index.md)'), 'a vault-root index.md is outside the wiki search root');
  const mcp = await mcpOut(C.mcp, cfgOf(C, { exclude: [] }), writeVault(files), 'zyqorvex');
  assert.equal(mcp.isError, false);
  const paths = JSON.parse(mcp.text).results.map((item) => item.path);
  assert.ok(paths.includes('index.md') && paths.includes('log.md'), `MCP with exclude [] must return wiki root pages: ${JSON.stringify(paths)}`);
  assert.ok(!paths.includes('planning/p.md'), `MCP search root is wiki/, so planning/ must not appear: ${JSON.stringify(paths)}`);
});
