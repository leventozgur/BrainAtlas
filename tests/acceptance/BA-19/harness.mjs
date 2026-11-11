// SPDX-License-Identifier: MIT
// BA-19 independent acceptance harness (blind). Starts a real stdio MCP server against a temporary vault and talks to it
// through the MCP SDK client. BA19_TARGET=main runs the main checkout's server (executed only, never written).
// No network, no user paths: HOME and XDG_* are injected into the temporary directory.
import { mkdtemp, mkdir, writeFile, readdir, rm, lstat, readlink, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const TARGET = process.env.BA19_TARGET === 'main' ? 'main' : 'worktree';
export const SERVER_ROOT = TARGET === 'main'
  ? resolve(process.env.BA19_MAIN_ROOT || join(ROOT, '..', '..', 'BrainAtlas'))
  : ROOT;

// Runtime-built secret-shaped values; they match the product's content rules but are not real credentials.
export const SECRET_OPENAI = ['sk', 'proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-');
export const SECRET_GITHUB = ['gh' + 'p_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('');

const { defaultConfig } = await import(pathToFileURL(join(SERVER_ROOT, 'packages/core/src/config/index.mjs')).href);

/** Starts one stdio server for a fresh temporary vault. `files` maps wiki-relative paths to string or Buffer contents. */
export async function startServer(t, { files = {}, links = {}, wikiLink = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ba19-accept-'));
  const home = join(dir, 'home');
  const vault = join(dir, 'vault');
  const wiki = join(vault, 'wiki');
  await mkdir(home);
  await mkdir(vault, { recursive: true });
  if (wikiLink) {
    const outside = join(dir, 'outside-wiki');
    await mkdir(outside, { recursive: true });
    for (const [rel, content] of Object.entries(wikiLink)) {
      await mkdir(dirname(join(outside, rel)), { recursive: true });
      await writeFile(join(outside, rel), content);
    }
    await symlink(outside, wiki);
  } else {
    await mkdir(wiki, { recursive: true });
  }
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(wiki, rel)), { recursive: true });
    await writeFile(join(wiki, rel), content);
  }
  for (const [rel, target] of Object.entries(links)) {
    await mkdir(dirname(join(wiki, rel)), { recursive: true });
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
  const client = new Client({ name: 'ba19-blind-acceptance', version: '1.0.0' });
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

export async function readIndex(f) {
  return readFile(join(f.wiki, 'index.md'));
}

export async function readOrNull(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Lines of `before` and `after` as a single insertion: after === before[0..k) + inserted + before[k..). Returns { at, line }. */
export function singleInsertion(before, after) {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  assert.equal(b.length, a.length + 1, `expected exactly one added line, got ${b.length - a.length}`);
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  assert.deepEqual(b.slice(k + 1), a.slice(k), 'lines after the insertion point changed');
  return { at: k, line: b[k] };
}

/**
 * Independent CommonMark-subset reader for inline link destinations, written for this acceptance run (it does not use
 * the product or vendored parser). Fenced code blocks (``` or ~~~) are skipped. A destination ends at the first unescaped
 * `)` at depth zero; `\` before ASCII punctuation is an escape; whitespace makes the destination invalid (not a link).
 * @returns {{dest:string, line:number}[]}
 */
export function linkDestinations(text) {
  const out = [];
  let fence = null;
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && line.slice(marker[0].length).includes('`'))) { fence = marker[1]; continue; }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] !== '[') continue;
      let depth = 0;
      let close = -1;
      for (let j = i + 1; j < line.length; j++) {
        if (line[j] === '\\') { j++; continue; }
        if (line[j] === '[') depth++;
        else if (line[j] === ']') { if (depth === 0) { close = j; break; } depth--; }
      }
      if (close < 0 || line[close + 1] !== '(') continue;
      const dest = readDestination(line, close + 2);
      if (dest !== null) out.push({ dest, line: n + 1 });
    }
  }
  return out;
}
function readDestination(line, start) {
  let depth = 0;
  let s = '';
  for (let k = start; k < line.length; k++) {
    const c = line[k];
    if (c === '\\' && k + 1 < line.length && /[!-/:-@[-`{-~]/.test(line[k + 1])) { s += line[k + 1]; k++; continue; }
    if (/\s/.test(c)) return null;
    if (c === '(') { depth++; s += c; continue; }
    if (c === ')') { if (depth === 0) return s; depth--; s += c; continue; }
    s += c;
  }
  return null;
}

/** Lines of the section that starts at the first `## <name>` line (case-insensitive) and ends at the next `## ` heading. */
export function sectionLines(text, name) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => l.toLowerCase() === `## ${name}`.toLowerCase());
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return lines.slice(start + 1, end);
}

export const sortedKeys = (o) => Object.keys(o).sort();
