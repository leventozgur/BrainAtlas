// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BrainAtlasError, atomicWriteFile } from '../util/index.mjs';

const BEGIN = '<!-- brainatlas:begin -->';
const END = '<!-- brainatlas:end -->';

function fail(code, message) {
  throw new BrainAtlasError(code, message);
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isCli(ctx) {
  return ctx?.config?.channel === 'cli';
}
export function quote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
export function cliPayload(ctx, options = {}) {
  const shim = quote(options.emptyShim ? ctx.shimPath || '' : ctx.shimPath);
  return `Use BrainAtlas as evidence-first project memory. Before substantial project changes, search it from the shell: ${shim} wiki query "<project name and topic terms>" --json, then read only relevant pages with ${shim} wiki read <path> --json. Treat retrieved pages as evidence, verify them against the current repository, and cite page paths when reporting findings. If no relevant page exists, proceed from current evidence. These commands are read-only.`;
}
export function hookCommand(ctx, client, event, options = {}) {
  const node = options.fallback ? ctx.nodePath || 'node' : ctx.nodePath;
  const shim = options.fallback ? ctx.shimPath || '' : ctx.shimPath;
  return `${quote(node)} ${quote(shim)} hook ${client} ${event}`;
}
export function parseJson(text, options = {}) {
  if (text?.startsWith('\uFEFF')) fail('E_BOM', options.bomMessage || 'Configuration contains a UTF-8 BOM.');
  if (options.empty === 'exact' && text === '') return {};
  if (options.empty === 'blank' && text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    if (options.object && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error();
    return value;
  } catch (error) {
    if (error?.code) throw error;
    fail('E_CONFIG_PARSE', options.message || 'Configuration JSON is invalid.');
  }
}
const KEY_INDENT = /\n([\t ]+)"[^\n]+"\s*:/;
function indentOf(text, tabFallback = false, pattern = KEY_INDENT) {
  const match = text?.match(pattern);
  if (match) return match[1];
  return tabFallback && text?.includes('\n\t') ? '\t' : '  ';
}
export function stringifyJson(value, before, options = {}) {
  const indent = options.indent ?? indentOf(before, options.tabFallback, options.indentPattern);
  const trailing = options.trailingNewline ?? before?.endsWith('\n') ?? false;
  const newline = options.preserveLineEndings && before?.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(value, null, indent).replaceAll('\n', newline) + (trailing ? newline : '');
}
export async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export function readOptionalSync(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function readOriginal(record) {
  return readOptional(record);
}
export async function saveOriginal(record, data, options = {}) {
  if (!options.overwrite && (await readOptional(record)) !== null) return;
  await atomicWriteFile(record, data, options.mode === null ? {} : { mode: options.mode ?? 0o600 });
}
export async function clearOriginal(record) {
  try {
    await unlink(record);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
export function originalPath(stateDir, adapterId, file) {
  return join(stateDir, 'adapters', adapterId, 'originals', `${sha256(file)}.json`);
}
export function backupName(file, now, options = {}) {
  const date = now instanceof Date ? now : options.useNowValue === false ? new Date() : new Date(now || Date.now());
  const iso = date.toISOString();
  const stamp =
    options.style === 'dash'
      ? iso.replace(/[:.]/g, '-')
      : options.style === 'colon'
        ? iso.replaceAll(':', '-')
        : iso.replaceAll(':', '').replaceAll('-', '').replaceAll('.', '');
  return `${file}.bak.${stamp}`;
}
export function managedBlock(text, options = {}) {
  const malformed = options.malformedMessage || 'Managed instructions block is damaged.';
  const edited = options.editedMessage || 'Managed instructions block was edited.';
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + 1) >= 0 || text.indexOf(END, end + 1) >= 0)
    fail('E_MANAGED_BLOCK_EDITED', malformed);
  const block = text.slice(start, end + END.length);
  if (options.permissive) {
    const match = block.match(/<!-- brainatlas:sha256:([a-f0-9]{64}) -->/);
    const bodyStart = match ? block.indexOf(match[0]) + match[0].length : -1;
    const body =
      bodyStart < 0
        ? ''
        : block.slice(bodyStart, block.lastIndexOf(END)).replace(/\r\n/g, '\n').replace(/^\n/, '').replace(/\n$/, '');
    if (!match || sha256(body) !== match[1]) fail('E_MANAGED_BLOCK_EDITED', edited);
    return { start, end: end + END.length, block, hash: match[1], body };
  }
  const match = options.crlf
    ? block.match(/<!-- brainatlas:sha256:([a-f0-9]{64}) -->\r?\n([\s\S]*?)\r?\n<!-- brainatlas:end -->$/)
    : block.match(/<!-- brainatlas:sha256:([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- brainatlas:end -->$/);
  if (!match) fail('E_MANAGED_BLOCK_EDITED', edited);
  const body = options.crlf ? match[2].replaceAll('\r\n', '\n') : match[2];
  if (sha256(body) !== match[1]) fail('E_MANAGED_BLOCK_EDITED', edited);
  return { start, end: end + END.length, block, hash: match[1], body };
}
export function putBlock(before, block, options = {}) {
  const prior = managedBlock(before, options);
  if (prior) return before.slice(0, prior.start) + block + before.slice(prior.end);
  return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${block}\n`;
}
export function restorable(prefix, suffix, original) {
  if (typeof original !== 'string' || suffix.trim() !== '') return false;
  const normalized = (value) => value.replaceAll('\r\n', '\n').replace(/\n+$/u, '');
  return normalized(prefix) === normalized(original);
}
export function hasParentSegment(value, separator) {
  return typeof value === 'string' && value.split(separator || /[\\/]+/).includes('..');
}
