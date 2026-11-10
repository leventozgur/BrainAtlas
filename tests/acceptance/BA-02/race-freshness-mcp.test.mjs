// SPDX-License-Identifier: MIT
// BA-02 retest F3: a real stdio MCP server. An outside delete or rename lands during the freshness check of a
// wiki_query. Expected: the query returns a normal (non-error) result from the last good index, and the next query
// shows the outside change. The race is injected deterministically by race-preload.mjs (NODE_OPTIONS --import).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const BIN = path.join(root, 'packages/mcp/bin/brainatlas-mcp.mjs');
const PRELOAD = pathToFileURL(path.join(here, 'race-preload.mjs')).href;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-race-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vault = path.join(home, 'vault'), wiki = path.join(vault, 'wiki');
  fs.mkdirSync(wiki, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'alpha.md'), '# Alpha\nalpha baseline\n');
  fs.writeFileSync(path.join(wiki, 'beta.md'), '# Beta\nbetaterm original\n');
  fs.writeFileSync(path.join(wiki, 'gamma.md'), '# Gamma\ngamma stays\n');
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.retrieval = { ...config.retrieval, abstainThreshold: 0 };
  const configFile = path.join(home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { home, vault, wiki, configFile, arm: path.join(home, 'arm'), log: path.join(home, 'race.log') };
}
// race: { target, op, mode, to } arms the preload injection; omitted means a plain server.
async function start(f, race) {
  const env = { HOME: f.home, BRAINATLAS_CONFIG: f.configFile, BRAINATLAS_VAULT: f.vault, PATH: process.env.PATH ?? '' };
  if (race) Object.assign(env, { NODE_OPTIONS: `--import=${PRELOAD}`, BA02_RACE_ARM: f.arm, BA02_RACE_LOG: f.log,
    BA02_RACE_TARGET: race.target, BA02_RACE_OP: race.op, BA02_RACE_MODE: race.mode, BA02_RACE_TO: race.to ?? '' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: root, env, stderr: 'pipe' });
  const client = new Client({ name: 'ba02-race', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}
async function queryRaw(c, text) {
  return c.client.callTool({ name: 'wiki_query', arguments: { query: text } });
}
// Non-error answer required; returns the list of page paths.
async function query(c, text) {
  const result = await queryRaw(c, text);
  assert.notEqual(result.isError, true, `wiki_query returned an error: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text).results.map((item) => item.path);
}
const armed = (f) => fs.existsSync(f.arm);
const fired = (f) => fs.existsSync(f.log) && fs.readFileSync(f.log, 'utf8').includes('fired');

test('outside delete during the freshness check: the query still answers, the next query shows the deletion', async (t) => {
  const f = fixture(t);
  const c = await start(f, { target: 'beta.md', op: 'read', mode: 'delete' }); t.after(() => c.close());
  assert.deepEqual(await query(c, 'betaterm'), ['beta.md']);
  fs.writeFileSync(path.join(f.wiki, 'beta.md'), '# Beta\nbetaedit replaced text\n'); // changes the fingerprint
  fs.writeFileSync(f.arm, '');
  const during = await query(c, 'betaedit'); // refresh reads beta.md, the preload deletes it first
  assert.ok(Array.isArray(during), 'query returns results, not an error');
  assert.ok(fired(f) && !armed(f), 'the race was injected during the refresh');
  assert.deepEqual(await query(c, 'alpha'), ['alpha.md'], 'other pages keep answering');
  assert.deepEqual(await query(c, 'betaedit'), [], 'the deletion is visible on the next query');
  assert.deepEqual(await query(c, 'betaterm'), [], 'the old text is gone after the deletion');
  assert.deepEqual(await query(c, 'gamma'), ['gamma.md']);
});

test('outside rename during the freshness check: the next query returns the renamed page', async (t) => {
  const f = fixture(t);
  const c = await start(f, { target: 'beta.md', op: 'read', mode: 'rename', to: path.join(f.wiki, 'beta-moved.md') }); t.after(() => c.close());
  assert.deepEqual(await query(c, 'betaterm'), ['beta.md']);
  fs.writeFileSync(path.join(f.wiki, 'beta.md'), '# Beta\nbetaedit replaced text\n');
  fs.writeFileSync(f.arm, '');
  const during = await query(c, 'betaedit');
  assert.ok(Array.isArray(during), 'query returns results, not an error');
  assert.ok(fired(f) && !armed(f), 'the rename was injected during the refresh');
  assert.ok(fs.existsSync(path.join(f.wiki, 'beta-moved.md')) && !fs.existsSync(path.join(f.wiki, 'beta.md')));
  assert.deepEqual(await query(c, 'betaedit'), ['beta-moved.md'], 'the rename is visible on the next query');
  assert.deepEqual(await query(c, 'betaterm'), []);
});

test('outside delete between the fingerprint lstat and the rebuild: no error, deletion visible at once', async (t) => {
  const f = fixture(t);
  const c = await start(f, { target: 'beta.md', op: 'lstat', mode: 'delete' }); t.after(() => c.close());
  assert.deepEqual(await query(c, 'betaterm'), ['beta.md']);
  fs.writeFileSync(path.join(f.wiki, 'beta.md'), '# Beta\nbetaedit replaced text\n');
  fs.writeFileSync(f.arm, '');
  const during = await query(c, 'betaedit');
  assert.ok(Array.isArray(during), 'query returns results, not an error');
  assert.ok(fired(f) && !armed(f), 'the lstat race was injected');
  assert.deepEqual(await query(c, 'betaedit'), []);
  assert.deepEqual(await query(c, 'alpha'), ['alpha.md']);
});
