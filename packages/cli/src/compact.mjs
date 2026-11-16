// SPDX-License-Identifier: MIT
// `brainatlas compact`: move older dated H2 sections of one Wiki page verbatim into wiki/archive/<name>-history.md.
// `--plan` only reads. `--apply` writes the archive page, then the page, then one log entry, inside the Wiki write lock.
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendLog, atomicWriteFile, parseFrontmatter } from '@brainatlas/core';

const H2_START = /^##[ \t]+\S/u;
const H1_START = /^#[ \t]+\S/u;
const DATE_PATTERN = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu;
const BACK_LINK_HEADING = '## Archived history';
const BACK_LINK_TEXT = 'Older dated sections were moved verbatim to';
const MAX_KEEP = 1000;
const DEFAULT_KEEP = 3;
// The reserved-name check runs before the lock module is loaded, so it uses this literal; the lock path itself takes the
// name from the loaded module (packages/mcp/src/lock.mjs). A test pins the two together.
export const RESERVED_LOCK_FILE_NAME = '.brainatlas-write.lock';
const ARCHIVE_DIRECTORY = 'wiki/archive';

const failure = (code, message) => Object.assign(new Error(message), { code });
const pathEscape = () => failure('E_PATH_ESCAPE', 'Page path escapes the vault or is not a regular file.');
const notFound = () => failure('E_NOT_FOUND', 'Page not found in the vault.');
const conflict = () => failure('E_CONFLICT', 'The archive page belongs to another page.');
const selfCheckFailed = () => failure('E_INTERNAL', 'Compaction self-check failed; nothing was written.');

const require = createRequire(import.meta.url);
let lockModule = null;

/**
 * The Wiki write lock module, or E_LOCK_UNAVAILABLE. It is imported only by `--apply`, after the argument and path checks,
 * so a missing or broken MCP package never breaks the other CLI commands that import this module.
 */
async function lockApi() {
  if (lockModule) return lockModule;
  const candidates = [];
  try {
    candidates.push(pathToFileURL(join(dirname(require.resolve('@brainatlas/mcp/package.json')), 'src', 'lock.mjs')).href);
  } catch { /* no installed MCP package: use the sibling copy below */ }
  candidates.push(new URL('../../mcp/src/lock.mjs', import.meta.url).href);
  let cause = null;
  for (const url of candidates) {
    try { lockModule = await import(url); return lockModule; }
    catch (error) { cause = cause ?? error; }
  }
  const detail = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  throw failure('E_LOCK_UNAVAILABLE', `The Wiki write lock module could not be loaded${detail}.`);
}

const stripCr = line => (line.endsWith('\r') ? line.slice(0, -1) : line);
const countWords = text => text.trim().split(/\s+/u).filter(Boolean).length;
const asPosix = path => path.split(sep).join('/');

/** A back-link line: outside fences, with a trailing `\r` and trailing spaces/tabs removed, it is exactly the heading. */
const isBackLinkLine = line => stripCr(line).replace(/[ \t]+$/u, '') === BACK_LINK_HEADING;

/** Vault root as a real directory outside any symlink. */
async function vaultRoot(vault) {
  const missing = () => failure('E_NOT_FOUND', 'Vault is missing or not a directory.');
  if (typeof vault !== 'string' || !vault) throw missing();
  let root;
  try { root = await realpath(resolve(vault)); } catch { throw missing(); }
  const info = await lstat(root).catch(() => null);
  if (!info || !info.isDirectory()) throw missing();
  return root;
}

/** True for a vault-relative POSIX path that may never be compacted. The argument must already be lower-cased. */
function reservedPath(rel) {
  if (rel === 'wiki/index.md' || rel === 'wiki/log.md') return true;
  if (rel.startsWith(`${ARCHIVE_DIRECTORY}/`)) return true;
  const parts = rel.split('/');
  return parts[parts.length - 1] === RESERVED_LOCK_FILE_NAME;
}

/** A relative `wiki/...md` path that is allowed to be compacted. Reserved names are compared case-insensitively. */
function invalidPagePath(page) {
  if (typeof page !== 'string' || !page) return true;
  if (!page.startsWith('wiki/') || !page.endsWith('.md') || page.includes('\\') || page.includes('\0')) return true;
  const parts = page.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return true;
  return reservedPath(page.toLowerCase());
}

