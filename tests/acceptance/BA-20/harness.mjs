// SPDX-License-Identifier: MIT
// BA-20 independent acceptance harness (blind). Starts a real stdio MCP server against a temporary vault and talks to it
// through the MCP SDK client. BA20_TARGET=main runs the main checkout's server (executed only, never written).
// No network, no user paths: HOME and XDG_* are injected into the temporary directory.
import { mkdtemp, mkdir, writeFile, readdir, rm, lstat, readlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const TARGET = process.env.BA20_TARGET === 'main' ? 'main' : 'worktree';
export const SERVER_ROOT = TARGET === 'main'
  ? resolve(process.env.BA20_MAIN_ROOT || join(ROOT, '..', '..', 'BrainAtlas'))
  : ROOT;

const { defaultConfig } = await import(pathToFileURL(join(SERVER_ROOT, 'packages/core/src/config/index.mjs')).href);

/**
 * Starts one stdio server for a fresh temporary vault.
 * `files` maps wiki-relative paths to string contents (written directly to disk, so any file name can be used).
 */
export async function startServer(t, { files = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ba20-accept-'));
  const home = join(dir, 'home');
  const vault = join(dir, 'vault');
  const wiki = join(vault, 'wiki');
  await mkdir(home);
  await mkdir(wiki, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(wiki, rel)), { recursive: true });
    await writeFile(join(wiki, rel), content);
  }
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = false;
  const configFile = join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(SERVER_ROOT, 'packages/mcp/bin/brainatlas-mcp.mjs')],
    cwd: SERVER_ROOT,
    env: {
      HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
      BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH || ''
    },
    stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new Client({ name: 'ba20-blind-acceptance', version: '1.0.0' });
  t.after(async () => {
    try { await client.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  await client.connect(transport);
  return { dir, home, vault, wiki, client, stderr: () => stderr };
}

export const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
export const textOf = (r) => (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
export function okJson(r) {
  assert.notEqual(r.isError, true, `unexpected refusal: ${textOf(r)}`);
  return JSON.parse(textOf(r));
}
/** Asserts a refusal and returns its text (the text is fixed server wording, never caller content). */
export function refused(r, code) {
  assert.equal(r.isError, true, 'expected a refusal but the call succeeded');
  if (code) assert.match(textOf(r), new RegExp(code));
  return textOf(r);
}

/** Byte-level snapshot of every entry under a directory (symlinks recorded as links, not followed). */
export async function snapshot(dir) {
  const out = {};
  async function walk(rel) {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = join(rel, entry.name);
      const abs = join(dir, child);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) out[child] = `LINK->${await readlink(abs)}`;
      else if (st.isDirectory()) await walk(child);
      else out[child] = (await readFile(abs)).toString('base64');
    }
  }
  await walk('.');
  return out;
}

export async function readIndexText(f) {
  return (await readFile(join(f.wiki, 'index.md'))).toString('utf8');
}

/** Entry lines of the index (lines that start with "- [" ). */
export function entryLines(text) {
  return text.split('\n').filter((line) => line.startsWith('- ['));
}

/** Any C0, DEL, C1, U+2028 or U+2029 character. */
export const CONTROL_RE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]');
