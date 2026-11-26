// SPDX-License-Identifier: MIT
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { chmod, lstat, readFile, readdir, realpath, rename, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import * as core from '@brainatlas/core';
import { LOCK_FILE_NAME, withLock } from './lock.mjs';
import { pageSlug } from './slug.mjs';
import {
  BACKLOG_REL,
  PROJECTS_REL,
  PROJECT_STATUSES,
  TASK_STATUSES,
  SLUG,
  PROJECT_ID,
  TASK_ID,
  parseBacklog,
  parseTasks,
  projectDocument,
  backlogDocument,
  taskIds,
  backlogRow,
  nextProjectId,
  nextTaskId,
  appendBacklogRow,
  setUpdatedLine,
  setBacklogStatus,
  appendTask,
  setTaskStatus,
  setProjectStatus,
} from './planning.mjs';

import * as wiki from '@llmwiki/core';
const TOOL_LIMIT = 20_000;
const PLANNING_PAGE_NAME = /(^|-)(backlog|todo|tasks|roadmap)(-|$)/i;
const PLANNING_WARNING = 'Planning content belongs in planning/; use plan_update.';
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
  if (error?.code === 'E_PATH_ESCAPE' && error.message === 'Path is outside planning/.')
    return 'E_PATH_ESCAPE: Path is outside planning/.';
  if (error?.code === 'E_PATH_ESCAPE') return 'E_PATH_ESCAPE: path is outside the Wiki.';
  if (error?.code === 'E_INVALID_INPUT') return `E_INVALID_INPUT: ${error.message}`;
  if (
    (error?.code === 'E_ARGUMENT' &&
      /^(project|maxChars|title|purpose|status|priority|slug|id|task|op|expectedSha256) /u.test(error.message)) ||
    (error?.code === 'E_NOT_FOUND' &&
      (/^(Project|Task) .+ is not in planning\//u.test(error.message) ||
        error.message === 'planning/backlog.md is missing.'))
  )
    return `${error.code}: ${error.message}`;
  if (typeof error?.code === 'string' && /^E_[A-Z_]+$/.test(error.code)) return `${error.code}: operation refused.`;
  return 'E_MCP_OPERATION: operation failed.';
}
function serializePage(page) {
  const fm = Object.entries(page.frontmatter ?? {})
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`)
    .join('\n');
  return `---\n${fm}\n---\n${page.body ?? ''}\n`;
}
const FRONTMATTER = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
function pageBody(text) {
  const match = text.match(FRONTMATTER);
  return match ? text.slice(match[0].length) : text;
}
const INDEX_CATEGORY_LINE = /^##\s+(.+)$/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const PATCH_KEYS = new Set(['frontmatter', 'body', 'append']);

const PROVENANCE_KEYS = ['generated', 'status', 'sources', 'verified', 'stale_after'];
function provenanceOf(frontmatter) {
  const fm = frontmatter ?? {};
  const filled = (value) =>
    value !== null &&
    value !== undefined &&
    value !== '' &&
    !(Array.isArray(value) && value.length === 0) &&
    !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  const present = PROVENANCE_KEYS.filter((key) => Object.hasOwn(fm, key) && filled(fm[key])).length;
  return present === 0 ? 'none' : present === PROVENANCE_KEYS.length ? 'full' : 'partial';
}

function withWriteProvenance(frontmatter, now = new Date()) {
  const next = { ...frontmatter };
  if (!Object.hasOwn(next, 'generated')) next.generated = now.toISOString();
  return next;
}
/**
 * @param {Record<string, unknown>} frontmatter frontmatter parsed from the new content
 * @param {Record<string, unknown>|undefined} existing frontmatter of the page on disk, or undefined when it is new
 * @param {Date} [now] clock used only for a new page
 * @returns {Record<string, unknown>}
 */
function withReplacementProvenance(frontmatter, existing, now = new Date()) {
  if (existing === undefined) return withWriteProvenance(frontmatter, now);
  const next = { ...frontmatter };
  if (Object.hasOwn(next, 'generated')) return next;
  const previous = existing.generated;
  if (typeof previous === 'string' && previous.trim() !== '') next.generated = previous;
  return next;
}
function unescapeDestination(raw) {
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
/**
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
function indexLineInfo(line) {
  const trimmed = line.trim();
  const heading = trimmed.match(INDEX_CATEGORY_LINE);
  if (heading) return { heading: heading[1].trim() };
  const destination = entryDestination(trimmed);
  if (destination === undefined) return {};
  const path = destination.replace(/[#?].*$/s, '');
  return path ? { entryPath: posix.normalize(path) } : {};
}
function indexedPaths(content) {
  const paths = new Set();
  if (content === null) return paths;
  for (const info of classifyLines(content.split('\n')).infos)
    if (info.entryPath !== undefined) paths.add(info.entryPath);
  return paths;
}
/**
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
function categoryOf(path) {
  return path.includes('/') ? path.split('/')[0] : 'Pages';
}
const UNSAFE_PATH = /[\r\n\u0085\u2028\u2029]/;
function indexablePath(path) {
  return !UNSAFE_PATH.test(path);
}
function isLocalMarkdownTarget(path) {
  return path.endsWith('.md') && !path.startsWith('/') && !path.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(path);
}
function cleanLabel(text) {
  // eslint-disable-next-line no-control-regex -- index labels match C0/C1 control characters on purpose so an entry stays on one line
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
}
function entryTitle(entry) {
  return cleanLabel(String(entry.title)) || cleanLabel(posix.basename(entry.path, '.md')) || cleanLabel(entry.path);
}
function indexEntryLine(entry) {
  const fm = entry.frontmatter ?? {};
  const summarySource = [fm.summary, fm.description].find((value) => typeof value === 'string' && cleanLabel(value));
  const summary = summarySource ? cleanLabel(summarySource) : '';
  const tags = entry.tags.filter((tag) => typeof tag === 'string' && /^[\w-]+$/.test(tag));
  const title = wiki.escapeMarkdownLinkText(entryTitle(entry));
  const parts = [summary, ...(tags.length ? [tags.map((tag) => `#${tag}`).join(' ')] : [])].filter(Boolean);
  return `- [${title}](${indexDestination(entry.path)})${parts.length ? ` — ${parts.join(' ')}` : ''}`;
}
function indexDestination(path) {
  const escaped = path.replace(/([\\()])/g, '\\$1');
  // eslint-disable-next-line no-control-regex -- index labels match C0/C1 control characters on purpose so an entry stays on one line
  if (!/[\s\x00-\x1f\x7f-\x9f]/.test(path) && !path.startsWith('<')) return escaped;
  return `<${escaped.replace(/[<>]/g, '\\$&')}>`;
}
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
 * @returns {{output:string, added:number, removed:number}}
 */
