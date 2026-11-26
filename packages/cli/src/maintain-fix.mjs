// SPDX-License-Identifier: MIT
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendLog, atomicWriteFile, parseFrontmatter, scanText } from '@brainatlas/core';
import {
  buildNameIndex,
  indexEntries,
  isRegularFile,
  keyOf,
  listWikiMarkdown,
  readOptionalText,
  resolveWikiName,
  runMaintenance,
  vaultRoot,
  withoutCode,
} from './maintain.mjs';

const SKIP_ROOT = new Set(['wiki/index.md', 'wiki/log.md']);
const WIKI_ARCHIVE_PREFIX = 'wiki/archive/';
const SOURCE_HEADING = 'Source files';
const UNSORTED_HEADING = 'Unsorted (maintain --fix)';
const SUMMARY_LIMIT = 160;
const WIKILINK = /(?<!!)\[\[([^\]\n]+)\]\]/gu;
const MARKDOWN_LINK = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/gu;
const EXTERNAL_OR_ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|[/\\#])/iu;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const H2_HEADING = /^ {0,3}##[ \t]+(.+?)[ \t]*$/u;
const H1_HEADING = /^ {0,3}#[ \t]+(.+?)[ \t]*$/u;
const ANY_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/u;
const SECTION_HEADING = /^ {0,3}#{1,2}(?:[ \t]|$)/u;
const INLINE_CODE = /`[^`\n]*`/gu;

const stripCr = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);
const failure = (code, message) => Object.assign(new Error(message), { code });
const verifyFailure = () => failure('E_FIX_VERIFY', 'Maintenance fix verification failed; nothing was written.');

const require = createRequire(import.meta.url);
let lockModule = null;

async function lockApi() {
  if (lockModule) return lockModule;
  const candidates = [];
  try {
    candidates.push(
      pathToFileURL(join(dirname(require.resolve('@brainatlas/mcp/package.json')), 'src', 'lock.mjs')).href
    );
    // eslint-disable-next-line no-empty
  } catch {}
  candidates.push(new URL('../../mcp/src/lock.mjs', import.meta.url).href);
  let cause = null;
  for (const url of candidates) {
    try {
      lockModule = await import(url);
      return lockModule;
    } catch (error) {
      cause = cause ?? error;
    }
  }
  const detail = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  throw failure('E_LOCK_UNAVAILABLE', `The Wiki write lock module could not be loaded${detail}.`);
}

function bodyOffset(lines) {
  if (!lines.length) return 0;
  const first = stripCr(lines[0]).replace(/^\uFEFF/u, '');
  if (first !== '---') return 0;
  for (let index = 1; index < lines.length; index++) if (stripCr(lines[index]) === '---') return index + 1;
  return lines.length;
}

function codeMask(lines, start = 0) {
  const mask = lines.map(() => null);
  const front = Math.min(start, lines.length);
  for (let index = 0; index < front; index++) mask[index] = new Uint8Array(lines[index].length + 1).fill(1);
  let fence = null;
  for (let index = front; index < lines.length; index++) {
    const line = stripCr(lines[index]);
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      mask[index] = new Uint8Array(line.length + 1).fill(1);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        !fenceMatch[2].trim()
      )
        fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      mask[index] = new Uint8Array(line.length + 1).fill(1);
      continue;
    }
    const flags = new Uint8Array(line.length + 1);
    for (const span of line.matchAll(INLINE_CODE)) flags.fill(1, span.index, span.index + span[0].length);
    mask[index] = flags;
  }
  return mask;
}

const isFenced = (mask, index) => Boolean(mask[index]) && mask[index][0] === 1;
const inCode = (mask, index, at) => Boolean(mask[index]) && mask[index][at] === 1;

function makeFile(path, text) {
  const entries = text.split('\n').map((line, src) => ({ text: line, src }));
  return {
    path,
    text,
    eol: text.includes('\r\n') ? '\r' : '',
    terminated: text.endsWith('\n'),
    lastSrc: text.endsWith('\n') ? -1 : entries.length - 1,
    entries,
    changes: [],
  };
}

const displayLine = (text) => (text === null ? null : text.replace(/\r$/u, ''));

const recordChange = (file, kind, entry, before, after) =>
  file.changes.push({ kind, entry, before: displayLine(before), after: displayLine(after) });

function insertAfter(file, anchor, texts) {
  const at = anchor ? file.entries.indexOf(anchor) + 1 : file.entries.length;
  return insertTexts(file, at, texts);
}

const sentinelIndex = (file) => (file.terminated && file.entries.length ? file.entries.length - 1 : -1);

function insertTexts(file, at, texts) {
  const previous = at > 0 ? file.entries[at - 1] : null;
  if (previous && previous.src === file.lastSrc && file.eol && !previous.text.endsWith(file.eol)) {
    previous.text = `${previous.text}${file.eol}`;
  }
  const added = texts.map((text) => ({
    text: file.eol && !text.endsWith(file.eol) ? `${text}${file.eol}` : text,
    src: null,
  }));
  const atEnd = at >= file.entries.length;
  file.entries.splice(at, 0, ...added);
  if (atEnd && !file.terminated) {
    file.entries.push({ text: '', src: null });
    file.terminated = true;
  }
  return added;
}

function appendBlock(file, texts) {
  const sentinel = sentinelIndex(file);
  const at = sentinel >= 0 ? sentinel : file.entries.length;
  const previous = at > 0 ? file.entries[at - 1] : null;
  const blankBefore = Boolean(previous && previous.text.trim() !== '');
  const block = [];
  if (blankBefore) block.push('');
  block.push(...texts);
  const added = insertTexts(file, at, block);
  const offset = blankBefore ? 1 : 0;
  return added.slice(offset, offset + texts.length);
}

const capitalize = (folder) => folder.charAt(0).toUpperCase() + folder.slice(1).toLowerCase();

function indexSectionAnchor(lines, mask, headingText) {
  const wanted = headingText.toLowerCase();
  for (let heading = 0; heading < lines.length; heading++) {
    if (isFenced(mask, heading)) continue;
    const match = H2_HEADING.exec(stripCr(lines[heading]));
    if (!match || match[1].trim().toLowerCase() !== wanted) continue;
    let end = lines.length;
    for (let index = heading + 1; index < lines.length; index++) {
      if (isFenced(mask, index)) continue;
      if (ANY_HEADING.test(stripCr(lines[index]))) {
        end = index;
        break;
      }
    }
    for (let index = end - 1; index > heading; index--) {
      if (isFenced(mask, index)) continue;
      if (stripCr(lines[index]).trimStart().startsWith('- ')) return index;
    }
    return heading;
  }
  return -1;
}

function encodeTarget(target) {
  try {
    return encodeURI(target).replace(/[()?#]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return target;
  }
}

function decodeEntry(entry) {
  try {
    return decodeURI(entry);
  } catch {
    return entry;
  }
}

function indexTitle(page, rel) {
  return pageTitle(page, rel).replace(/\s+/gu, ' ').trim().replace(/\]/gu, '\\]');
}

function pageTitle(page, rel) {
  if (typeof page.data.title === 'string' && page.data.title.trim()) return page.data.title.trim();
  const lines = page.body.split('\n');
  const mask = codeMask(lines);
  for (let index = 0; index < lines.length; index++) {
    if (isFenced(mask, index)) continue;
    const match = H1_HEADING.exec(stripCr(lines[index]));
    if (match && match[1].trim()) return match[1].trim();
  }
  return posix.basename(rel).replace(/\.md$/u, '');
}

function pageSummary(data) {
  const value =
    typeof data.summary === 'string' ? data.summary : typeof data.description === 'string' ? data.description : null;
  if (value === null) return '';
  const flat = value.replace(/\s+/gu, ' ').trim();
  if (!flat) return '';
  const points = Array.from(flat);
  return points.length > SUMMARY_LIMIT ? `${points.slice(0, SUMMARY_LIMIT - 1).join('')}…` : flat;
}

const indexLine = (page, rel) => {
  const summary = pageSummary(page.data);
  return `- [${indexTitle(page, rel)}](${encodeTarget(rel)})${summary ? ` — ${summary}` : ''}`;
};

async function listWikiSymlinks(root) {
  const out = [];
  const wiki = await lstat(join(root, 'wiki')).catch(() => null);
  if (!wiki || !wiki.isDirectory() || wiki.isSymbolicLink()) return out;
  async function visit(rel) {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith('.md')) {
          out.push(child);
          continue;
        }
        const target = await stat(join(root, child)).catch(() => null);
        if (target?.isDirectory()) out.push(child);
        continue;
      }
      if (entry.isDirectory()) await visit(child);
    }
  }
  await visit('wiki');
  return out.sort();
}

async function archiveIndex(root) {
  const byName = new Map();
  const base = join(root, 'archive');
  const info = await lstat(base).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return byName;
  async function visit(rel) {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = archiveKey(entry.name);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(child);
    }
  }
  await visit('archive');
  return byName;
}

const archiveKey = (name) => name.toLowerCase().replace(/\.md$/u, '');

const shortText = (value) => String(value).replace(/\s+/gu, ' ').slice(0, 120);
const linkKey = (path, target) => `${path}\u0000${shortText(target)}`;

function decodeTarget(href) {
  if (EXTERNAL_OR_ABSOLUTE.test(href)) return null;
  try {
    return decodeURI(href.split(/[?#]/u)[0]);
  } catch {
    return null;
  }
}

function resolveTarget(page, target) {
  if (!target) return null;
  return posix.normalize(posix.join(posix.dirname(page.path), target));
}

const resolveLink = (page, href) => resolveTarget(page, decodeTarget(href));

function archivedReplacement(raw, page, names, archive, state) {
  const pipe = raw.indexOf('|');
  const namePart = pipe < 0 ? raw : raw.slice(0, pipe);
  const target = namePart.split('#')[0].trim();
  const name = target ? keyOf(target).replace(/\.md$/u, '').trim() : '';
  if (!name) return null;
  if (resolveWikiName(names, name) !== null) return null;
  const key = linkKey(page.path, target);
  const base = archiveKey(posix.basename(target));
  const matches = base ? (archive.get(base) ?? []) : [];
  if (matches.length === 1) {
    const label = pipe < 0 ? target : raw.slice(pipe + 1).trim();
    state.fixed.add(key);
    return `${label} (archived: \`${matches[0]}\`)`;
  }
  if (matches.length > 1) {
    state.fixed.add(key);
    state.ambiguous.push({ path: page.path, detail: `${matches.length} archive files match "${target}"` });
  }
  return null;
}

