// SPDX-License-Identifier: MIT
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import * as core from '@brainatlas/core';
import { LOCK_FILE_NAME, withLock } from './lock.mjs';
import { pageSlug } from './slug.mjs';

import * as wiki from '@llmwiki/core';
const TOOL_LIMIT = 20_000;
const descriptions = {
  // BA-57: the list carries the synthesized flag; the one-line base description is pinned verbatim by the BA-53 test.
  wiki_query: 'Search verified Wiki evidence and return ranked snippets; compact omits the snippets.',
  wiki_read_page: 'Read a bounded Wiki page, or one of its sections by anchor.',
  wiki_read_index: 'Read the bounded Wiki index.',
  wiki_list_pages: 'List Wiki Markdown page paths.',
  wiki_status: 'Read Wiki counts and health summary.',
  wiki_lint: 'Run the vendored Wiki quality checks.',
  wiki_write_page: 'Create or replace a Wiki page.',
  wiki_update_page: 'Update a Wiki page.',
  wiki_create_entity: 'Create an entity page.',
  wiki_create_concept: 'Create a concept page.',
  wiki_add_crosslinks: 'Add links to existing pages referenced by this page.',
  wiki_update_index:
    'Add missing pages to the Wiki index and remove entries for deleted pages; existing lines are kept.',
};