/** Checks a resolved path against the vault root and the reserved names; returns the vault-relative POSIX path. */
function checkedRelative(root, real) {
  const from = relative(root, real);
  if (!from || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)) throw pathEscape();
  const posix = asPosix(from);
  if (!posix.startsWith('wiki/') || reservedPath(posix.toLowerCase())) throw pathEscape();
  return posix;
}

/** The page file, after verifying every component from the vault root down to it. No symlink is followed. */
async function checkedPageFile(root, page) {
  if (invalidPagePath(page)) throw pathEscape();
  const parts = page.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const next = join(current, parts[index]);
    const info = await lstat(next).catch(error => {
      if (error?.code === 'ENOENT') throw notFound();
      if (error?.code === 'ENOTDIR') throw pathEscape();
      throw error;
    });
    if (info.isSymbolicLink()) throw pathEscape();
    const last = index === parts.length - 1;
    if (last ? !info.isFile() : !info.isDirectory()) throw pathEscape();
    current = next;
  }
  const real = await realpath(current).catch(() => null);
  if (!real) throw notFound();
  // The real path may differ from the requested one in case only (case-insensitive file systems): re-check the rules
  // against it so `wiki/LOG.md` and `wiki/Archive/a.md` cannot reach the log, the index or the archive.
  checkedRelative(root, real);
  return real;
}

/** Archive path and its existing state. A symlinked archive directory or archive file is rejected. */
async function archiveTarget(root, page) {
  const name = page.slice('wiki/'.length).replace(/\.md$/u, '').replaceAll('/', '--');
  const dir = join(root, ...ARCHIVE_DIRECTORY.split('/'));
  const dirInfo = await lstat(dir).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (dirInfo) {
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw pathEscape();
    const realDir = await realpath(dir).catch(() => null);
    if (!realDir || asPosix(relative(root, realDir)).toLowerCase() !== ARCHIVE_DIRECTORY) throw pathEscape();
  }
  const file = `${name}-history.md`;
  const target = join(dir, file);
  const fileInfo = await lstat(target).catch(error => {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOTDIR') throw pathEscape();
    throw error;
  });
  if (fileInfo && (fileInfo.isSymbolicLink() || !fileInfo.isFile())) throw pathEscape();
  return { name, archiveRel: `${ARCHIVE_DIRECTORY}/${file}`, dir, file: target, exists: Boolean(fileInfo) };
}

/** Days in a month, with the Gregorian leap rule. */
function daysInMonth(year, month) {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month !== 2) return lengths[month - 1] ?? 0;
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
}

/** A valid calendar date `YYYY-MM-DD`, as `{text, time}`, or null. */
function parseCalendarDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  const stamp = new Date(0);
  stamp.setUTCFullYear(year, month - 1, day);
  return { text: `${match[1]}-${match[2]}-${match[3]}`, time: stamp.getTime() };
}

/** The first valid calendar date inside a heading, or null. */
function headingDate(heading) {
  for (const match of heading.matchAll(DATE_PATTERN)) {
    const parsed = parseCalendarDate(`${match[1]}-${match[2]}-${match[3]}`);
    if (parsed) return parsed;
  }
  return null;
}

const isDelimiter = line => line === '---' || line === '---\r';

/** Index of the first body line: just after the closing `---`, or 0 when there is no closed frontmatter block. */
function bodyStart(lines) {
  if (!lines.length || !isDelimiter(lines[0])) return 0;
  for (let index = 1; index < lines.length; index++) if (isDelimiter(lines[index])) return index + 1;
  return 0;
}

const fenceOpener = line => {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  return match ? { char: match[1][0], length: match[1].length } : null;
};
const fenceCloses = (line, fence) => {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
  return Boolean(match) && match[1][0] === fence.char && match[1].length >= fence.length;
};

/** H2 sections of the body, with their heading text, date, current flag and back-link flag. Fences and H1 end them. */
function parseSections(lines, start) {
  const sections = [];
  let fence = null;
  let open = null;
  const close = end => {
    if (!open) return;
    const parsed = headingDate(open.heading);
    sections.push({
      start: open.start,
      end,
      heading: open.heading,
      date: parsed ? parsed.text : null,
      time: parsed ? parsed.time : 0,
      current: /current|güncel durum/u.test(open.heading.toLowerCase()),
      backLink: isBackLinkLine(open.line)
    });
    open = null;
  };
  for (let index = start; index < lines.length; index++) {
    const line = stripCr(lines[index]);
    if (fence) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) { fence = opener; continue; }
    if (H2_START.test(line)) { close(index); open = { start: index, heading: line.slice(3).trim(), line }; continue; }
    if (H1_START.test(line)) close(index);
  }
  close(lines.length);
  return sections;
}