function planArchived(file, page, names, archive, state) {
  const lines = file.text.split('\n');
  const mask = codeMask(lines);
  const start = bodyOffset(lines);
  for (let index = start; index < lines.length; index++) {
    if (isFenced(mask, index)) continue;
    const line = lines[index];
    if (!line.includes('[[')) continue;
    let out = '',
      cursor = 0,
      replaced = false;
    for (const match of line.matchAll(WIKILINK)) {
      if (inCode(mask, index, match.index)) continue;
      out += line.slice(cursor, match.index);
      cursor = match.index + match[0].length;
      const replacement = archivedReplacement(match[1], page, names, archive, state);
      out += replacement ?? match[0];
      if (replacement !== null) replaced = true;
    }
    if (!replaced) continue;
    out += line.slice(cursor);
    const entry = file.entries[index];
    entry.text = out;
    recordChange(file, 'archived-link', entry, line, out);
  }
  assertBodyChanges(file, start);
}

function linkedTargets(page) {
  const targets = new Set();
  for (const match of withoutCode(page.body).matchAll(MARKDOWN_LINK)) {
    const resolved = resolveLink(page, match[1]);
    if (resolved !== null) targets.add(resolved);
  }
  return targets;
}

async function planSources(file, page, root) {
  const entries = Array.isArray(page.data.sources) ? page.data.sources : [];
  const linked = linkedTargets(page);
  const wanted = [];
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry || seen.has(entry)) continue;
    if (!/^(?:raw|wiki|archive)\//u.test(entry)) continue;
    if (entry.split('/').some((part) => part === '..')) continue;
    seen.add(entry);
    if (linked.has(posix.normalize(entry))) continue;
    if (!(await isRegularFile(root, entry))) continue;
    wanted.push(entry);
  }
  if (!wanted.length) return;
  const lines = file.text.split('\n');
  const mask = codeMask(lines);
  const start = bodyOffset(lines);
  let anchor = null;
  for (let heading = lines.length - 1; heading >= start; heading--) {
    if (isFenced(mask, heading)) continue;
    const match = H2_HEADING.exec(stripCr(lines[heading]));
    if (!match || match[1].trim().toLowerCase() !== SOURCE_HEADING.toLowerCase()) continue;
    let later = false;
    for (let index = heading + 1; index < lines.length; index++) {
      if (isFenced(mask, index)) continue;
      if (SECTION_HEADING.test(stripCr(lines[index]))) {
        later = true;
        break;
      }
    }
    if (later) continue;
    let found = heading;
    for (let index = lines.length - 1; index > heading; index--) {
      if (isFenced(mask, index)) continue;
      if (stripCr(lines[index]).trimStart().startsWith('- ')) {
        found = index;
        break;
      }
    }
    anchor = file.entries[found];
    break;
  }
  const folder = posix.dirname(page.path);
  const texts = wanted.map((entry) => `- [${entry}](${encodeTarget(posix.relative(folder, entry))})`);
  const added = anchor ? insertAfter(file, anchor, texts) : appendBlock(file, [`## ${SOURCE_HEADING}`, ...texts]);
  const inserted = anchor ? added : added.slice(1);
  for (const entry of inserted) recordChange(file, 'source-link', entry, null, entry.text);
  assertBodyChanges(file, start);
}

