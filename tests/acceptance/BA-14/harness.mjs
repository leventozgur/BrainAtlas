// SPDX-License-Identifier: MIT
// BA-14 independent acceptance harness. Starts a real stdio MCP server (the worktree build by default, or the main
// checkout when BA14_TARGET=main) against a temporary vault and talks to it through the SDK client.
import { mkdtemp, mkdir, writeFile, readdir, rm, lstat, readlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const TARGET = process.env.BA14_TARGET === 'main' ? 'main' : 'worktree';
// Main checkout is a sibling of the worktree directory tree; it is only ever executed, never written.
export const SERVER_ROOT = TARGET === 'main' ? resolve(process.env.BA14_MAIN_ROOT || join(ROOT, '..', '..', 'BrainAtlas')) : ROOT;
// Runtime-built, secret-shaped fixture value (same shape the repo's privacy scanner detects).
export const SECRET = ['sk', 'proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-');

/** Starts one server for a fresh temporary vault. `files` maps wiki-relative paths to contents (string or Buffer). */
export async function startServer(t, { files = {}, links = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ba14-accept-'));
  const home = join(dir, 'home');
  const vault = join(dir, 'vault');
  const wiki = join(vault, 'wiki');
  await mkdir(home);
  await mkdir(wiki, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(wiki, rel)), { recursive: true });
    await writeFile(join(wiki, rel), content);
  }
  for (const [rel, target] of Object.entries(links)) {
    await mkdir(dirname(join(wiki, rel)), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(target, join(wiki, rel));
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
  const client = new Client({ name: 'ba14-blind-acceptance', version: '1.0.0' });
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
export function refused(r, code) {
  assert.equal(r.isError, true, 'expected a refusal but the call succeeded');
  if (code) assert.match(textOf(r), new RegExp(code));
}

/** Byte-level snapshot of every file under a directory (symlinks recorded as links, not followed). */
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

export async function readOrNull(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Number of log lines that record the given action (the log is append-only). */
export async function logCount(wiki, action) {
  const raw = await readOrNull(join(wiki, 'log.md'));
  return raw ? raw.toString('utf8').split('\n').filter((line) => line.includes(action)).length : 0;
}
