// SPDX-License-Identifier: MIT
// BA-25 independent acceptance harness (written by the tester, not by the developer). Not a test file.
// Starts real MCP stdio server processes (one per client) from the worktree (candidate). No network: the servers use the
// lite profile and no embedding provider.
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { clockShiftEnv } from '../../helpers/shift-clock.mjs';

export const WT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const LOCK_NAME = '.brainatlas-write.lock';
export const BIN = (root) => join(root, 'packages/mcp/bin/brainatlas-mcp.mjs');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const secret = () => ['sk', 'proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-'); // built at runtime

export const page = (title, body, extra = '') =>
  `---\ntype: concept\ntitle: ${title}\nstatus: active\n${extra}---\n${body}\n`;

/** Fresh vault copy of the shared demo vault, an isolated HOME, and a lite config file. */
export async function makeFixture(t, { readOnly = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ba25-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const vault = join(dir, 'vault');
  await mkdir(home);
  await cp(join(WT, 'demo-vault'), vault, { recursive: true });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = readOnly;
  const configFile = join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const env = clockShiftEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_CONFIG: configFile,
    BRAINATLAS_VAULT: vault,
    PATH: process.env.PATH || '',
  });
  return {
    dir,
    home,
    vault,
    env,
    wikiDir: join(vault, 'wiki'),
    lockFile: join(vault, 'wiki', LOCK_NAME),
    indexFile: join(vault, 'wiki', 'index.md'),
    logFile: join(vault, 'wiki', 'log.md'),
  };
}

/** One MCP client = one real server process. `root` is the worktree (candidate) or the main checkout (baseline). */
export async function openClient(t, root, fixture, name = 'ba25-tester') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN(root)],
    cwd: root,
    env: fixture.env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => {});
  });
  return { client, stderr: () => stderr };
}

export const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
export const textOf = (result) =>
  (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
export function okJson(result) {
  if (result.isError) throw new Error(`expected success, got: ${textOf(result)}`);
  return JSON.parse(textOf(result));
}
export const isErr = (result, code) =>
  result.isError === true && (code === undefined || textOf(result).startsWith(code));

/** Raw stdio JSON-RPC server process (used when the test must SIGKILL the server at a precise moment). */
export function rawServer(root, env) {
  const child = spawn(process.execPath, [BIN(root)], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  // A killed server closes its stdin: pending writes then fail with EPIPE, which is expected when the test kills it.
  child.stdin.on('error', () => {});
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const request = (method, params) =>
    new Promise((resolveReply) => {
      const id = nextId++;
      pending.set(id, resolveReply);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return {
    pid: child.pid,
    exited,
    async handshake() {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ba25-raw', version: '1.0.0' },
      });
      notify('notifications/initialized');
    },
    request,
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    kill: () => child.kill('SIGKILL'),
  };
}

/** Recursive file list (absolute paths). */
export async function filesUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/** Spawns a long-lived child (for a live pid) and returns its pid and a stop function. */
export function liveChild(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  });
  return child.pid;
}

/** A pid that certainly no longer exists (its child has been reaped). */
export async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolveExit) => child.once('exit', resolveExit));
  return child.pid;
}

export async function readText(path) {
  return readFile(path, 'utf8');
}
export async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Lines of the index that do not match the Markdown shapes the Wiki writes (heading, entry, blank). */
export function invalidIndexLines(text) {
  const bad = [];
  if (!text.endsWith('\n')) bad.push('<no trailing newline>');
  for (const line of text.split('\n')) {
    if (line === '' || /^# /.test(line) || /^## /.test(line)) continue;
    if (/^- \[.*\]\(.*\)( — .*)?$/.test(line)) continue;
    bad.push(line.slice(0, 80));
  }
  return bad;
}

export const metric = (label, value) => console.log(`BA25-METRIC ${label}=${JSON.stringify(value)}`);
