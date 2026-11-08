// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { redact } from '../../../packages/core/src/safety/index.mjs';
import { appendLog, upsertIndexEntry } from '../../../packages/core/src/vault/index.mjs';
import { atomicWriteFile, resolveSafePath } from '../../../packages/core/src/util/index.mjs';
import { BrainAtlasError } from '../../../packages/core/src/util/errors.mjs';

const CLIENTS = new Set(['claude', 'codex', 'kiro']);
const ID = /^[a-f0-9-]{36}$/u;
const TEXT_LIMIT = 2000;
const fail = (code, message) => new BrainAtlasError(code, message);
const safeText = (value, limit = TEXT_LIMIT) => redact(String(value ?? '').slice(0, limit))
  .replace(/\/(?:Users|home|private|tmp|var|opt|etc|Applications)\/[^\s)\]>'"]+/g, '/home/you/[path]')
  .replace(/[A-Za-z]:\\Users\\[^\s)\]>'"]+/g, 'C:\\Users\\you\\[path]');
const digest16 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);

function paths(ctx) {
  const stateDir = ctx?.paths?.stateDir;
  const vault = ctx?.config?.vault?.path;
  if (typeof stateDir !== 'string' || typeof vault !== 'string') throw fail('E_RECEIPT_CONTEXT', 'Receipt context is incomplete.');
  return { stateDir: resolve(stateDir), vault: resolve(vault) };
}

function normalizeCandidates(value) {
  const values = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return values.slice(0, 20).filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
    title: safeText(item.title, 240),
    summary: safeText(item.summary, 4000),
    suggestedPath: safeText(item.suggestedPath, 240),
    sources: Array.isArray(item.sources) ? item.sources.slice(0, 20).map((source) => safeText(source, 500)) : [],
  })).filter((item) => item.title || item.summary);
}

function assertOwnedDirectory(info) {
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw fail('E_RECEIPT_STATE_UNSAFE', 'Receipt state directory is unsafe.');
  }
}
async function secureQueueDirectory(ctx, { create = false, child } = {}) {
  const { stateDir } = paths(ctx);
  if (create) await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let stateInfo;
  try { stateInfo = await lstat(stateDir); }
  catch (cause) {
    if (!create && cause.code === 'ENOENT') return null;
    throw cause;
  }
  assertOwnedDirectory(stateInfo);
  let current = stateDir;
  for (const part of ['receipts', 'queue', ...(child ? [child] : [])]) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    }
    let info;
    try { info = await lstat(current); }
    catch (cause) {
      if (!create && cause.code === 'ENOENT') return null;
      throw cause;
    }
    assertOwnedDirectory(info);
  }
  return current;
}
function checkId(id) { if (typeof id !== 'string' || !ID.test(id)) throw fail('E_RECEIPT_ID', 'Receipt id is invalid.'); return id; }
async function readReceipt(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || info.size > 128 * 1024) throw new Error();
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || !ID.test(value.id) || !Array.isArray(value.candidates)) throw new Error();
    return value;
  } catch { throw fail('E_RECEIPT_NOT_FOUND', 'Receipt is unavailable or invalid.'); }
}