function mcpError(code, message) {
  const error = /** @type {Error & {code:string}} */ (new Error(message));
  error.code = code;
  return error;
}
/** @returns {{content:Array<{type:'text',text:string}>}} */
function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function asText(error) {
  if (error?.code === 'E_SECRET_DETECTED')
    return 'E_SECRET_DETECTED: write refused because secret-like content was detected.';
  if (error?.code === 'E_PATH_ESCAPE') return 'E_PATH_ESCAPE: path is outside the Wiki.';
  // Messages on E_INVALID_INPUT are fixed strings in this file and never contain caller content.
  if (error?.code === 'E_INVALID_INPUT') return `E_INVALID_INPUT: ${error.message}`;
  if (typeof error?.code === 'string' && /^E_[A-Z_]+$/.test(error.code)) return `${error.code}: operation refused.`;
  return 'E_MCP_OPERATION: operation failed.';
}
function serializePage(page) {
  const fm = Object.entries(page.frontmatter ?? {})
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`)
    .join('\n');
  return `---\n${fm}\n---\n${page.body ?? ''}\n`;
}
// BA-32: the frontmatter rule of the retrieval index (same pattern), so a section read splits the body exactly as the
// search index does. An opening `---` without a closing line leaves the whole text as body.
const FRONTMATTER = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
function pageBody(text) {
  const match = text.match(FRONTMATTER);
  return match ? text.slice(match[0].length) : text;
}
const INDEX_CATEGORY_LINE = /^##\s+(.+)$/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const PATCH_KEYS = new Set(['frontmatter', 'body', 'append']);
/** Undo CommonMark backslash escapes of ASCII punctuation in a link destination. */
function unescapeDestination(raw) {
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
/**
 * Destination of a `- [Title](destination)` line, read the way CommonMark reads a link: escaped parentheses and
 * balanced unescaped parentheses belong to the destination; the first unbalanced `)` ends it.
 * @returns {string|undefined} unescaped destination, or undefined when the line is not a link entry
 */
function entryDestination(trimmed) {
  const head = /^-\s+\[/.exec(trimmed);
  if (!head) return undefined;
  let i = head[0].length;
  while (i < trimmed.length && trimmed[i] !== ']') i += trimmed[i] === '\\' ? 2 : 1;
  if (trimmed[i] !== ']' || trimmed[i + 1] !== '(') return undefined;
  const start = i + 2;
  if (trimmed[start] === '<') {
    // Angle-bracket destination (may contain spaces): ends at the first unescaped '>' that is followed by ')'.
    let j = start + 1;
    while (j < trimmed.length && trimmed[j] !== '>') j += trimmed[j] === '\\' ? 2 : 1;
    if (trimmed[j] !== '>' || trimmed[j + 1] !== ')') return undefined;
    return unescapeDestination(trimmed.slice(start + 1, j));
  }
  let depth = 0;
  for (i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i >= trimmed.length || i === start) return undefined;
  return unescapeDestination(trimmed.slice(start, i));
}
/** Classify one index line: `## Category` heading or `- [Title](path)` entry (trimmed, as the vendored readIndex does). */
function indexLineInfo(line) {
  const trimmed = line.trim();
  const heading = trimmed.match(INDEX_CATEGORY_LINE);
  if (heading) return { heading: heading[1].trim() };
  const destination = entryDestination(trimmed);
  if (destination === undefined) return {};
  // `page.md#anchor` and `page.md?query` name the page `page.md`; a fragment-only target names no page.
  const path = destination.replace(/[#?].*$/s, '');
  return path ? { entryPath: posix.normalize(path) } : {};
}
/** Local page paths named by the entry lines of an index text (null: no index). */
function indexedPaths(content) {
  const paths = new Set();
  if (content === null) return paths;
  for (const info of classifyLines(content.split('\n')).infos)
    if (info.entryPath !== undefined) paths.add(info.entryPath);
  return paths;
}
/**
 * Classify every line. Lines inside a fenced code block (``` or ~~~) are opaque: no heading and no entry.
 * @returns {{infos:object[], openFence:{char:string,length:number}|null}}
 */
function classifyLines(lines) {
  let fence = null;
  const infos = lines.map((line) => {
    const trimmed = line.trim();
    const marker = trimmed.match(FENCE_OPEN);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && trimmed === marker[1])
        fence = null;
      return { fenced: true };
    }
    if (marker && !(marker[1][0] === '`' && trimmed.slice(marker[1].length).includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      return { fenced: true };
    }
    return { fenced: false, ...indexLineInfo(line) };
  });
  return { infos, openFence: fence };
}
/** Category of a page: its first folder, or `Pages` for a page at the Wiki root. */
function categoryOf(path) {
  return path.includes('/') ? path.split('/')[0] : 'Pages';
}
/**
 * A page whose path holds a carriage return, line feed, U+0085, U+2028 or U+2029 is never written to the index (a line
 * break would split the entry line) and is not counted in wiki_status coverage. Other control characters and tabs are
 * written inside angle brackets and read back exactly.
 */
const UNSAFE_PATH = /[\r\n\u0085\u2028\u2029]/;
function indexablePath(path) {
  return !UNSAFE_PATH.test(path);
}
/** A link target that names a local Markdown file. External URLs and anchors are never treated as stale pages. */
function isLocalMarkdownTarget(path) {
  return path.endsWith('.md') && !path.startsWith('/') && !path.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(path);
}
/**
 * Line-safe label text: every run of whitespace, C0/C1 control character or DEL (this includes CR, LF, U+0085, U+2028
 * and U+2029) becomes one space, and the result is trimmed. An index entry must stay on one line.
 */
function cleanLabel(text) {
  // eslint-disable-next-line no-control-regex -- index labels match C0/C1 control characters on purpose so an entry stays on one line
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
}
/** Link text of an entry: the cleaned title, else the cleaned file name without `.md`, else the cleaned path. */
function entryTitle(entry) {
  return cleanLabel(String(entry.title)) || cleanLabel(posix.basename(entry.path, '.md')) || cleanLabel(entry.path);
}
/** Index line for one page; the same shape as the vendored writer, with the frontmatter summary and valid tags. */
function indexEntryLine(entry) {
  const fm = entry.frontmatter ?? {};
  const summarySource = [fm.summary, fm.description].find((value) => typeof value === 'string' && cleanLabel(value));
  const summary = summarySource ? cleanLabel(summarySource) : '';
  const tags = entry.tags.filter((tag) => typeof tag === 'string' && /^[\w-]+$/.test(tag));
  const title = wiki.escapeMarkdownLinkText(entryTitle(entry));
  const parts = [summary, ...(tags.length ? [tags.map((tag) => `#${tag}`).join(' ')] : [])].filter(Boolean);
  return `- [${title}](${indexDestination(entry.path)})${parts.length ? ` — ${parts.join(' ')}` : ''}`;
}
/**
 * Link destination for a page path. Parentheses and backslashes are escaped so the destination ends where the path ends;
 * a space or control character (or a leading `<`) would end a plain destination, so such paths use `<...>`.
 */
function indexDestination(path) {
  const escaped = path.replace(/([\\()])/g, '\\$1');
  // eslint-disable-next-line no-control-regex -- index labels match C0/C1 control characters on purpose so an entry stays on one line
  if (!/[\s\x00-\x1f\x7f-\x9f]/.test(path) && !path.startsWith('<')) return escaped;
  return `<${escaped.replace(/[<>]/g, '\\$&')}>`;
}
/**
 * Index text for a Wiki without an index (or with an empty one): one `## <first folder>` category per folder, `## Pages`
 * for root pages, entries sorted by path. Lines use the same format as mergeIndex.
 */
function freshIndex(entries) {
  const categories = new Map();
  const sorted = entries
    .filter((entry) => indexablePath(entry.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    const category = categoryOf(entry.path);
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(entry);
  }
  let output = '# Wiki Index\n';
  for (const [category, rows] of categories) {
    output += `\n## ${category}\n\n`;
    for (const row of rows) output += `${indexEntryLine(row)}\n`;
  }
  return output;
}
/**
 * Minimal edit of an existing index. Lines are kept as they are (bytes, EOL, order); only entry lines whose local
 * target no longer exists are removed, and pages without any entry get one line in their folder's category.
 * With `prune: false` no line is removed (the create tools add only their own page).
 * @returns {{output:string, added:number, removed:number}}
 */
function mergeIndex(content, entries, { prune = true } = {}) {
  // Existing lines keep their own trailing '\r' (split on '\n' only); inserted lines get the file's style.
  const cr = content.includes('\r\n') ? '\r' : '';
  const fresh = (text) => `${text}${cr}`;
  const isBlank = (text) => text.trim() === '';
  const pagePaths = new Set(entries.map((entry) => entry.path));
  // Links are collected from the whole file, so an entry above the first heading also counts as linked.
  const linked = new Set();
  const source = content.split('\n');
  const sourceInfos = classifyLines(source).infos;
  const lines = [];
  let removed = 0;
  for (let i = 0; i < source.length; i++) {
    const info = sourceInfos[i];
    if (info.entryPath !== undefined) {
      if (prune && !pagePaths.has(info.entryPath) && isLocalMarkdownTarget(info.entryPath)) {
        removed++;
        continue;
      }
      linked.add(info.entryPath);
    }
    lines.push(source[i]);
  }
  const missing = entries
    .filter((entry) => indexablePath(entry.path) && !linked.has(entry.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of missing) {
    const line = fresh(indexEntryLine(entry));
    const category = categoryOf(entry.path);
    const { infos, openFence } = classifyLines(lines);
    const headingAt = infos.findIndex(
      (info) => info.heading !== undefined && info.heading.toLowerCase() === category.toLowerCase()
    );
    if (headingAt === -1) {
      // A file that ends inside an open fence would swallow the new block; close the fence first.
      const block = [
        ...(openFence ? [fresh(openFence.char.repeat(openFence.length))] : []),
        fresh(''),
        fresh(`## ${category}`),
        fresh(''),
        line,
      ];
      // A trailing empty element means the file ends with a newline; keep that newline last.
      if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, ...block);
      else lines.push(...block);
      continue;
    }
    // Insert after the category's last entry line, or right under its heading when it has none.
    let insertAt = headingAt + 1;
    let hasEntries = false;
    for (let i = headingAt + 1; i < lines.length && infos[i].heading === undefined; i++) {
      if (infos[i].entryPath !== undefined) {
        insertAt = i + 1;
        hasEntries = true;
      }
    }
    if (!hasEntries && insertAt < lines.length && isBlank(lines[insertAt])) insertAt++;
    lines.splice(insertAt, 0, line);
  }
  let output = lines.join('\n');
  // Removing a CRLF file's last line can leave a bare '\r' at the end; close it with the missing '\n'.
  if (cr && output.endsWith('\r')) output += '\n';
  return { output, added: missing.length, removed };
}
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
/** A plain object whose own keys are the only keys: a JSON `__proto__` key sets the prototype instead, so it is detected here. */
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
    throw mcpError('E_INVALID_INPUT', 'patch must be an object.');
  if (!isPlainObject(patch) || Object.getOwnPropertyNames(patch).some((key) => !PATCH_KEYS.has(key)))
    throw mcpError('E_INVALID_INPUT', 'Unknown patch field.');
  if (
    hasOwn(patch, 'frontmatter') &&
    (patch.frontmatter === null ||
      typeof patch.frontmatter !== 'object' ||
      Array.isArray(patch.frontmatter) ||
      !isPlainObject(patch.frontmatter) ||
      hasOwn(patch.frontmatter, '__proto__'))
  )
    throw mcpError('E_INVALID_INPUT', 'patch.frontmatter must be an object.');
  if ('body' in patch && typeof patch.body !== 'string')
    throw mcpError('E_INVALID_INPUT', 'patch.body must be a string.');
  if ('append' in patch && typeof patch.append !== 'string')
    throw mcpError('E_INVALID_INPUT', 'patch.append must be a string.');
}
async function readOptionalIndex(target) {
  try {
    const text = await readFile(target, 'utf8');
    return text.length ? text : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** @param {{config:object,paths:object,env:object}} options @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} */
/** @param {{config:any,paths:any,env:any,fetchImpl?:Function}} options */
export function createServer(options) {
  if (!options || !options.config || !options.paths || !options.env)
    throw mcpError('E_MCP_OPTIONS', 'config, paths and env are required.');
  const { config, paths, env } = options;
  const home = typeof env.HOME === 'string' ? env.HOME : undefined;
  const requestedVault = paths.vaultDir ?? env.BRAINATLAS_VAULT ?? config.vault?.path;
  if (typeof requestedVault !== 'string' || !requestedVault)
    throw mcpError('E_VAULT_PATH', 'A Wiki vault path is required.');
  const vaultDir = resolve(
    isAbsolute(requestedVault) ? requestedVault : resolve(home ?? process.cwd(), requestedVault)
  );
  const wikiDir = join(vaultDir, 'wiki');
  let stateDir = paths.stateDir;
  if (typeof stateDir !== 'string' || !stateDir) {
    if (home) {
      const platform = env.BRAINATLAS_PLATFORM || process.platform;
      stateDir = core.resolvePaths({ env, platform }).stateDir;
    } else {
      const vaultKey = createHash('sha256').update(vaultDir).digest('hex').slice(0, 16);
      stateDir = join(tmpdir(), 'brainatlas-state', vaultKey);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      chmodSync(stateDir, 0o700);
    }
  }
  // BA-29: the MCP search root stays wiki/ (as before: a vault without wiki/ is E_VAULT_MISSING). Only the exclusion list is new:
  // root-level navigation and policy pages are not returned, unless retrieval.exclude says otherwise.
  const excludeRules = config.retrieval?.exclude ?? core.DEFAULT_EXCLUDE_WIKI;
  const isExcluded = (rel) => core.isExcludedPath(rel, excludeRules);
  let searcher = core.createSearcher({ vaultDir: wikiDir, stateDir, exclude: excludeRules });
  const semanticEnabled =
    config.semantic?.enabled === true &&
    config.profile !== 'lite' &&
    (config.modules?.includes('*') || config.modules?.includes('semantic'));
  let semanticModulePromise;
  let background = null;
  let backgroundDirty = false;
  let backgroundFailed = false;
  const backgroundController = new AbortController();
  const settings = { ...core.SEMANTIC_DEFAULTS, ...config.semantic };
  const loadSemantic = () =>
    (semanticModulePromise ??= (async () => {
      let release, releases;
      try {
        release = await realpath(paths.currentDir);
        releases = await realpath(paths.releasesDir);
        await stat(join(release, 'modules', 'semantic', 'module.json'));
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
          throw Object.assign(new Error(), { fallbackReason: 'module-missing' });
        throw error;
      }
      const releaseRel = relative(releases, release);
      if (!releaseRel || releaseRel.startsWith(`..${sep}`) || isAbsolute(releaseRel) || releaseRel.includes(sep))
        throw new Error();
      const manifest = (await core.discoverModules(release)).find((item) => item.name === 'semantic');
      if (!manifest) throw Object.assign(new Error(), { fallbackReason: 'module-missing' });
      const dir = await realpath(join(release, 'modules', 'semantic'));
      if (relative(release, dir) !== join('modules', 'semantic')) throw new Error();
      const entry = await realpath(resolve(dir, manifest.entry));
      const rel = relative(dir, entry);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error();
      return import(pathToFileURL(entry).href);
    })());
  const providerFor = (module, indexing = false) => {
    module.validateConfiguredProvider(settings);
    return module.createOllamaProvider({
      ...settings,
      ...(indexing ? { timeoutMs: settings.indexTimeoutMs, batchSize: settings.indexBatchSize } : {}),
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
    });
  };
  const scheduleUpdate = (markDirty = true) => {
    if (!semanticEnabled || backgroundController.signal.aborted) return;
    if (background) {
      if (markDirty) backgroundDirty = true;
      return;
    }
    background = (async () => {
      do {
        backgroundDirty = false;
        try {
          const module = await loadSemantic();
          await module.updateSemanticIndex({
            corpusDir: wikiDir,
            stateDir,
            provider: providerFor(module, true),
            indexBatchSize: settings.indexBatchSize,
            signal: backgroundController.signal,
            chunkMarkdown: module.markdownChunks,
          });
          backgroundFailed = false;
        } catch {
          backgroundFailed = true;
        }
      } while (backgroundDirty && !backgroundController.signal.aborted);
    })().finally(() => {
      background = null;
    });
  };
  const server = new McpServer({ name: 'brainatlas-mcp', version: '0.1.0' });
  server.server.onclose = () => backgroundController.abort();
  const close = server.close.bind(server);
  server.close = async () => {
    backgroundController.abort();
    await close();
    if (background) {
      let timer;
      try {
        await Promise.race([
          background,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  };

  const safeFile = async (rel, { allowIndex = true } = {}) => {
    if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes('\0'))
      throw mcpError('E_PATH_ESCAPE', 'Path is invalid.');
    let normalized = rel.replace(/^wiki\//, '');
    if (!allowIndex && ['index.md', 'log.md'].includes(normalized))
      throw mcpError('E_PATH_ESCAPE', 'Managed Wiki files cannot be edited directly.');
    if (isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..'))
      throw mcpError('E_PATH_ESCAPE', 'Path is invalid.');
    // The write lock file is not a page: it cannot be read, written or replaced through the Wiki tools.
    if (normalized.split('/').at(-1) === LOCK_FILE_NAME) throw mcpError('E_PATH_ESCAPE', 'Path is invalid.');
    if (core.scanPath(`wiki/${normalized}`, { extraDenyGlobs: config.safety?.extraDenyGlobs ?? [] }).length)
      throw mcpError('E_SECRET_DETECTED', 'write refused: denied path');
    const canonicalVault = await realpath(vaultDir);
    const canonicalWiki = join(canonicalVault, 'wiki');
    const target = core.safeJoin(canonicalWiki, normalized);
    const checked = await core.resolveSafePath(vaultDir, `wiki/${normalized}`);
    if (resolve(checked) !== target) {
      const from = relative(canonicalWiki, checked);
      if (!from || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from))
        throw mcpError('E_PATH_ESCAPE', 'Path is outside the Wiki.');
    }
    return { normalized, target: checked };
  };
  const checkWrite = (rel, content) => {
    if (
      core.scanPath(rel, { extraDenyGlobs: config.safety?.extraDenyGlobs ?? [] }).length ||
      core.scanText(content).length
    )
      throw mcpError('E_SECRET_DETECTED', 'write refused: secret-like content detected');
  };
  // BA-25: every Wiki write (pages, index, log, crosslinks) runs inside one vault-wide lock file in wiki/ (see lock.mjs).
  // The check of an expected hash and the write happen in that same critical section.
  const writeLocked = async (work) => {
    // lstat, not stat: a dangling wiki/ symlink must not be replaced by a directory (mkdir would create its target).
    try {
      await lstat(wikiDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(wikiDir, { recursive: true });
    }
    const canonicalWiki = await assertWikiInsideVault();
    return withLock(join(canonicalWiki, LOCK_FILE_NAME), work);
  };
  const fileSha = async (file) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  // Writes a temporary file in the target's folder, then renames it over the target: readers see the old or the new bytes.
  // The temporary name ends in `.tmp`, so no page listing or search counts it. An existing file keeps its permission bits.
  const replaceFile = async (target, writeTemp) => {
    const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeTemp(temp);
      const mode = await stat(target).then(
        (st) => st.mode & 0o7777,
        () => null
      );
      if (mode !== null) await chmod(temp, mode);
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  };
  const writePageAtomic = (target, page) => replaceFile(target, (temp) => wiki.writePage(temp, page));
  const writeIndexAtomic = (target, text) => replaceFile(target, (temp) => writeFile(temp, text, 'utf8'));
  /** E_CONFLICT when the expectation is set and the file is missing or its bytes hash to another value. Never echoes either. */
  const checkExpectedSha = async (target, expected) => {
    if (expected === undefined) return;
    let current;
    try {
      current = await readFile(target);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (current === undefined || createHash('sha256').update(current).digest('hex') !== expected.toLowerCase()) {
      throw mcpError('E_CONFLICT', 'The page changed since it was read.');
    }
  };
  // Called inside the lock: the log append is part of the same critical section as the write it records.
  const logEntry = async (action, rel) => {
    const record = JSON.stringify({ action, path: rel });
    checkWrite('wiki/log.md', record);
    await core.appendLog(vaultDir, { action, path: rel });
  };
  // Called after the lock is released. A failed refresh must not turn a completed write into an error; the next wiki_query retries.
  const afterWrite = async () => {
    try {
      await searcher.refresh();
    } catch {
      /* Keep the last good index. */
    }
    scheduleUpdate();
  };
  // BA-53: the low-confidence sentence is advertised unless retrieval.pullLowConfidence is explicitly false; with the key
  // absent (the default) or true the tool list carries the sentence, and only an explicit false restores the old one.
  const descriptionFor = (name) =>
    name === 'wiki_query' && config.retrieval?.pullLowConfidence !== false
      ? `${descriptions.wiki_query} Results marked lowConfidence scored below the abstain threshold; treat them as weak evidence and verify before relying on them.`
      : descriptions[name];
  const tool = (name, schema, handler) =>
    server.registerTool(name, { description: descriptionFor(name), inputSchema: schema.shape }, async (args) => {
      try {
        return textResult(await handler(args));
      } catch (error) {
        return /** @type {{content:Array<{type:'text',text:string}>,isError:boolean}} */ ({
          content: [{ type: 'text', text: asText(error) }],
          isError: true,
        });
      }
    });
  // Page list for index maintenance. core.listPages skips symlinked files and directories (Dirent.isSymbolicLink), so
  // nothing outside the Wiki is read. The Wiki directory itself must resolve inside the vault.
  const listManagedPages = async () => {
    const canonicalWiki = await assertWikiInsideVault();
    return (await core.listPages(vaultDir))
      .map((rel) => ({ path: rel.slice('wiki/'.length), file: join(canonicalWiki, rel.slice('wiki/'.length)) }))
      .filter(({ path }) => !['index.md', 'log.md'].includes(path.split('/').at(-1)));
  };
  // The Wiki directory must resolve inside the vault's real path. The vault root itself may be a symlink (its real
  // path is the reference), but a wiki/ symlink that leaves the vault is refused for every Wiki tool.
  const assertWikiInsideVault = async () => {
    const canonicalVault = await realpath(vaultDir);
    const canonicalWiki = await realpath(wikiDir);
    if (relative(canonicalVault, canonicalWiki) !== 'wiki')
      throw mcpError('E_PATH_ESCAPE', 'Wiki directory is outside the vault.');
    return canonicalWiki;
  };
  const ensureWikiDirectory = async () => {
    let isDirectory = false;
    try {
      isDirectory = (await stat(wikiDir)).isDirectory();
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (!isDirectory) throw mcpError('E_VAULT_MISSING', 'The Wiki directory is missing.');
    await assertWikiInsideVault();
  };
  // When wiki/ resolves outside the vault, these listings answer as an empty Wiki: no outside content, no error.
  // Every other read tool, and wiki_update_index, refuses with E_PATH_ESCAPE.
  const escapedWikiViews = {
    wiki_list_pages: () => ({ pages: [] }),
    wiki_status: () => ({
      pageCount: 0,
      okfWarningCount: 0,
      okfErrorCount: 0,
      indexAgeMs: null,
      readOnly: config.readOnly === true,
      indexCoveragePct: 100,
    }),
    wiki_query: () => ({ results: [], abstained: true }),
  };
  const readTool = (name, schema, handler) =>
    tool(name, schema, async (args) => {
      try {
        await ensureWikiDirectory();
      } catch (error) {
        if (error?.code === 'E_PATH_ESCAPE' && escapedWikiViews[name]) return escapedWikiViews[name]();
        throw error;
      }
      return handler(args);
    });

  readTool(
    'wiki_query',
    z.object({ query: z.string(), limit: z.number().int().min(0).max(20).optional(), compact: z.boolean().optional() }),
    async ({ query, limit, compact }) => {
      const count = limit ?? 5;
      // Edits made outside this server (Obsidian, sync, another agent's MCP process) are picked up here.
      // A failed freshness check (e.g. a file removed between the scan and the read) keeps the current index; the next query retries.
      try {
        if (searcher.refreshIfChanged() && semanticEnabled) scheduleUpdate();
      } catch {
        /* Keep serving the last good index. */
      }
      const answer = searcher.search(query, {
        limit: count,
        budgetChars: Math.min(config.retrieval?.budgetChars ?? 4000, TOOL_LIMIT),
        abstainThreshold: config.retrieval?.abstainThreshold ?? 0.35,
      });
      // BA-32: compact drops only the `snippet` key from every result; all other keys, values and their order are unchanged.
      const stripSnippets = (rows) => (compact === true ? rows.map(({ snippet, ...rest }) => rest) : rows);
      // BA-53: pull-side low confidence, on unless retrieval.pullLowConfidence is explicitly false. Only a below-threshold
      // abstention is re-run with no threshold, on the same searcher snapshot (no refresh), so limit, budget and excluded
      // paths stay identical. Other abstain reasons and non-abstained answers never produce low-confidence rows.
      const lowConfidenceAnswer = () => {
        if (
          config.retrieval?.pullLowConfidence === false ||
          answer.abstained !== true ||
          answer.reason !== 'below_threshold'
        )
          return null;
        const weak = searcher.search(query, {
          limit: count,
          budgetChars: Math.min(config.retrieval?.budgetChars ?? 4000, TOOL_LIMIT),
          abstainThreshold: 0,
        });
        if (!weak.results.length) return null;
        return {
          results: stripSnippets(weak.results.map((row) => ({ ...row, lowConfidence: true }))),
          abstained: true,
          lowConfidence: true,
        };
      };
      const lexical = lowConfidenceAnswer() ?? { results: stripSnippets(answer.results), abstained: answer.abstained };
      if (!semanticEnabled) return lexical;
      const fallback = (reason) => ({ ...lexical, semantic: { used: false, fallbackReason: reason }, mode: 'lexical' });
      try {
        let module;
        try {
          module = await loadSemantic();
        } catch (error) {
          return fallback(error?.fallbackReason === 'module-missing' ? 'module-missing' : 'module-load-error');
        }
        const provider = providerFor(module);
        const index = await module.readSemanticIndex(stateDir);
        const emptyIndexWithPages =
          index &&
          index.entries.length === 0 &&
          Object.keys(index.fileHashes).length === 0 &&
          (await core.listPages(vaultDir)).some((path) => !['wiki/index.md', 'wiki/log.md'].includes(path));
        if (!index || emptyIndexWithPages) {
          scheduleUpdate(false);
          return fallback(emptyIndexWithPages || !backgroundFailed ? 'index-missing' : 'provider-error');
        }
        if (index.providerFingerprint !== provider.fingerprint || index.dims !== provider.dims) {
          scheduleUpdate(false);
          return fallback('fingerprint-mismatch');
        }
        const snapshot = searcher.snapshot();
        // BA-29: excluded pages are removed from the semantic candidates and, as a guard, from the hybrid results.
        const results = await module.searchHybrid({
          query,
          pages: snapshot.pages,
          lexicalIndex: snapshot.index,
          entries: index.entries.filter((entry) => !isExcluded(entry.path)),
          provider,
          limit: count,
          indexMeta: index,
          mode: settings.mode,
          minSemanticScore: settings.minScore,
          abstainThreshold: config.retrieval?.abstainThreshold ?? 0.35,
        });
        if (results.fallbackReason) return fallback(results.fallbackReason);
        if (results.abstained) return { ...lexical, semantic: { used: true }, mode: settings.mode };
        const visible = results.filter((item) => !isExcluded(item.path));
        // BA-24: section fields use the core's anchor rule (diacritics, `-N` collisions, astral headings). Order: (1) the
        // lexical section of this query, when the page is in the lexical answer; (2) the core's section for the query on
        // the page's own body (bestSection with the query terms, the same choice the core makes for that page); (3) the
        // section of the chunk's own text, used only when its headingPath equals the chunk's. Otherwise the heading is the
        // chunk's and the anchor stays null.
        const sections = new Map(answer.results.map((row) => [row.path, row]));
        const pagesByPath = new Map(snapshot.pages.map((page) => [page.path, page]));
        const asOf = new Date(snapshot.index.now);
        const queryTerms = [...new Set(core.tokens(query, true))];
        const pageSection = (item, terms) => {
          const page = pagesByPath.get(item.path);
          if (!page || typeof page.body !== 'string' || !terms.length) return null;
          return core.bestSection(page.body, terms, snapshot.index, asOf);
        };
        const chunkSection = (item) => {
          const found = pageSection(item, [...new Set(core.tokens(String(item.snippet ?? ''), true))]);
          return found && found.headingPath === (item.headingPath ?? '') ? found : null;
        };
        let budget = Math.min(config.retrieval?.budgetChars ?? 4000, TOOL_LIMIT);
        // Order is the module's order (RRF in rrf mode, cosine then lexical rank in semantic-primary); `score` is the
        // value of that ordering: rrfScore, or semanticScore in semantic-primary (0 for lexical-only hits, which the module places last).
        const semanticPrimary = settings.mode === 'semantic-primary';
        const normalized = visible.map((item) => {
          const original = answer.results.find((row) => row.path === item.path);
          const section = sections.get(item.path) ?? pageSection(item, queryTerms) ?? chunkSection(item);
          const chunkHeading = item.headingPath?.split(' > ').at(-1) || null;
          // BA-57: the flag comes from the section object; a chunk-only heading has no section, so it is never flagged.
          const synthesized = section?.synthesized === true;
          const sectionFields = section
            ? {
                heading: section.heading,
                anchor: section.anchor,
                headingPath: section.headingPath,
                ...(synthesized ? { synthesized: true } : {}),
              }
            : chunkHeading
              ? { heading: chunkHeading, anchor: null, headingPath: item.headingPath }
              : {};
          // Code-point safe: a cut never leaves a lone surrogate (core prefixKeepingPairs, as BA-17 in the core).
          const snippet = core.prefixKeepingPairs(String(item.snippet ?? ''), Math.max(0, budget));
          budget -= snippet.length;
          const row = {
            ...original,
            path: item.path,
            title: item.title,
            score: semanticPrimary ? (item.semanticScore ?? 0) : item.rrfScore,
            ...(item.semanticScore !== undefined ? { semanticScore: item.semanticScore } : {}),
            rrfScore: item.rrfScore,
            snippet,
            stale: item.stale,
            status: item.status,
            ...sectionFields,
          };
          // A synthesized section is presented neutrally: a verified page's trust is dropped from that row.
          if (synthesized && row.trust === 'verified') delete row.trust;
          return row;
        });
        return { results: stripSnippets(normalized), abstained: false, semantic: { used: true }, mode: settings.mode };
      } catch (error) {
        return fallback(error?.fallbackReason === 'remote-not-allowed' ? 'remote-not-allowed' : 'provider-error');
      }
    }
  );
  readTool(
    'wiki_read_page',
    z.object({ path: z.string(), anchor: z.unknown().optional(), maxChars: z.unknown().optional() }),
    async ({ path, anchor, maxChars }) => {
      // A `#fragment` on the path is the anchor; an explicit `anchor` may carry one leading `#`. Path checks run first, as before.
      const hashAt = path.indexOf('#');
      const pathPart = hashAt < 0 ? path : path.slice(0, hashAt);
      const fragment = hashAt < 0 ? undefined : path.slice(hashAt + 1);
      const { normalized, target } = await safeFile(pathPart);
      if (anchor !== undefined && typeof anchor !== 'string')
        throw mcpError('E_INVALID_INPUT', 'anchor must be a string.');
      if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > TOOL_LIMIT))
        throw mcpError('E_INVALID_INPUT', 'maxChars must be an integer between 1 and 20000.');
      const wanted = anchor === undefined ? fragment : anchor.startsWith('#') ? anchor.slice(1) : anchor;
      if (anchor !== undefined && fragment !== undefined && wanted !== fragment)
        throw mcpError('E_INVALID_INPUT', 'The path fragment and the anchor differ.');
      if (wanted !== undefined && wanted === '') throw mcpError('E_INVALID_INPUT', 'The anchor is empty.');
      // The hash covers all bytes on disk, also when the content is truncated; a write replaces the file by rename, so a read sees one whole version.
      const bytes = await readFile(target);
      const raw = bytes.toString('utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const shownPath = `wiki/${normalized}`;
      if (wanted !== undefined) {
        // BA-32: the section is chosen from the body split of the index loader (pageSections), by its anchor only.
        const section = core.pageSections(pageBody(raw)).find((item) => item.anchor === wanted);
        if (!section) throw mcpError('E_INVALID_INPUT', 'Unknown anchor.');
        const content = maxChars === undefined ? section.text : core.prefixKeepingPairs(section.text, maxChars);
        return {
          path: shownPath,
          anchor: section.anchor,
          heading: section.heading,
          headingPath: section.headingPath,
          content,
          truncated: content.length < section.text.length,
          sha256,
        };
      }
      // Without maxChars the response is byte-identical to before (plain slice and the same truncation flag).
      if (maxChars === undefined)
        return { path: shownPath, content: raw.slice(0, TOOL_LIMIT), truncated: raw.length > TOOL_LIMIT, sha256 };
      const content = core.prefixKeepingPairs(raw, Math.min(maxChars, TOOL_LIMIT));
      return { path: shownPath, content, truncated: content.length < raw.length, sha256 };
    }
  );
  readTool('wiki_read_index', z.object({}), async () => {
    const { target } = await safeFile('index.md');
    const raw = await readFile(target, 'utf8');
    return { content: raw.slice(0, TOOL_LIMIT), truncated: raw.length > TOOL_LIMIT };
  });
  readTool('wiki_list_pages', z.object({ type: z.string().optional() }), async ({ type }) => {
    let pages = await core.listPages(vaultDir);
    pages = pages.filter((item) => item !== 'wiki/index.md' && item !== 'wiki/log.md');
    if (type) pages = pages.filter((item) => item.startsWith(`wiki/${type}/`));
    return { pages };
  });
  readTool('wiki_status', z.object({}), async () => {
    const pages = (await core.listPages(vaultDir)).filter((item) => !['wiki/index.md', 'wiki/log.md'].includes(item));
    const findings = await core.checkVault(vaultDir);
    let indexAgeMs = null;
    try {
      indexAgeMs = Math.max(0, Date.now() - (await stat(join(wikiDir, 'index.md'))).mtimeMs);
    } catch {
      /* index not initialized */
    }
    // Coverage uses the same index reader as wiki_update_index (escaped, angle-bracket and anchored destinations). The
    // vendored getWikiStatus reads the index with its own parser, which misreads escaped parentheses.
    const linked = indexedPaths(await readOptionalIndex(join(wikiDir, 'index.md')));
    const countable = pages.filter((item) => indexablePath(item.slice('wiki/'.length)));
    const covered = countable.filter((item) => linked.has(item.slice('wiki/'.length))).length;
    const indexCoveragePct = countable.length ? Math.round((covered / countable.length) * 100) : 100;
    return {
      pageCount: pages.length,
      okfWarningCount: findings.filter((item) => item.severity === 'warn').length,
      okfErrorCount: findings.filter((item) => item.severity === 'error').length,
      indexAgeMs,
      readOnly: config.readOnly === true,
      indexCoveragePct,
    };
  });
  readTool('wiki_lint', z.object({}), () => wiki.lintWiki(wikiDir));

  if (config.readOnly !== true) {
    // Optional hash of the bytes the caller read (wiki_read_page `sha256`): the write is refused with E_CONFLICT when they differ.
    const expectedSha256 = z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional();
    tool(
      'wiki_write_page',
      z.object({ path: z.string(), content: z.string(), expectedSha256 }),
      async ({ path, content, expectedSha256 }) => {
        const { normalized, target } = await safeFile(path, { allowIndex: false });
        checkWrite(`wiki/${normalized}`, content);
        const parsed = core.parseFrontmatter(content);
        if (parsed.errors.length) throw mcpError('E_INVALID_INPUT', 'Page frontmatter is invalid.');
        const sha256 = await writeLocked(async () => {
          await checkExpectedSha(target, expectedSha256);
          await writePageAtomic(target, { frontmatter: parsed.data, body: parsed.body });
          await logEntry('write-page', `wiki/${normalized}`);
          return expectedSha256 === undefined ? undefined : fileSha(target);
        });
        await afterWrite();
        return { path: `wiki/${normalized}`, written: true, ...(sha256 === undefined ? {} : { sha256 }) };
      }
    );
    // patch is z.unknown() on purpose: a record schema silently drops a JSON "__proto__" key before the handler runs,
    // so validatePatch checks the object itself (own keys, plain prototype).
    tool(
      'wiki_update_page',
      z.object({ path: z.string(), content: z.string().optional(), patch: z.unknown().optional(), expectedSha256 }),
      async ({ path, content, patch, expectedSha256 }) => {
        const { normalized, target } = await safeFile(path, { allowIndex: false });
        const sha256 = await writeLocked(async () => {
          await checkExpectedSha(target, expectedSha256);
          const old = await wiki.readPage(target);
          let next;
          if (patch !== undefined) validatePatch(patch);
          if (content !== undefined) {
            const parsed = core.parseFrontmatter(content);
            if (parsed.errors.length) throw mcpError('E_INVALID_INPUT', 'Page frontmatter is invalid.');
            next = { frontmatter: parsed.data, body: parsed.body };
          } else if (patch) {
            // body replaces the body first; append is then added to the end of the resulting body, so both are applied.
            const base = typeof patch.body === 'string' ? patch.body : old.body;
            next = {
              frontmatter: {
                ...old.frontmatter,
                ...(patch.frontmatter && typeof patch.frontmatter === 'object' ? patch.frontmatter : {}),
              },
              body: base + (typeof patch.append === 'string' ? patch.append : ''),
            };
          } else throw mcpError('E_INVALID_INPUT', 'content or patch is required.');
          const output = serializePage(next);
          checkWrite(`wiki/${normalized}`, output);
          await writePageAtomic(target, next);
          await logEntry('update-page', `wiki/${normalized}`);
          return expectedSha256 === undefined ? undefined : fileSha(target);
        });
        await afterWrite();
        return { path: `wiki/${normalized}`, updated: true, ...(sha256 === undefined ? {} : { sha256 }) };
      }
    );
    const create = (name, content, kind) => async () => {
      const slug = pageSlug(name);
      // An empty slug (no ASCII letter or digit) would name a hidden `.md` file; refuse before anything is written.
      if (!slug) throw mcpError('E_INVALID_INPUT', 'The page name needs at least one ASCII letter or digit.');
      const rel = `${kind}/${slug}.md`;
      // Frontmatter in the content (summary, description, tags, ...) is the page's own frontmatter, as in wiki_write_page:
      // it is written as frontmatter, not as body text, and the index line is built from it as wiki_update_index does.
      const parsed = core.parseFrontmatter(content);
      if (parsed.errors.length) throw mcpError('E_INVALID_INPUT', 'Page frontmatter is invalid.');
      // The title is always the create name; other keys (summary, description, tags, ...) come from the content.
      const frontmatter = {
        type: kind === 'entities' ? 'entity' : 'concept',
        tags: [],
        created: new Date().toISOString(),
        ...parsed.data,
        title: name,
      };
      checkWrite(`wiki/${rel}`, serializePage({ frontmatter, body: parsed.body }));
      const { target } = await safeFile(rel, { allowIndex: false });
      const indexTarget = (await safeFile('index.md')).target;
      // Same minimal edit as wiki_update_index, limited to this page: the rest of the index is kept byte for byte.
      const entry = {
        path: rel,
        title: typeof frontmatter.title === 'string' ? frontmatter.title : rel,
        frontmatter,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      };
      await writeLocked(async () => {
        try {
          await stat(target);
          throw mcpError('E_ALREADY_EXISTS', 'The destination page already exists.');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const existing = await readOptionalIndex(indexTarget);
        const indexOutput =
          existing === null ? freshIndex([entry]) : mergeIndex(existing, [entry], { prune: false }).output;
        checkWrite('wiki/index.md', indexOutput);
        await writePageAtomic(target, { frontmatter, body: parsed.body });
        await writeIndexAtomic(indexTarget, indexOutput);
        await logEntry(kind === 'entities' ? 'create-entity' : 'create-concept', `wiki/${rel}`);
      });
      await afterWrite();
      return { path: `wiki/${rel}`, created: true };
    };
    tool('wiki_create_entity', z.object({ name: z.string().min(1), content: z.string() }), ({ name, content }) =>
      create(name, content, 'entities')()
    );
    tool('wiki_create_concept', z.object({ name: z.string().min(1), content: z.string() }), ({ name, content }) =>
      create(name, content, 'concepts')()
    );
    tool('wiki_add_crosslinks', z.object({ path: z.string() }), async ({ path }) => {
      const { normalized, target } = await safeFile(path, { allowIndex: false });
      const linked = await writeLocked(async () => {
        const page = await wiki.readPage(target);
        const normalizedTargets = wiki.getPageLinksDetailed(page.body).map(({ target: link }) => {
          const rel = posix.normalize(posix.join(posix.dirname(normalized), link));
          if (!rel || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel))
            throw mcpError('E_PATH_ESCAPE', 'Crosslink path is outside the Wiki.');
          return rel;
        });
        for (const rel of normalizedTargets) await safeFile(rel, { allowIndex: false });
        const links = [];
        for (const rel of normalizedTargets) {
          const targetPage = await wiki.readPage((await safeFile(rel, { allowIndex: false })).target);
          const title =
            typeof targetPage.frontmatter.title === 'string'
              ? targetPage.frontmatter.title
              : rel.split('/').at(-1).replace(/\.md$/, '');
          if (core.scanText(title).length)
            throw mcpError('E_SECRET_DETECTED', 'write refused: secret-like content detected');
          links.push(`- [${wiki.escapeMarkdownLinkText(title)}](${posix.relative(posix.dirname(normalized), rel)})`);
        }
        const resultBody = `${page.body}\n\n## See also\n${links.join('\n')}`;
        checkWrite(`wiki/${normalized}`, serializePage({ frontmatter: page.frontmatter, body: resultBody }));
        await wiki.addCrosslinks(wikiDir, normalized, normalizedTargets);
        await logEntry('add-crosslinks', `wiki/${normalized}`);
        return normalizedTargets.length;
      });
      await afterWrite();
      return { path: `wiki/${normalized}`, linked };
    });
    tool('wiki_update_index', z.object({}), async () => {
      const { target } = await safeFile('index.md');
      const result = await writeLocked(async () => {
        const entries = [];
        for (const { path, file } of await listManagedPages()) {
          // A page whose frontmatter cannot be read is still listed, with the no-title fallback, so one page never fails the whole update.
          let page;
          try {
            page = await wiki.readPage(file);
          } catch {
            page = { frontmatter: {}, body: '' };
          }
          entries.push({
            path,
            title: typeof page.frontmatter.title === 'string' ? page.frontmatter.title : path,
            tags: Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags : [],
            frontmatter: page.frontmatter,
          });
        }
        const existing = await readOptionalIndex(target);
        if (existing === null) {
          // No index yet (or an empty file): build it from the pages, with the same line format as the minimal edit.
          const output = freshIndex(entries);
          checkWrite('wiki/index.md', output);
          await writeIndexAtomic(target, output);
          await logEntry('update-index', 'wiki/index.md');
          return {
            indexed: entries.length,
            added: entries.filter((entry) => indexablePath(entry.path)).length,
            removed: 0,
          };
        }
        const { output, added, removed } = mergeIndex(existing, entries);
        checkWrite('wiki/index.md', output);
        await writeIndexAtomic(target, output);
        await logEntry('update-index', 'wiki/index.md');
        return { indexed: entries.length, added, removed };
      });
      await afterWrite();
      return result;
    });
  }
  return server;
}

/**
 * Paths and config exactly as the stdio server builds them, so an in-process caller sees the same vault, config, state
 * directory and retrieval settings.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{config:object,paths:object,env:object}>}
 */
export async function serverOptions(env) {
  const paths = core.resolvePaths({ env, platform: env.BRAINATLAS_PLATFORM || process.platform });
  if (env.BRAINATLAS_CONFIG) paths.configFile = resolve(env.BRAINATLAS_CONFIG);
  const config = await core.loadConfig({ paths, env });
  return { config, paths, env };
}

/** @returns {Promise<void>} */
export async function main() {
  const env = process.env;
  const server = createServer(await serverOptions(env));
  await server.connect(new StdioServerTransport());
}

export { callToolInProcess } from './in-process.mjs';