/** True when a back-link line exists outside fences: the same definition `parseSections` uses. */
function hasBackLink(lines) {
  let fence = null;
  for (const raw of lines) {
    const line = stripCr(raw);
    if (fence) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) { fence = opener; continue; }
    if (isBackLinkLine(line)) return true;
  }
  return false;
}

/** Line indexes covered by the moved sections, as one set. */
function movedIndexes(moved) {
  const indexes = new Set();
  for (const section of moved) for (let index = section.start; index < section.end; index++) indexes.add(index);
  return indexes;
}

/**
 * Rule 8 self-check, built from the new page text rather than from the kept line array: the new page text (minus the
 * appended back-link) must have exactly the kept lines, and re-inserting the moved sections at their original indexes
 * must reproduce the original line array exactly. A page whose every line is moved keeps an empty body: the text before
 * the back-link is then "" (or the one newline Rule 7 adds), never a two-item split. Exported so the check itself can be
 * tested.
 */
export function verifyNoLineLoss(lines, moved, pageText, appended, suffix) {
  const backLink = appended ? suffix : null;
  if (backLink !== null && !pageText.endsWith(backLink)) throw selfCheckFailed();
  const body = backLink === null ? pageText : pageText.slice(0, pageText.length - backLink.length);
  const skipped = movedIndexes(moved);
  const keptCount = lines.length - skipped.size;
  let kept;
  if (keptCount === 0) {
    // Nothing is kept: the empty kept text becomes "" or the single "\n" Rule 7 appends before the back-link.
    if (body !== '' && body !== '\n') throw selfCheckFailed();
    kept = [];
  } else {
    kept = body.split('\n');
    // Rule 7 adds one newline when the kept text does not end with one; that shows up as one extra empty trailing line.
    if (backLink !== null && kept.length === keptCount + 1 && kept[kept.length - 1] === '') kept.pop();
    if (kept.length !== keptCount) throw selfCheckFailed();
  }
  const rebuilt = [];
  let cursor = 0;
  for (let index = 0; index < lines.length;) {
    if (!skipped.has(index)) { rebuilt.push(kept[cursor++]); index++; continue; }
    let end = index;
    while (end < lines.length && skipped.has(end)) end++;
    for (let each = index; each < end; each++) rebuilt.push(lines[each]);
    index = end;
  }
  if (cursor !== kept.length || rebuilt.length !== lines.length) throw selfCheckFailed();
  for (let index = 0; index < lines.length; index++) if (rebuilt[index] !== lines[index]) throw selfCheckFailed();
}

/** The archive text must end with exactly the moved block. */
function verifyArchive(archiveText, movedText) {
  if (!archiveText.endsWith(movedText)) throw selfCheckFailed();
}

/** Options are validated before the page path, so bad options always report E_ARGUMENT. */
function normalizeOptions(options = {}) {
  const keep = options.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 0 || keep > MAX_KEEP) throw failure('E_ARGUMENT', 'compact --keep must be an integer from 0 to 1000.');
  const olderThan = options.olderThan ?? null;
  const threshold = olderThan === null ? null : parseCalendarDate(olderThan);
  if (olderThan !== null && threshold === null) throw failure('E_ARGUMENT', 'compact --older-than must be a YYYY-MM-DD date.');
  const page = options.page;
  if (invalidPagePath(page)) throw pathEscape();
  const now = options.now instanceof Date && !Number.isNaN(options.now.valueOf()) ? options.now : new Date();
  return { page, keep, olderThan, threshold, now };
}