function mergeIndex(content, entries, { prune = true } = {}) {
  const cr = content.includes('\r\n') ? '\r' : '';
  const fresh = (text) => `${text}${cr}`;
  const isBlank = (text) => text.trim() === '';
  const pagePaths = new Set(entries.map((entry) => entry.path));
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
      const block = [
        ...(openFence ? [fresh(openFence.char.repeat(openFence.length))] : []),
        fresh(''),
        fresh(`## ${category}`),
        fresh(''),
        line,
      ];
      if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, ...block);
      else lines.push(...block);
      continue;
    }
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
  if (cr && output.endsWith('\r')) output += '\n';
  return { output, added: missing.length, removed };
}
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
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
/** @param {{config:any,paths:any,env:any,fetchImpl?:Function,dryRun?:boolean}} options */
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
  const excludeRules = config.retrieval?.exclude ?? core.DEFAULT_EXCLUDE_WIKI;
  const isExcluded = (rel) => core.isExcludedPath(rel, excludeRules);
  let searcher = null;
  const getSearcher = () => (searcher ??= core.createSearcher({ vaultDir: wikiDir, stateDir, exclude: excludeRules }));
  if (options.dryRun !== true) getSearcher();
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
  const contentFilter = core.secretFilterEnabled(config);
  const checkWrite = (rel, content) => {
    if (
      core.scanPath(rel, { extraDenyGlobs: config.safety?.extraDenyGlobs ?? [] }).length ||
      (contentFilter && core.scanText(content).length)
    )
      throw mcpError('E_SECRET_DETECTED', 'write refused: secret-like content detected');
  };
  const writeLocked = async (work) => {
    try {
      await lstat(wikiDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(wikiDir, { recursive: true });
    }
    const canonicalWiki = await assertWikiInsideVault();
    return withLock(join(canonicalWiki, LOCK_FILE_NAME), work);
  };
  /**
   * @returns {Promise<boolean>} whether wiki/ exists
   */
  const dryRunWikiCheck = async () => {
    try {
      await lstat(wikiDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return false;
    }
    await assertWikiInsideVault();
    return true;
  };
  const fileSha = async (file) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
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
  const existingFrontmatter = async (target) => {
    try {
      return core.parseFrontmatter(await readFile(target, 'utf8')).data;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
      throw error;
    }
  };
  const logEntry = async (action, rel) => {
    const record = JSON.stringify({ action, path: rel });
    checkWrite('wiki/log.md', record);
    if (rel.startsWith('wiki/')) return core.appendLog(vaultDir, { action, path: rel });
    const target = join(await assertWikiInsideVault(), 'log.md');
    let content = '';
    try {
      content = await readFile(target, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await replaceFile(target, (temp) =>
      writeFile(temp, `${content}\n- ${new Date().toISOString()} ${record}\n`, 'utf8')
    );
  };
  const afterWrite = async () => {
    try {
      await getSearcher().refresh();
      // eslint-disable-next-line no-empty
    } catch {}
    scheduleUpdate();
  };
  const descriptionFor = (name) => {
    const summary = core.OPERATIONS.find((operation) => operation.tool === name)?.summary;
    return name === 'wiki_query' && config.retrieval?.pullLowConfidence !== false
      ? `${summary} Results marked lowConfidence scored below the abstain threshold; treat them as weak evidence and verify before relying on them.`
      : summary;
  };
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
  const listManagedPages = async () => {
    const canonicalWiki = await assertWikiInsideVault();
    return (await core.listPages(vaultDir))
      .map((rel) => ({ path: rel.slice('wiki/'.length), file: join(canonicalWiki, rel.slice('wiki/'.length)) }))
      .filter(({ path }) => !['index.md', 'log.md'].includes(path.split('/').at(-1)));
  };
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

  const today = () => new Date().toISOString().slice(0, 10);
  const shaText = (text) => createHash('sha256').update(text).digest('hex');
  const restorePlanningFile = (target, content) =>
    replaceFile(target, (temp) => writeFile(temp, content, 'utf8')).catch(() => {});
  const planningTarget = async (rel) => {
    if (typeof rel !== 'string' || !rel.startsWith('planning/') || rel.includes('\\') || rel.includes('\0'))
      throw mcpError('E_PATH_ESCAPE', 'Path is outside planning/.');
    const parts = rel.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..'))
      throw mcpError('E_PATH_ESCAPE', 'Path is outside planning/.');
    const canonicalVault = await realpath(vaultDir);
    let cursor = canonicalVault;
    for (const part of parts) {
      cursor = join(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw mcpError('E_PATH_ESCAPE', 'Path is outside planning/.');
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        break;
      }
    }
    const target = join(canonicalVault, rel);
    let resolved = target;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      try {
        resolved = join(await realpath(dirname(target)), basename(target));
        // eslint-disable-next-line no-empty
      } catch {}
    }
    const from = relative(canonicalVault, resolved);
    if (!from || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from))
      throw mcpError('E_PATH_ESCAPE', 'Path is outside planning/.');
    return { target: resolved, rel };
  };
  const ensurePlanningDirs = async () => {
    const canonicalVault = await realpath(vaultDir);
    for (const rel of ['planning', PROJECTS_REL]) {
      const target = join(canonicalVault, rel);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isDirectory()) throw mcpError('E_PATH_ESCAPE', 'Path is outside planning/.');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await mkdir(target, { recursive: true });
      }
    }
  };
  const readBacklog = async (required) => {
    const { target } = await planningTarget(BACKLOG_REL);
    try {
      return await readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        if (required) throw mcpError('E_NOT_FOUND', 'planning/backlog.md is missing.');
        return null;
      }
      throw error;
    }
  };
  const findProject = (rows, ref) => {
    const byId = PROJECT_ID.test(ref) ? rows.find((row) => row.id === ref) : undefined;
    return byId ?? rows.find((row) => row.file === `projects/${ref}.md`);
  };
  const resolveProject = async (ref) => {
    if (typeof ref !== 'string' || !ref) throw mcpError('E_ARGUMENT', 'project must be a non-empty string.');
    const rows = parseBacklog((await readBacklog(false)) ?? '');
    const row = findProject(rows, ref);
    if (!row) throw mcpError('E_NOT_FOUND', `Project ${ref} is not in planning/backlog.md.`);
    return row;
  };
  const readProjectText = async (ref, target) => {
    try {
      return await readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        throw mcpError('E_NOT_FOUND', `Project ${ref} is not in planning/backlog.md.`);
      throw error;
    }
  };
  /** @param {{project?:string,maxChars?:number}} [args] */
  const planRead = async (args = {}) => {
    const { project, maxChars } = args;
    if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000))
      throw mcpError('E_ARGUMENT', 'maxChars must be an integer between 1 and 200000.');
    if (project === undefined) {
      const text = await readBacklog(false);
      if (text === null) return { projects: [], warnings: ['planning/backlog.md is missing.'] };
      const projects = parseBacklog(text);
      const warnings = [];
      let entries = [];
      try {
        entries = await readdir((await planningTarget(PROJECTS_REL)).target, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      }
      const names = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
      for (const name of names)
        if (!projects.some((row) => row.file === `projects/${name}`))
          warnings.push(`planning/projects/${name} is not listed in backlog.md.`);
      return { projects, warnings };
    }
    if (typeof project !== 'string' || !project) throw mcpError('E_ARGUMENT', 'project must be a non-empty string.');
    const row = await resolveProject(project);
    const { target } = await planningTarget(posix.normalize(`planning/${row.file}`));
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        throw mcpError('E_NOT_FOUND', `Project ${project} is not in planning/backlog.md.`);
      throw error;
    }
    const raw = bytes.toString('utf8');
    const content = core.prefixKeepingPairs(raw, maxChars ?? 20000);
    return {
      id: row.id,
      file: row.file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content,
      truncated: content.length < raw.length,
      tasks: parseTasks(raw),
    };
  };
  const planString = (description) => z.string().optional().catch(null).describe(description);
  const planStatusSchema = z
    .enum(['idea', 'ready', 'in_progress', 'blocked', 'done', 'archived', 'dropped'])
    .optional()
    .catch(null)
    .describe('Project or task status.');
  const planReadSchema = z.object({
    project: planString('Project id (PRJ-NNN) or slug; omit to list the backlog.'),
    maxChars: z
      .number()
      .int()
      .min(1)
      .max(200000)
      .optional()
      .catch(null)
      .describe('Maximum content characters (1 to 200000; default 20000).'),
  });
  tool('plan_read', planReadSchema, async (args) => planRead(args));

  const planLine = (name, value) => {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 200 ||
      value.trim() === '' ||
      /[\r\n|]/u.test(value)
    )
      throw mcpError('E_ARGUMENT', `${name} must be a single line of 1 to 200 characters without "|".`);
    return value;
  };
  const planStatus = (name, value, allowed) => {
    if (typeof value !== 'string' || !allowed.includes(value))
      throw mcpError('E_ARGUMENT', `${name} must be one of: ${allowed.join(', ')}.`);
    return value;
  };
  const planSha = (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(value))
      throw mcpError('E_ARGUMENT', 'expectedSha256 must be a 64-character hex SHA-256.');
    return value;
  };
  const planUpdate = async (args = {}) => {
    if (!['add_project', 'add_task', 'set_status'].includes(args.op))
      throw mcpError('E_ARGUMENT', 'op must be add_project, add_task or set_status.');
    const expectedSha256 = planSha(args.expectedSha256);
    const work = async () => {
      if (args.op === 'add_project') {
        if (typeof args.slug !== 'string' || !SLUG.test(args.slug)) throw mcpError('E_ARGUMENT', 'slug is invalid.');
        const title = planLine('title', args.title);
        const purpose = planLine('purpose', args.purpose);
        const status = args.status === undefined ? 'idea' : planStatus('status', args.status, PROJECT_STATUSES);
        const priority = args.priority === undefined ? '—' : planLine('priority', args.priority);
        const backlog = (await planningTarget(BACKLOG_REL)).target;
        await checkExpectedSha(backlog, expectedSha256);
        const existingBacklog = await readBacklog(false);
        const text = existingBacklog ?? (await backlogDocument());
        const rows = parseBacklog(text);
        const rel = `planning/projects/${args.slug}.md`;
        const { target } = await planningTarget(rel);
        let exists = true;
        try {
          await lstat(target);
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
          exists = false;
        }
        if (exists || rows.some((row) => row.file === `projects/${args.slug}.md`))
          throw mcpError('E_CONFLICT', 'The project already exists.');
        const id = nextProjectId(rows);
        const content = await projectDocument({ id, title, status, goal: purpose });
        const nextBacklog = setUpdatedLine(
          appendBacklogRow(text, backlogRow({ id, title, purpose, priority, status, slug: args.slug })),
          today()
        );
        checkWrite(rel, content);
        checkWrite(BACKLOG_REL, nextBacklog);
        if (options.dryRun !== true) {
          await ensurePlanningDirs();
          try {
            await replaceFile(target, (temp) => writeFile(temp, content, 'utf8'));
            await replaceFile(backlog, (temp) => writeFile(temp, nextBacklog, 'utf8'));
            await logEntry('plan-update', rel);
          } catch (error) {
            await unlink(target).catch(() => {});
            if (existingBacklog === null) await unlink(backlog).catch(() => {});
            else await restorePlanningFile(backlog, existingBacklog);
            throw error;
          }
        }
        return { op: args.op, file: rel, sha256: shaText(content), id };
      }
      if (args.op === 'add_task') {
        const title = planLine('title', args.title);
        const status = args.status === undefined ? 'ready' : planStatus('status', args.status, TASK_STATUSES);
        if (args.id !== undefined && (typeof args.id !== 'string' || !TASK_ID.test(args.id)))
          throw mcpError('E_ARGUMENT', 'id is invalid.');
        const row = await resolveProject(args.project);
        const rel = posix.normalize(`planning/${row.file}`);
        const { target } = await planningTarget(rel);
        const text = await readProjectText(args.project, target);
        await checkExpectedSha(target, expectedSha256);
        const tasks = parseTasks(text);
        const id = args.id ?? nextTaskId(tasks, row.id);
        if (taskIds(text).includes(id)) throw mcpError('E_CONFLICT', `Task ${id} already exists.`);
        const content = appendTask(text, `- [${status}] ${id} · ${title} (${today()})`);
        checkWrite(rel, content);
        const backlog = await readBacklog(false);
        const nextBacklog = backlog === null ? null : setUpdatedLine(backlog, today());
        const writeBacklog = nextBacklog !== null && nextBacklog !== backlog;
        if (writeBacklog) checkWrite(BACKLOG_REL, nextBacklog);
        if (options.dryRun !== true) {
          const backlogTarget = writeBacklog ? (await planningTarget(BACKLOG_REL)).target : null;
          try {
            await replaceFile(target, (temp) => writeFile(temp, content, 'utf8'));
            if (writeBacklog) await replaceFile(backlogTarget, (temp) => writeFile(temp, nextBacklog, 'utf8'));
            await logEntry('plan-update', rel);
          } catch (error) {
            await restorePlanningFile(target, text);
            if (writeBacklog) await restorePlanningFile(backlogTarget, backlog);
            throw error;
          }
        }
        return { op: args.op, file: rel, sha256: shaText(content), id };
      }
      const withTask = args.task !== undefined;
      if (withTask && (typeof args.task !== 'string' || !TASK_ID.test(args.task)))
        throw mcpError('E_ARGUMENT', 'task is invalid.');
      const status = planStatus('status', args.status, withTask ? TASK_STATUSES : PROJECT_STATUSES);
      const row = await resolveProject(args.project);
      const rel = posix.normalize(`planning/${row.file}`);
      const { target } = await planningTarget(rel);
      const text = await readProjectText(args.project, target);
      await checkExpectedSha(target, expectedSha256);
      let content;
      if (withTask) {
        if (!parseTasks(text).some((task) => task.id === args.task))
          throw mcpError('E_NOT_FOUND', `Task ${args.task} is not in ${rel}.`);
        content = setTaskStatus(text, args.task, status);
      } else content = setProjectStatus(text, status);
      checkWrite(rel, content);
      const backlog = await readBacklog(false);
      let nextBacklog = backlog;
      if (backlog !== null) {
        nextBacklog = setUpdatedLine(backlog, today());
        if (!withTask) nextBacklog = setBacklogStatus(nextBacklog, row.id, status);
      }
      const writeBacklog = nextBacklog !== null && nextBacklog !== backlog;
      if (writeBacklog) checkWrite(BACKLOG_REL, nextBacklog);
      if (options.dryRun !== true) {
        const backlogTarget = writeBacklog ? (await planningTarget(BACKLOG_REL)).target : null;
        try {
          await replaceFile(target, (temp) => writeFile(temp, content, 'utf8'));
          if (writeBacklog) await replaceFile(backlogTarget, (temp) => writeFile(temp, nextBacklog, 'utf8'));
          await logEntry('plan-update', rel);
        } catch (error) {
          await restorePlanningFile(target, text);
          if (writeBacklog) await restorePlanningFile(backlogTarget, backlog);
          throw error;
        }
      }
      return { op: args.op, file: rel, sha256: shaText(content) };
    };
    if (options.dryRun === true) return { ...(await work()), dryRun: true };
    return writeLocked(work);
  };

  const queryWiki = async ({ query, limit, compact }) => {
    const count = limit ?? 5;
    try {
      if (getSearcher().refreshIfChanged() && semanticEnabled) scheduleUpdate();
      // eslint-disable-next-line no-empty
    } catch {}
    const answer = getSearcher().search(query, {
      limit: count,
      budgetChars: Math.min(config.retrieval?.budgetChars ?? 4000, TOOL_LIMIT),
      abstainThreshold: config.retrieval?.abstainThreshold ?? 0.35,
    });
    const stripSnippets = (rows) => (compact === true ? rows.map(({ snippet, ...rest }) => rest) : rows);
    const lowConfidenceAnswer = () => {
      if (
        config.retrieval?.pullLowConfidence === false ||
        answer.abstained !== true ||
        answer.reason !== 'below_threshold'
      )
        return null;
      const weak = getSearcher().search(query, {
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
      const snapshot = getSearcher().snapshot();
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
      const semanticPrimary = settings.mode === 'semantic-primary';
      const normalized = visible.map((item) => {
        const original = answer.results.find((row) => row.path === item.path);
        const section = sections.get(item.path) ?? pageSection(item, queryTerms) ?? chunkSection(item);
        const chunkHeading = item.headingPath?.split(' > ').at(-1) || null;
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
        if (synthesized && row.trust === 'verified') delete row.trust;
        return row;
      });
      return { results: stripSnippets(normalized), abstained: false, semantic: { used: true }, mode: settings.mode };
    } catch (error) {
      return fallback(error?.fallbackReason === 'remote-not-allowed' ? 'remote-not-allowed' : 'provider-error');
    }
  };
  const annotateProvenance = (answer) => {
    if (!Array.isArray(answer?.results) || !answer.results.length) return answer;
    const byPath = new Map(
      getSearcher()
        .snapshot()
        .pages.map((page) => [page.path, page.frontmatter])
    );
    return {
      ...answer,
      results: answer.results.map((row) => ({ ...row, provenance: provenanceOf(byPath.get(row.path)) })),
    };
  };
  readTool(
    'wiki_query',
    z.object({
      query: z.string(),
      limit: z.number().int().min(0).max(20).optional(),
      compact: z.boolean().optional(),
      provenance: z.boolean().optional(),
    }),
    async (args) => {
      const answer = await queryWiki(args);
      return args.provenance === true ? annotateProvenance(answer) : answer;
    }
  );
  readTool(
    'wiki_read_page',
    z.object({ path: z.string(), anchor: z.unknown().optional(), maxChars: z.unknown().optional() }),
    async ({ path, anchor, maxChars }) => {
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
      const bytes = await readFile(target);
      const raw = bytes.toString('utf8');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const shownPath = `wiki/${normalized}`;
      if (wanted !== undefined) {
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
      if (maxChars === undefined)
        return { path: shownPath, content: raw.slice(0, TOOL_LIMIT), truncated: raw.length > TOOL_LIMIT, sha256 };
      const content = core.prefixKeepingPairs(raw, Math.min(maxChars, TOOL_LIMIT));
      return { path: shownPath, content, truncated: content.length < raw.length, sha256 };
    }
  );
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
      // eslint-disable-next-line no-empty
    } catch {}
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
        const work = async () => {
          await checkExpectedSha(target, expectedSha256);
          const existing = await existingFrontmatter(target);
          if (options.dryRun !== true) {
            await writePageAtomic(target, {
              frontmatter: withReplacementProvenance(parsed.data, existing),
              body: parsed.body,
            });
            await logEntry('write-page', `wiki/${normalized}`);
          }
          const sha256 = expectedSha256 === undefined || options.dryRun === true ? undefined : await fileSha(target);
          return { created: existing === undefined, sha256 };
        };
        if (options.dryRun === true) await dryRunWikiCheck();
        const { created, sha256 } = options.dryRun === true ? await work() : await writeLocked(work);
        if (options.dryRun !== true) await afterWrite();
        const misplaced = PLANNING_PAGE_NAME.test(normalized.split('/').at(-1).replace(/\.md$/u, ''));
        return {
          path: `wiki/${normalized}`,
          written: true,
          created,
          ...(options.dryRun === true ? { dryRun: true } : {}),
          ...(sha256 === undefined ? {} : { sha256 }),
          ...(misplaced ? { warnings: [PLANNING_WARNING] } : {}),
        };
      }
    );
    tool(
      'wiki_update_page',
      z.object({ path: z.string(), content: z.string().optional(), patch: z.unknown().optional(), expectedSha256 }),
      async ({ path, content, patch, expectedSha256 }) => {
        const { normalized, target } = await safeFile(path, { allowIndex: false });
        const work = async () => {
          await checkExpectedSha(target, expectedSha256);
          const old = await wiki.readPage(target);
          let next;
          if (patch !== undefined) validatePatch(patch);
          if (content !== undefined) {
            const parsed = core.parseFrontmatter(content);
            if (parsed.errors.length) throw mcpError('E_INVALID_INPUT', 'Page frontmatter is invalid.');
            const existing = await existingFrontmatter(target);
            next = { frontmatter: withReplacementProvenance(parsed.data, existing), body: parsed.body };
          } else if (patch) {
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
          if (options.dryRun !== true) {
            await writePageAtomic(target, next);
            await logEntry('update-page', `wiki/${normalized}`);
          }
          return expectedSha256 === undefined || options.dryRun === true ? undefined : fileSha(target);
        };
        if (options.dryRun === true) await dryRunWikiCheck();
        const sha256 = options.dryRun === true ? await work() : await writeLocked(work);
        if (options.dryRun !== true) await afterWrite();
        return {
          path: `wiki/${normalized}`,
          updated: true,
          ...(sha256 === undefined ? {} : { sha256 }),
          ...(options.dryRun === true ? { dryRun: true } : {}),
        };
      }
    );
    const create = (name, content, kind) => async () => {
      const slug = pageSlug(name);
      if (!slug) throw mcpError('E_INVALID_INPUT', 'The page name needs at least one ASCII letter or digit.');
      const rel = `${kind}/${slug}.md`;
      const parsed = core.parseFrontmatter(content);
      if (parsed.errors.length) throw mcpError('E_INVALID_INPUT', 'Page frontmatter is invalid.');
      const frontmatter = {
        type: kind === 'entities' ? 'entity' : 'concept',
        tags: [],
        created: new Date().toISOString(),
        ...withWriteProvenance(parsed.data),
        title: name,
      };
      checkWrite(`wiki/${rel}`, serializePage({ frontmatter, body: parsed.body }));
      const { target } = await safeFile(rel, { allowIndex: false });
      const indexTarget = (await safeFile('index.md')).target;
      const entry = {
        path: rel,
        title: typeof frontmatter.title === 'string' ? frontmatter.title : rel,
        frontmatter,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      };
      const work = async () => {
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
        if (options.dryRun !== true) {
          await writePageAtomic(target, { frontmatter, body: parsed.body });
          await writeIndexAtomic(indexTarget, indexOutput);
          await logEntry(kind === 'entities' ? 'create-entity' : 'create-concept', `wiki/${rel}`);
        }
        return { misplaced: PLANNING_PAGE_NAME.test(slug) };
      };
      if (options.dryRun === true) await dryRunWikiCheck();
      const { misplaced } = options.dryRun === true ? await work() : await writeLocked(work);
      if (options.dryRun !== true) await afterWrite();
      return {
        path: `wiki/${rel}`,
        created: true,
        ...(misplaced ? { warnings: [PLANNING_WARNING] } : {}),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      };
    };
    tool(
      'wiki_create',
      z.object({ type: z.enum(['entity', 'concept']), name: z.string().min(1), content: z.string() }),
      ({ type, name, content }) => create(name, content, type === 'entity' ? 'entities' : 'concepts')()
    );
    tool('wiki_add_crosslinks', z.object({ path: z.string() }), async ({ path }) => {
      const { normalized, target } = await safeFile(path, { allowIndex: false });
      const work = async () => {
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
          if (contentFilter && core.scanText(title).length)
            throw mcpError('E_SECRET_DETECTED', 'write refused: secret-like content detected');
          links.push(`- [${wiki.escapeMarkdownLinkText(title)}](${posix.relative(posix.dirname(normalized), rel)})`);
        }
        const resultBody = `${page.body}\n\n## See also\n${links.join('\n')}`;
        checkWrite(`wiki/${normalized}`, serializePage({ frontmatter: page.frontmatter, body: resultBody }));
        if (options.dryRun !== true) {
          await wiki.addCrosslinks(wikiDir, normalized, normalizedTargets);
          await logEntry('add-crosslinks', `wiki/${normalized}`);
        }
        return normalizedTargets.length;
      };
      if (options.dryRun === true) await dryRunWikiCheck();
      const linked = options.dryRun === true ? await work() : await writeLocked(work);
      if (options.dryRun !== true) await afterWrite();
      return {
        path: `wiki/${normalized}`,
        linked,
        ...(options.dryRun === true ? { dryRun: true } : {}),
      };
    });
    tool('wiki_update_index', z.object({}), async () => {
      const { target } = await safeFile('index.md');
      const wikiExists = options.dryRun === true ? await dryRunWikiCheck() : true;
      const work = async () => {
        const entries = [];
        if (wikiExists) {
          for (const { path, file } of await listManagedPages()) {
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
        }
        const existing = await readOptionalIndex(target);
        if (existing === null) {
          const output = freshIndex(entries);
          checkWrite('wiki/index.md', output);
          if (options.dryRun !== true) {
            await writeIndexAtomic(target, output);
            await logEntry('update-index', 'wiki/index.md');
          }
          return {
            indexed: entries.length,
            added: entries.filter((entry) => indexablePath(entry.path)).length,
            removed: 0,
          };
        }
        const { output, added, removed } = mergeIndex(existing, entries);
        checkWrite('wiki/index.md', output);
        if (options.dryRun !== true) {
          await writeIndexAtomic(target, output);
          await logEntry('update-index', 'wiki/index.md');
        }
        return { indexed: entries.length, added, removed };
      };
      const result = options.dryRun === true ? await work() : await writeLocked(work);
      if (options.dryRun !== true) await afterWrite();
      return { ...result, ...(options.dryRun === true ? { dryRun: true } : {}) };
    });
    tool(
      'plan_update',
      z.object({
        op: z.enum(['add_project', 'add_task', 'set_status']).optional().catch(null).describe('Operation to perform.'),
        slug: planString('Project slug (lowercase letters, digits and hyphens).'),
        title: planString('Single-line project or task title (1 to 200 characters).'),
        purpose: planString('Single-line project purpose (1 to 200 characters).'),
        status: planStatusSchema,
        priority: planString('Single-line project priority; defaults to an em dash.'),
        project: planString('Project id (PRJ-NNN) or slug.'),
        id: planString('Explicit task id; defaults to the next id in the project file.'),
        task: planString('Task id used by set_status.'),
        expectedSha256: planString('Expected SHA-256 of the project file (the backlog for add_project).'),
      }),
      async (args) => planUpdate(args)
    );
  }
  return server;
}

/**
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