function unclosedFrontmatter(lines, offset) {
  if (offset < lines.length) return false;
  const first = stripCr(lines[0] ?? '').replace(/^\uFEFF/u, '');
  return first === '---' && !lines.some((line, index) => index > 0 && stripCr(line) === '---');
}

async function planIndex(root, content, pages, files, unfixed, secretFilter = true) {
  const text = await readOptionalText(root, 'wiki/index.md');
  if (text === null) {
    unfixed.push({
      kind: 'index-missing',
      path: 'wiki/index.md',
      detail: 'the index is absent',
      reason: 'index-absent',
    });
    return { indexed: new Set(), added: new Set() };
  }
  const indexed = new Set();
  for (const entry of indexEntries(text)) {
    indexed.add(entry);
    indexed.add(decodeEntry(entry));
  }
  const added = new Set();
  const lines = text.split('\n');
  const offset = bodyOffset(lines);
  const start = unclosedFrontmatter(lines, offset) ? lines.length + 1 : offset;
  const mask = codeMask(lines, start);
  const file = makeFile('wiki/index.md', text);
  const originals = file.entries.slice();
  const anchors = new Map();
  for (const path of content) {
    const rel = path.slice('wiki/'.length);
    if (indexed.has(rel)) continue;
    const line = indexLine(pages.get(path), rel);
    const findings = secretFilter ? scanText(line) : [];
    if (findings.length) {
      const ruleIds = [...new Set(findings.map((item) => item.ruleId))].sort();
      unfixed.push({
        kind: 'index-missing',
        path,
        detail: `index line not written: secret filter (${ruleIds.join(',')})`,
        reason: 'secret-filter',
      });
      continue;
    }
    const folder = rel.includes('/') ? rel.split('/')[0] : '';
    let key = folder ? capitalize(folder) : '#unsorted';
    let anchor = anchors.get(key) ?? null;
    if (!anchor && folder) {
      const found = indexSectionAnchor(lines, mask, key);
      if (found >= 0) {
        anchor = originals[found];
        anchors.set(key, anchor);
      }
    }
    if (!anchor) {
      key = '#unsorted';
      anchor = anchors.get(key) ?? null;
      if (!anchor) {
        const found = indexSectionAnchor(lines, mask, UNSORTED_HEADING);
        if (found >= 0) anchor = originals[found];
        else [anchor] = appendBlock(file, [`## ${UNSORTED_HEADING}`]);
        anchors.set(key, anchor);
      }
    }
    const [entry] = insertAfter(file, anchor, [line]);
    recordChange(file, 'index-missing', entry, null, line);
    anchors.set(key, entry);
    added.add(path);
  }
  assertBodyChanges(file, start);
  if (file.changes.length) files.push(file);
  return { indexed, added };
}