/** Read the page, select the sections to move and build the exact writes. Reads only. */
async function evaluate(root, settings) {
  const file = await checkedPageFile(root, settings.page);
  const target = await archiveTarget(root, settings.page);
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  const start = bodyStart(lines);
  const sections = parseSections(lines, start);
  const candidates = sections.filter(section => section.date !== null && !section.current && !section.backLink);
  const ordered = candidates.slice().sort((left, right) => (right.time - left.time) || (right.start - left.start));
  const moved = ordered
    .slice(settings.keep)
    .filter(section => settings.threshold === null || section.time < settings.threshold.time)
    .sort((left, right) => left.start - right.start);

  const wordsBefore = countWords(lines.slice(start).join('\n'));
  const result = {
    action: 'compact',
    mode: 'plan',
    page: settings.page,
    archive: target.archiveRel,
    keep: settings.keep,
    olderThan: settings.olderThan,
    sections: {
      h2: sections.length,
      dated: sections.filter(section => section.date !== null).length,
      current: sections.filter(section => section.current).length,
      kept: candidates.length - moved.length,
      moved: moved.length
    },
    moved: moved.map(section => ({ heading: section.heading, date: section.date, lines: section.end - section.start })),
    linesMoved: moved.reduce((total, section) => total + section.end - section.start, 0),
    lineLoss: 0,
    wordsBefore,
    wordsAfter: wordsBefore,
    written: false
  };
  if (!moved.length) return { result, write: null };

  const existing = target.exists ? await readFile(target.file, 'utf8') : null;
  if (existing !== null && parseFrontmatter(existing).data?.archived_from !== settings.page) throw conflict();

  const parsedTitle = parseFrontmatter(text).data?.title;
  const title = typeof parsedTitle === 'string' && parsedTitle.length ? parsedTitle : target.name;
  const movedParts = moved.map(section => lines.slice(section.start, section.end).join('\n'));
  let movedText = movedParts.join('\n');
  if (!movedText.endsWith('\n')) movedText += '\n';
  const header = `---\ntitle: ${JSON.stringify(`History: ${title}`)}\ntype: archive\nstatus: archived\narchived_from: ${JSON.stringify(settings.page)}\ngenerated: ${JSON.stringify(settings.now.toISOString())}\n---\n# History: ${title}\n\n`;
  // A previous run may have written the archive but not the page: appending the same block again would duplicate it.
  let archiveText;
  if (existing === null) archiveText = `${header}${movedText}`;
  else if (existing.endsWith(movedText)) archiveText = existing;
  else archiveText = `${existing}${existing.endsWith('\n') ? '' : '\n'}${movedText}`;

  const skipped = movedIndexes(moved);
  const keptLines = lines.filter((_, index) => !skipped.has(index));
  const suffix = `\n${BACK_LINK_HEADING}\n\n${BACK_LINK_TEXT} [[archive/${target.name}-history]].\n`;
  const appended = !hasBackLink(keptLines);
  const joined = keptLines.join('\n');
  const ended = joined.endsWith('\n') ? joined : `${joined}\n`;
  const pageText = appended ? `${ended}${suffix}` : joined;

  verifyNoLineLoss(lines, moved, pageText, appended, suffix);
  verifyArchive(archiveText, movedText);

  result.wordsAfter = countWords(pageText.split('\n').slice(start).join('\n'));
  return { result, write: { pageFile: file, dir: target.dir, archiveFile: target.file, archiveText, pageText } };
}

/** Read-only plan: validates paths, reads the page, writes nothing anywhere. */
export async function planCompaction(vault, options = {}) {
  const settings = normalizeOptions(options);
  const root = await vaultRoot(vault);
  const { result } = await evaluate(root, settings);
  return result;
}

/** Apply: the same plan, computed from a fresh read inside the Wiki write lock, then archive, page and one log entry. */
export async function applyCompaction(vault, options = {}) {
  const settings = normalizeOptions(options);
  const root = await vaultRoot(vault);
  await checkedPageFile(root, settings.page);
  const target = await archiveTarget(root, settings.page);
  const { withLock, LOCK_FILE_NAME } = await lockApi();
  return withLock(join(root, 'wiki', LOCK_FILE_NAME), async () => {
    const { result, write } = await evaluate(root, settings);
    if (!write) return { ...result, mode: 'apply' };
    const undo = `To undo: copy the sections listed under "moved" from ${result.archive} back into ${result.page} and delete its "## Archived history" section.`;
    await mkdir(target.dir, { recursive: true });
    await atomicWriteFile(write.archiveFile, write.archiveText);
    await atomicWriteFile(write.pageFile, write.pageText);
    await appendLog(root, { action: 'compact', path: settings.page }, { now: settings.now });
    return { ...result, mode: 'apply', written: true, undo };
  });
}

/** Human summary: one header line, one count line, one line per moved section, then the undo line for an apply. */
export function formatCompaction(result) {
  const lines = [
    `compact ${result.mode}: ${result.page} → ${result.archive}`,
    `moved ${result.moved.length} section(s), ${result.linesMoved} line(s); kept ${result.sections.kept} dated; words ${result.wordsBefore} → ${result.wordsAfter}`
  ];
  for (const section of result.moved) lines.push(`- ${section.date}  ${section.heading}`);
  if (result.undo) lines.push(result.undo);
  return lines.join('\n');
}
