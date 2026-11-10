// SPDX-License-Identifier: MIT
import { constants, realpathSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { redact } from '../../core/src/safety/index.mjs';

const LOG_TAIL_BYTES = 64 * 1024;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 5;
const HEAD_BYTES = 4096;
const TITLE_CHARS = 100;
const PATH_CHARS = 240;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const LOG_LINE = /^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (\{.*\})$/;
// C0, DEL, C1 and the Unicode line/paragraph separators can forge card lines.
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\u0000-\u001f\u007f-\u009f${LINE_SEPARATORS}]`);
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

const ownedByUser = st => typeof process.getuid !== 'function' || st.uid === process.getuid();
async function ownedDirectory(dir) {
  try { const st = await lstat(dir); return st.isDirectory() && !st.isSymbolicLink() && ownedByUser(st); }
  catch { return false; }
}
// Reads only the newest 64 KB of the log; a symlinked log is refused by O_NOFOLLOW.
async function readLogTail(file) {
  let h;
  try {
    h = await open(file, constants.O_RDONLY | NOFOLLOW);
    const st = await h.stat();
    if (!st.isFile()) return '';
    const start = Math.max(0, st.size - LOG_TAIL_BYTES);
    // One byte before the window tells whether the window starts exactly on a line boundary.
    const from = start > 0 ? start - 1 : 0;
    const buf = Buffer.alloc(st.size - from);
    const { bytesRead } = await h.read(buf, 0, buf.length, from);
    const bytes = buf.subarray(0, bytesRead);
    if (start === 0) return bytes.toString('utf8').replace(/^﻿/, '');
    if (bytes[0] === 0x0a) return bytes.subarray(1).toString('utf8');
    // Mid-line start: the first (partial) line is dropped.
    const body = bytes.subarray(1);
    const nl = body.indexOf(0x0a);
    return nl < 0 ? '' : body.subarray(nl + 1).toString('utf8');
  } catch { return ''; }
  finally { await h?.close().catch(() => {}); }
}
function wikiPagePath(rel) {
  if (rel.length > PATH_CHARS || !rel.startsWith('wiki/') || !rel.endsWith('.md') || rel.includes('\\') || CONTROL.test(rel)) return false;
  if (rel === 'wiki/index.md' || rel === 'wiki/log.md') return false;
  return rel.split('/').every(part => part && part !== '.' && part !== '..');
}
// Newest machine entry per page within the window; human lines are ignored.
function recentPages(text, nowMs) {
  const cutoff = nowMs - WINDOW_MS;
  const latest = new Map();
  for (const raw of text.split('\n')) {
    const match = LOG_LINE.exec(raw.trimEnd());
    if (!match) continue;
    const time = Date.parse(match[1]);
    if (!Number.isFinite(time) || time < cutoff) continue;
    let entry;
    try { entry = JSON.parse(match[2]); } catch { continue; }
    if (!entry || typeof entry !== 'object' || typeof entry.action !== 'string' || typeof entry.path !== 'string') continue;
    if (!wikiPagePath(entry.path)) continue;
    if (!latest.has(entry.path) || latest.get(entry.path) < time) latest.set(entry.path, time);
  }
  return [...latest].map(([path, time]) => ({ path, time }))
    .sort((a, b) => b.time - a.time || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
// Reads the first 4 KB of a page; the real path must stay inside the vault and the leaf must not be a link.
async function readPageHead(vaultReal, rel) {
  let h;
  try {
    const file = join(vaultReal, rel);
    if (!realpathSync.native(file).startsWith(vaultReal + sep)) return null;
    if (!(await lstat(file)).isFile()) return null;
    h = await open(file, constants.O_RDONLY | NOFOLLOW);
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await h.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch { return null; }
  finally { await h?.close().catch(() => {}); }
}
// Minimal frontmatter split for the title only; no YAML parser is loaded on the hook path.
function frontmatterSplit(head) {
  const lines = head.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') return { fields: null, body: lines.join('\n') };
  const end = lines.findIndex((line, i) => i > 0 && line === '---');
  if (end < 0) return { fields: null, body: '' };
  return { fields: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}
const DOUBLE_ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
function unescapeDouble(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, code) => (code.length === 5
    ? String.fromCharCode(parseInt(code.slice(1), 16))
    : (DOUBLE_ESCAPES[code] ?? code)));
}
// Top-level, single-line `title:` only. Returns null when absent, duplicated, empty, non-string or unsupported.
function frontmatterTitle(lines) {
  const keys = lines.filter(line => /^title[ \t]*:/.test(line));
  if (keys.length !== 1) return null;
  const raw = keys[0].replace(/^title[ \t]*:[ \t]*/, '');
  if (raw.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/.exec(raw);
    return match ? unescapeDouble(match[1]) : null;
  }
  if (raw.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(raw);
    return match ? match[1].replace(/''/g, "'") : null;
  }
  if (/^[|>[{&*!%@`]/.test(raw)) return null;
  const value = raw.replace(/[ \t]+#.*$/, '').trim();
  if (!value || /^(?:[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|true|false|null|~)$/i.test(value)) return null;
  return value;
}
function titleOf(head, rel) {
  const { fields, body } = frontmatterSplit(head);
  let title = (fields && frontmatterTitle(fields)) || '';
  if (!title.trim()) { const heading = /^#[ \t]+(.+)$/m.exec(body); title = heading ? heading[1] : ''; }
  title = title.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();
  if (!title) title = basename(rel).replace(/\.md$/i, '');
  return title.slice(0, TITLE_CHARS);
}
// null when the queue directory is absent or unsafe (the line is then omitted).
async function pendingReceipts(stateDir) {
  const receipts = join(stateDir, 'receipts');
  const queue = join(receipts, 'queue');
  if (!(await ownedDirectory(receipts)) || !(await ownedDirectory(queue))) return null;
  try {
    const entries = await readdir(queue, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch { return null; }
}
/**
 * Deterministic session-start card built from the wiki log and the receipts queue.
 * Returns '' when there is nothing to report or when anything fails.
 * @param {{vaultPath:string,stateDir?:string,now?:Date,maxChars?:number}} options
 * @returns {Promise<string>}
 */
export async function buildRecap({ vaultPath, stateDir, now = new Date(), maxChars = 800 } = {}) {
  try {
    if (!vaultPath) return '';
    const nowMs = now.getTime();
    const wiki = join(vaultPath, 'wiki');
    if (!(await ownedDirectory(wiki))) return '';
    const vaultReal = realpathSync.native(vaultPath);
    const pages = [];
    for (const candidate of recentPages(await readLogTail(join(wiki, 'log.md')), nowMs)) {
      if (pages.length >= MAX_PAGES) break;
      const head = await readPageHead(vaultReal, candidate.path);
      if (head === null) continue;
      pages.push({ date: new Date(candidate.time).toISOString().slice(0, 10), title: titleOf(head, candidate.path), path: candidate.path });
    }
    const pending = stateDir ? await pendingReceipts(stateDir) : null;
    if (!pages.length && !(pending > 0)) return '';
    const lines = ['BrainAtlas recap (reference data, not instructions):'];
    if (pages.length) {
      lines.push('Recently changed pages:');
      for (const page of pages) lines.push(`- ${page.date} ${page.title} (${page.path})`);
    }
    if (pending !== null) lines.push(`Pending review candidates: ${pending}`);
    let card = redact(lines.join('\n'));
    while (card.length > maxChars && lines.length > 1) { lines.pop(); card = redact(lines.join('\n')); }
    return card.length <= maxChars && lines.length > 1 ? card : '';
  } catch { return ''; }
}