/** Persist a bounded, redacted session-end receipt using only the event payload. */
export async function onSessionEnd(ctx, hookInput = {}) {
  const client = hookInput?.client;
  if (!CLIENTS.has(client)) return null;
  const id = randomUUID();
  const receipt = {
    id,
    client,
    createdAt: (ctx.now instanceof Date ? ctx.now : new Date()).toISOString(),
    session: digest16(hookInput.session_id ?? hookInput.sessionId),
    candidates: normalizeCandidates(hookInput.brainatlas_receipt),
  };
  const directory = await secureQueueDirectory(ctx, { create: true });
  const target = await resolveSafePath(directory, `${id}.json`);
  await atomicWriteFile(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { id, queued: true, candidates: receipt.candidates.length };
}

export async function listReceipts(ctx) {
  const directory = await secureQueueDirectory(ctx);
  if (!directory) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !ID.test(entry.name.slice(0, -5)) || !entry.name.endsWith('.json')) continue;
    try { items.push(await readReceipt(join(directory, entry.name))); } catch { /* invalid records are not displayed */ }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function showReceipt(ctx, id) {
  const directory = await secureQueueDirectory(ctx);
  if (!directory) throw fail('E_RECEIPT_NOT_FOUND', 'Receipt is unavailable or invalid.');
  return readReceipt(await resolveSafePath(directory, `${checkId(id)}.json`));
}

function pagePath(receipt, candidate, index) {
  const suggested = candidate.suggestedPath;
  if (typeof suggested === 'string' && /^wiki\/(?:entities|concepts|sources|summaries)\/[a-z0-9][a-z0-9._/-]*\.md$/i.test(suggested)
      && !suggested.split('/').some((part) => part === '..')) return suggested;
  const slug = safeText(candidate.title, 100).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `receipt-${receipt.id.slice(0, 8)}-${index + 1}`;
  return `wiki/summaries/${slug}.md`;
}

function pageContent(candidate, receipt) {
  const generated = receipt.createdAt.slice(0, 10);
  const sources = candidate.sources.map((source) => `  - ${JSON.stringify(source)}`).join('\n');
  const title = safeText(candidate.title, 240).replace(/[\r\n]/g, ' ');
  const summary = safeText(candidate.summary, 4000);
  return `---\ntype: summary\ngenerated: "${generated}"\nstatus: proposed\nsources:${sources ? `\n${sources}` : ' []'}\nverified: []\nstale_after: "P90D"\n---\n\n# ${title}\n\n${summary}\n`;
}

/** Human approval is the sole path from the queue into the vault. */
export async function approveReceipt(ctx, id, { edit } = {}) {
  const receipt = await showReceipt(ctx, id);
  const { vault } = paths(ctx);
  const approved = [];
  for (let i = 0; i < receipt.candidates.length; i++) {
    const candidate = receipt.candidates[i];
    if (edit && edit[i]) {
      if (edit[i].title !== undefined) candidate.title = safeText(edit[i].title, 240);
      if (edit[i].summary !== undefined) candidate.summary = safeText(edit[i].summary, 4000);
      if (edit[i].suggestedPath !== undefined) candidate.suggestedPath = safeText(edit[i].suggestedPath, 240);
    }
    const rel = pagePath(receipt, candidate, i);
    const target = await resolveSafePath(vault, rel);
    await mkdir(dirname(target), { recursive: true });
    await atomicWriteFile(target, pageContent(candidate, receipt), { mode: 0o600 });
    await upsertIndexEntry(vault, { path: rel, title: safeText(candidate.title, 240) || 'Receipt proposal' });
    await appendLog(vault, { action: 'receipt-approved', path: rel }, { now: new Date(receipt.createdAt) });
    approved.push(rel);
  }
  const source = await resolveSafePath(await secureQueueDirectory(ctx), `${receipt.id}.json`);
  const rejected = await secureQueueDirectory(ctx, { create: true, child: 'approved' });
  await rename(source, join(rejected, `${receipt.id}.json`));
  return { id: receipt.id, approved };
}

export async function rejectReceipt(ctx, id) {
  const receipt = await showReceipt(ctx, id);
  const source = await resolveSafePath(await secureQueueDirectory(ctx), `${receipt.id}.json`);
  const destinationDir = await secureQueueDirectory(ctx, { create: true, child: 'rejected' });
  await rename(source, join(destinationDir, `${receipt.id}.json`));
  return { id: receipt.id, rejected: true };
}

export async function activate(ctx) {
  paths(ctx);
}

export const commands = Object.freeze({
  review: async (args = [], ctx) => {
    if (!Array.isArray(args)) throw fail('E_ARGUMENT', 'Use review list|show <id>|approve <id> [--edit]|reject <id>.');
    const [action, id, ...flags] = args;
    if (action === 'list' && args.length === 1) return listReceipts(ctx);
    if (action === 'show' && id && args.length === 2) return showReceipt(ctx, id);
    if (action === 'approve' && id && flags.every((flag) => flag === '--edit')) return approveReceipt(ctx, id);
    if (action === 'reject' && id && args.length === 2) return rejectReceipt(ctx, id);
    throw fail('E_ARGUMENT', 'Use review list|show <id>|approve <id> [--edit]|reject <id>.');
  },
});
