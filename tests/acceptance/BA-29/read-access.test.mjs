// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = dirname(fileURLToPath(import.meta.url));
const CAND = resolve(here, '..', '..', '..');
const dirs = [];
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), `ba29-read-${p}-`));
  dirs.push(d);
  return d;
};

const FILES = {
  'wiki/index.md': '---\ntitle: Index\nstatus: active\n---\n# Index\n\n- [[alpha]] zyqorvex gateway entry\n',
  'wiki/log.md': '# Log\n\n- 2026-11-01 zyqorvex log line\n',
  'wiki/AGENTS.md': '# Agent policy for zyqorvex\n\nwiki-local policy text.\n',
  'wiki/CLAUDE.md': '# Project memory zyqorvex\n\nwiki-local memory text.\n',
  'wiki/GEMINI.md': '# Gemini zyqorvex\n\nwiki-local gemini text.\n',
  'wiki/alpha.md':
    '---\ntitle: Zyqorvex gateway\nstatus: confirmed\n---\n# Zyqorvex gateway\n\n## Timeouts\nThe zyqorvex gateway applies a thirty second timeout.\n',
  'wiki/sub/index.md': '# Nested index\n\nzyqorvex nested navigation page, not a root page.\n',
  'planning/p.md': '# Plan\n\nzyqorvex plan outside the wiki.\n',
  'AGENTS.md': '# Root agents\n\nzyqorvex root policy outside the wiki.\n',
};

function vault(files = FILES) {
  const v = tmp('vault');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(v, rel)), { recursive: true });
    writeFileSync(join(v, rel), body, 'utf8');
  }
  return v;
}

async function load(root) {
  return import(pathToFileURL(join(root, 'packages/mcp/src/index.mjs')).href);
}
const cfgOf = (root) =>
  import(pathToFileURL(join(root, 'packages/core/src/config/index.mjs')).href).then((C) => {
    const config = C.defaultConfig('lite');
    config.retrieval = { budgetChars: 4000, abstainThreshold: 0.35 };
    return config;
  });

async function session(mcp, root, v) {
  const config = await cfgOf(root);
  config.vault.path = v;
  const server = mcp.createServer({
    config,
    paths: { vaultDir: v, stateDir: tmp('state') },
    env: { HOME: tmp('home') },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba29-read', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    let text = r.content?.[0]?.text ?? null;
    if (name === 'wiki_status' && text) {
      const status = JSON.parse(text);
      delete status.indexAgeMs;
      text = JSON.stringify(status);
    }
    return { isError: r.isError === true, text };
  };
  return {
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('read access 4b: the excluded pages are readable on the candidate, with content', async () => {
  const C = await load(CAND);
  const s = await session(C, CAND, vault());
  try {
    for (const path of ['index.md', 'log.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      const r = await s.call('wiki_read_page', { path });
      assert.equal(r.isError, false, `wiki_read_page ${path} must not error`);
      assert.ok(r.text && r.text.length > 0, `wiki_read_page ${path} must return text`);
    }
    const index = await s.call('wiki_read_page', { path: 'index.md' });
    assert.equal(index.isError, false);
    assert.match(index.text, /zyqorvex gateway entry|Index/u);
  } finally {
    await s.close();
  }
});

test('read access 4c: wiki_query on the candidate never returns the excluded root pages (search side)', async () => {
  const C = await load(CAND);
  const s = await session(C, CAND, vault());
  try {
    const r = await s.call('wiki_query', { query: 'zyqorvex' });
    assert.equal(r.isError, false);
    const paths = JSON.parse(r.text).results.map((item) => item.path);
    for (const excluded of ['index.md', 'log.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      assert.ok(!paths.includes(excluded), `${excluded} must not be a result: ${JSON.stringify(paths)}`);
    }
  } finally {
    await s.close();
  }
});