function reportedLinkTarget(detail) {
  const match = /^wikilink target (?:not found|is ambiguous): "(.*)"$/u.exec(detail);
  return match ? match[1] : null;
}

async function computePlan(root, { sources, now, secretFilter = true }) {
  const pagePaths = await listWikiMarkdown(root);
  const loaded = await Promise.all(
    pagePaths.map(async (path) => {
      const raw = await readFile(join(root, path), 'utf8');
      const parsed = parseFrontmatter(raw);
      return { path, raw, data: parsed.data, body: parsed.body };
    })
  );
  const pages = new Map(loaded.map((page) => [page.path, page]));
  const content = pagePaths.filter((path) => !SKIP_ROOT.has(path));
  const unfixed = [];
  for (const path of await listWikiSymlinks(root)) {
    unfixed.push({ kind: 'symlink', path, detail: 'symbolic link is not followed', reason: 'symlink' });
  }
  const files = [];
  const { added } = await planIndex(root, content, pages, files, unfixed, secretFilter);
  const names = buildNameIndex(pagePaths, pages);
  const archive = await archiveIndex(root);
  const state = { fixed: new Set(), ambiguous: [] };
  const planned = await Promise.all(
    content.map(async (path) => {
      if (path.startsWith(WIKI_ARCHIVE_PREFIX)) return null;
      const page = pages.get(path);
      const file = makeFile(path, page.raw);
      planArchived(file, page, names, archive, state);
      if (sources) await planSources(file, page, root);
      return file.changes.length ? file : null;
    })
  );
  for (const file of planned) if (file) files.push(file);
  const report = await runMaintenance(root, { now });
  for (const item of report.findings) {
    if (item.kind === 'broken-link') {
      const target = reportedLinkTarget(item.detail);
      if (target !== null && state.fixed.has(linkKey(item.path, target))) continue;
      unfixed.push({ kind: 'broken-link', path: item.path, detail: item.detail, reason: 'unknown-target' });
    } else if (item.kind === 'orphan' && !added.has(item.path)) {
      unfixed.push({ kind: 'orphan', path: item.path, detail: item.detail, reason: 'report-only' });
    }
  }
  for (const item of state.ambiguous)
    unfixed.push({ kind: 'broken-link', path: item.path, detail: item.detail, reason: 'ambiguous-archive' });
  return { files, unfixed };
}

