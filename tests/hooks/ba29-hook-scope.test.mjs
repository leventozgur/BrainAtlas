// SPDX-License-Identifier: MIT
// BA-29: the hook searches the same scope as the MCP server (<vault>/wiki when present), leaves out root-level
// navigation and policy files, and shares the retrieval cache with the MCP server that uses the same state directory.
// The parity case imports the pre-change product from the main checkout found with `git rev-parse --git-common-dir`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHook } from '../../packages/hooks/src/index.mjs';
import { createServer } from '../../packages/mcp/src/index.mjs';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const now = new Date('2026-11-11T00:00:00Z');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba29-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
function hookConfig(vault, stateDir, extra = {}) {
  return {
    vault: { path: vault },
    stateDir,
    hooks: { mode: 'normal', deadlineMs: 4700 },
    retrieval: { abstainThreshold: 0 },
    ...extra,
  };
}
async function prompt(vault, stateDir, query, extra) {
  const { stdout } = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: 's-' + query, prompt: query }),
    env: {},
    config: hookConfig(vault, stateDir, extra),
    now,
  });
  const context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext || '';
  return { context, paths: [...context.matchAll(/\(([^()\n]+\.md)\)/g)].map((m) => m[1]) };
}
function mainCheckout() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
    const root = path.resolve(repo, common, '..');
    return fs.existsSync(path.join(root, 'packages/hooks/src/index.mjs')) ? root : null;
  } catch {
    return null;
  }
}

test('wiki vault: the hook injects wiki pages only, never wiki/index.md or the root policy file', async (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'AGENTS.md', '# Policy\nquokka habitat policy');
  write(vault, 'index.md', '# Root index\nquokka habitat catalog');
  write(vault, 'planning/p.md', '# Plan\nquokka habitat plan');
  write(vault, 'wiki/index.md', '# Wiki catalog\nquokka habitat catalog');
  write(vault, 'wiki/log.md', '# Log\nquokka habitat log');
  write(vault, 'wiki/notes/habitat.md', '# Habitat\nquokka habitat is the rocky island');
  const { context, paths } = await prompt(vault, path.join(dir, 'state'), 'where does the quokka habitat live?');
  // Hook paths stay vault-relative: the wiki page is reported as wiki/notes/habitat.md.
  assert.deepEqual(paths, ['wiki/notes/habitat.md'], context);
});

test('vault without wiki: the hook leaves out root navigation, policy, planning, archive, inbox and raw', async (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nquokka habitat catalog');
  write(vault, 'log.md', '# Log\nquokka habitat log');
  write(vault, 'CLAUDE.md', '# Agent\nquokka habitat rules');
  write(vault, 'planning/p.md', '# Plan\nquokka habitat plan');
  write(vault, 'archive/a.md', '# Archive\nquokka habitat archive');
  write(vault, 'inbox/i.md', '# Inbox\nquokka habitat inbox');
  write(vault, 'raw/r.md', '# Raw\nquokka habitat raw');
  write(vault, 'notes/habitat.md', '# Habitat\nquokka habitat is the rocky island');
  const { paths } = await prompt(vault, path.join(dir, 'state'), 'where does the quokka habitat live?');
  assert.deepEqual(paths, ['notes/habitat.md']);
});

test('config retrieval.exclude [] restores the hook legacy scope', async (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nquokka habitat catalog');
  write(vault, 'notes/habitat.md', '# Habitat\nquokka habitat is the rocky island');
  const { paths } = await prompt(vault, path.join(dir, 'state'), 'where does the quokka habitat live?', {
    retrieval: { abstainThreshold: 0, exclude: [] },
  });
  assert.deepEqual(paths.sort(), ['index.md', 'notes/habitat.md']);
});

test('hook and MCP share one cache when they use the same state directory', async (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault'),
    state = path.join(dir, 'state');
  write(vault, 'wiki/notes/habitat.md', '# Habitat\nquokka habitat is the rocky island');
  write(vault, 'wiki/index.md', '# Catalog\nquokka habitat catalog');
  await prompt(vault, state, 'quokka habitat');
  const cache = path.join(state, 'retrieval-index.json');
  const before = fs.statSync(cache).ino + ':' + fs.readFileSync(cache, 'utf8');

  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.retrieval = { ...config.retrieval, abstainThreshold: 0 };
  const server = createServer({ config, paths: { vaultDir: vault, stateDir: state }, env: { HOME: dir } });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba29', version: '1' });
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: 'wiki_query', arguments: { query: 'quokka habitat' } });
  assert.deepEqual(
    JSON.parse(result.content[0].text).results.map((r) => r.path),
    ['notes/habitat.md']
  );
  assert.equal(
    fs.statSync(cache).ino + ':' + fs.readFileSync(cache, 'utf8'),
    before,
    'the MCP server reused the hook cache without a rewrite'
  );
});

test('parity: a vault with no excluded file gives byte-identical hook output to the main checkout', async (t) => {
  const main = mainCheckout();
  if (!main) {
    t.skip('main checkout not found');
    return;
  }
  const mainHook = await import(pathToFileURL(path.join(main, 'packages/hooks/src/index.mjs')).href);
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'notes/habitat.md', '# Habitat\nquokka habitat is the rocky island. Quokkas eat grass.');
  write(vault, 'notes/diet.md', '# Diet\nquokka diet is mostly grass and leaves.');
  write(vault, 'projects/zed.md', '# Zed\nzebrafish project notes.');
  for (const query of ['what does the quokka eat?', 'where is the quokka habitat?', 'zebrafish project']) {
    const input = {
      client: 'claude',
      event: 'prompt',
      stdin: JSON.stringify({ session_id: 'p-' + query, prompt: query }),
      env: {},
      now,
    };
    const mine = await runHook({ ...input, config: hookConfig(vault, path.join(dir, 'state-new')) });
    const theirs = await mainHook.runHook({ ...input, config: hookConfig(vault, path.join(dir, 'state-main')) });
    assert.equal(mine.stdout, theirs.stdout, query);
  }
});