function assertBodyChanges(file, start) {
  for (const change of file.changes) {
    const at = change.entry.src === null ? file.entries.indexOf(change.entry) : change.entry.src;
    if (at < start) throw verifyFailure();
  }
  for (let index = 0; index < start && index < file.entries.length; index++) {
    if (file.entries[index].src === null) throw verifyFailure();
  }
}

function verifyFile(file) {
  const original = file.text.split('\n');
  const changed = new Map();
  for (const change of file.changes) if (change.entry.src !== null) changed.set(change.entry.src, change);
  let next = 0;
  for (const entry of file.entries) {
    if (entry.src === null) continue;
    if (entry.src !== next) throw verifyFailure();
    const change = changed.get(entry.src);
    const expected = change ? change.after : original[entry.src];
    if (change && change.before !== displayLine(original[entry.src])) throw verifyFailure();
    if (displayLine(entry.text) !== displayLine(expected)) throw verifyFailure();
    next += 1;
  }
  if (next !== original.length) throw verifyFailure();
}

function writePath(root, path) {
  const parts = path.split('/');
  if (!path.startsWith('wiki/') || path === 'wiki/log.md' || path.includes('\\') || path.includes('\0'))
    throw verifyFailure();
  if (parts.some((part) => !part || part === '.' || part === '..')) throw verifyFailure();
  return join(root, path);
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function resultOf(mode, files, unfixed, written, started) {
  const changes = [];
  for (const file of files) {
    for (const change of file.changes) {
      const at = file.entries.indexOf(change.entry);
      changes.push({
        kind: change.kind,
        path: file.path,
        line: change.entry.src === null ? at + 1 : change.entry.src + 1,
        before: change.before,
        after: change.after,
      });
    }
  }
  changes.sort((a, b) => byText(a.path, b.path) || a.line - b.line || byText(a.kind, b.kind));
  const counts = { 'index-missing': 0, 'archived-link': 0, 'source-link': 0 };
  for (const change of changes) if (Object.hasOwn(counts, change.kind)) counts[change.kind] += 1;
  unfixed.sort(
    (a, b) =>
      byText(a.path, b.path) || byText(a.reason, b.reason) || byText(a.kind, b.kind) || byText(a.detail, b.detail)
  );
  return { ok: true, mode, changes, unfixed, counts, written, durationMs: Date.now() - started };
}

export async function planFix(vault, options = {}) {
  const started = Date.now();
  const root = await vaultRoot(vault);
  const now = options.now instanceof Date && !Number.isNaN(options.now.valueOf()) ? options.now : new Date();
  const { files, unfixed } = await computePlan(root, {
    sources: options.sources === true,
    now,
    secretFilter: options.secretFilter !== false,
  });
  return resultOf('plan', files, unfixed, false, started);
}

export async function applyFix(vault, options = {}) {
  const started = Date.now();
  const root = await vaultRoot(vault);
  const sources = options.sources === true;
  const secretFilter = options.secretFilter !== false;
  const now = options.now instanceof Date && !Number.isNaN(options.now.valueOf()) ? options.now : new Date();
  const wiki = await lstat(join(root, 'wiki')).catch(() => null);
  if (!wiki || !wiki.isDirectory() || wiki.isSymbolicLink()) {
    const { files, unfixed } = await computePlan(root, { sources, now, secretFilter });
    return resultOf('apply', files, unfixed, false, started);
  }
  const { withLock, LOCK_FILE_NAME } = await lockApi();
  return withLock(join(root, 'wiki', LOCK_FILE_NAME), async () => {
    const { files, unfixed } = await computePlan(root, { sources, now, secretFilter });
    const ordered = files.slice().sort((a, b) => byText(a.path, b.path));
    for (const file of ordered) verifyFile(file);
    let written = false;
    for (const file of ordered) {
      await atomicWriteFile(writePath(root, file.path), file.entries.map((entry) => entry.text).join('\n'));
      await appendLog(root, { action: 'maintain-fix', path: file.path }, { now });
      written = true;
    }
    return resultOf('apply', ordered, unfixed, written, started);
  });
}

export function formatFix(result) {
  const paths = [...new Set(result.changes.map((change) => change.path))];
  const lines = [
    `BrainAtlas maintain --fix (${result.mode}): ${result.changes.length} change(s) in ${paths.length} file(s), ${result.unfixed.length} unfixed, ${result.durationMs} ms`,
  ];
  for (const path of paths) {
    lines.push(`  ${path}`);
    for (const change of result.changes) {
      if (change.path !== path) continue;
      if (change.before !== null) lines.push(`    - ${change.before}`);
      lines.push(`    + ${change.after}`);
    }
  }
  lines.push(`unfixed (${result.unfixed.length})`);
  for (const item of result.unfixed)
    lines.push(`  ${item.path}: ${item.reason}${item.detail ? ` ${item.detail}` : ''}`);
  return lines.join('\n');
}
