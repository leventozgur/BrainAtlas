// SPDX-License-Identifier: MIT
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import * as core from '@brainatlas/core';

import * as wiki from '@llmwiki/core';
const TOOL_LIMIT = 20_000;
const descriptions = {
  wiki_query: 'Search verified Wiki evidence and return ranked snippets.',
  wiki_read_page: 'Read a bounded Wiki page.', wiki_read_index: 'Read the bounded Wiki index.',
  wiki_list_pages: 'List Wiki Markdown page paths.', wiki_status: 'Read Wiki counts and health summary.',
  wiki_lint: 'Run the vendored Wiki quality checks.', wiki_write_page: 'Create or replace a Wiki page.',
  wiki_update_page: 'Update a Wiki page.', wiki_create_entity: 'Create an entity page.',
  wiki_create_concept: 'Create a concept page.', wiki_add_crosslinks: 'Add links to existing pages referenced by this page.',
  wiki_update_index: 'Rebuild the Wiki index from its pages.'
};

function mcpError(code, message) { const error = new Error(message); error.code = code; return error; }
function textResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
function asText(error) {
  if (error?.code === 'E_SECRET_DETECTED') return 'E_SECRET_DETECTED: write refused because secret-like content was detected.';
  if (error?.code === 'E_PATH_ESCAPE') return 'E_PATH_ESCAPE: path is outside the Wiki.';
  if (typeof error?.code === 'string' && /^E_[A-Z_]+$/.test(error.code)) return `${error.code}: operation refused.`;
  return 'E_MCP_OPERATION: operation failed.';
}
function serializePage(page) {
  const fm = Object.entries(page.frontmatter ?? {}).map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`).join('\n');
  return `---\n${fm}\n---\n${page.body ?? ''}\n`;
}
function serializeIndex(entries) {
  const categories = new Map();
  for (const entry of entries) {
    if (!categories.has(entry.category)) categories.set(entry.category, []);
    categories.get(entry.category).push(entry);
  }
  let output = '# Wiki Index\n';
  for (const [category, rows] of categories) {
    output += `\n## ${category}\n\n`;
    for (const row of rows) {
      const title = wiki.escapeMarkdownLinkText(row.title);
      const suffix = [row.summary, ...(row.tags.length ? [row.tags.map((tag) => `#${tag}`).join(' ')] : [])].filter(Boolean).join(' ');
      output += `- [${title}](${row.path})${suffix ? ` — ${suffix}` : ''}\n`;
    }
  }
  return output;
}

/** @param {{config:object,paths:object,env:object}} options @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} */
export function createServer(options) {
  if (!options || !options.config || !options.paths || !options.env) throw mcpError('E_MCP_OPTIONS', 'config, paths and env are required.');
  const { config, paths, env } = options;
  const home = typeof env.HOME === 'string' ? env.HOME : undefined;
  const requestedVault = paths.vaultDir ?? env.BRAINATLAS_VAULT ?? config.vault?.path;
  if (typeof requestedVault !== 'string' || !requestedVault) throw mcpError('E_VAULT_PATH', 'A Wiki vault path is required.');
  const vaultDir = resolve(isAbsolute(requestedVault) ? requestedVault : resolve(home ?? process.cwd(), requestedVault));
  const wikiDir = join(vaultDir, 'wiki');
  let stateDir = paths.stateDir;
  if (typeof stateDir !== 'string' || !stateDir) {
    if (home) {
      const platform = env.BRAINATLAS_PLATFORM || process.platform;
      stateDir = core.resolvePaths({ env, platform }).stateDir;
    }
    else {
      const vaultKey = createHash('sha256').update(vaultDir).digest('hex').slice(0, 16);
      stateDir = join(tmpdir(), 'brainatlas-state', vaultKey);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      chmodSync(stateDir, 0o700);
    }
  }
  let searcher = core.createSearcher({ vaultDir: wikiDir, stateDir });
  const semanticEnabled = config.semantic?.enabled === true && config.profile !== 'lite' && (config.modules?.includes('*') || config.modules?.includes('semantic'));
  let semanticModulePromise;
  let background = null;
  let backgroundDirty = false;
  let backgroundFailed = false;
  const backgroundController = new AbortController();
  const settings = { ...core.SEMANTIC_DEFAULTS, ...config.semantic };
  const loadSemantic = () => semanticModulePromise ??= (async () => {
    let release, releases;
    try {
      release = await realpath(paths.currentDir);
      releases = await realpath(paths.releasesDir);
      await stat(join(release, 'modules', 'semantic', 'module.json'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw Object.assign(new Error(), { fallbackReason: 'module-missing' });
      throw error;
    }
    const releaseRel = relative(releases, release);
    if (!releaseRel || releaseRel.startsWith(`..${sep}`) || isAbsolute(releaseRel) || releaseRel.includes(sep)) throw new Error();
    const manifest = (await core.discoverModules(release)).find(item => item.name === 'semantic');
    if (!manifest) throw Object.assign(new Error(), { fallbackReason: 'module-missing' });
    const dir = await realpath(join(release, 'modules', 'semantic'));
    if (relative(release, dir) !== join('modules', 'semantic')) throw new Error();
    const entry = await realpath(resolve(dir, manifest.entry));
    const rel = relative(dir, entry);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error();
    return import(pathToFileURL(entry).href);
  })();
  const providerFor = (module, indexing = false) => {
    module.validateConfiguredProvider(settings);
    return module.createOllamaProvider({ ...settings, ...(indexing ? { timeoutMs: settings.indexTimeoutMs, batchSize: settings.indexBatchSize } : {}), fetchImpl: options.fetchImpl ?? globalThis.fetch });
  };
  const scheduleUpdate = (markDirty = true) => {
    if (!semanticEnabled || backgroundController.signal.aborted) return;
    if (background) { if (markDirty) backgroundDirty = true; return; }
    background = (async () => {
      do {
        backgroundDirty = false;
        try {
          const module = await loadSemantic();
          await module.updateSemanticIndex({ corpusDir: wikiDir, stateDir, provider: providerFor(module, true), indexBatchSize: settings.indexBatchSize, signal: backgroundController.signal, chunkMarkdown: module.markdownChunks });
          backgroundFailed = false;
        } catch { backgroundFailed = true; }
      } while (backgroundDirty && !backgroundController.signal.aborted);
    })().finally(() => { background = null; });
  };
  const server = new McpServer({ name: 'brainatlas-mcp', version: '0.1.0' });
  server.server.onclose = () => backgroundController.abort();
  const close = server.close.bind(server);
  server.close = async () => {
    backgroundController.abort();
    await close();
    if (background) {
      let timer;
      try { await Promise.race([background, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timer); }
    }
  };

  const safeFile = async (rel, { allowIndex = true } = {}) => {
    if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes('\0')) throw mcpError('E_PATH_ESCAPE', 'Path is invalid.');
    let normalized = rel.replace(/^wiki\//, '');
    if (!allowIndex && ['index.md', 'log.md'].includes(normalized)) throw mcpError('E_PATH_ESCAPE', 'Managed Wiki files cannot be edited directly.');
    if (isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw mcpError('E_PATH_ESCAPE', 'Path is invalid.');
    if (core.scanPath(`wiki/${normalized}`, { extraDenyGlobs: config.safety?.extraDenyGlobs ?? [] }).length) throw mcpError('E_SECRET_DETECTED', 'write refused: denied path');
    const canonicalVault = await realpath(vaultDir);
    const canonicalWiki = join(canonicalVault, 'wiki');
    const target = core.safeJoin(canonicalWiki, normalized);
    const checked = await core.resolveSafePath(vaultDir, `wiki/${normalized}`);
    if (resolve(checked) !== target) {
      const from = relative(canonicalWiki, checked);
      if (!from || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)) throw mcpError('E_PATH_ESCAPE', 'Path is outside the Wiki.');
    }
    return { normalized, target: checked };
  };
  const checkWrite = (rel, content) => {
    if (core.scanPath(rel, { extraDenyGlobs: config.safety?.extraDenyGlobs ?? [] }).length || core.scanText(content).length) throw mcpError('E_SECRET_DETECTED', 'write refused: secret-like content detected');
  };
  const logAndRefresh = async (action, rel) => {
    const record = JSON.stringify({ action, path: rel });
    checkWrite('wiki/log.md', record);
    await core.appendLog(vaultDir, { action, path: rel });
    // The write has succeeded; a failed refresh must not turn it into an error. The next wiki_query retries via refreshIfChanged.
    try { await searcher.refresh(); } catch { /* Keep the last good index. */ }
    scheduleUpdate();
  };
  const tool = (name, schema, handler) => server.registerTool(name, { description: descriptions[name], inputSchema: schema.shape }, async (args) => {
    try { return textResult(await handler(args)); }
    catch (error) { return { content: [{ type: 'text', text: asText(error) }], isError: true }; }
  });
  const ensureWikiDirectory = async () => {
    try {
      if ((await stat(wikiDir)).isDirectory()) return;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    throw mcpError('E_VAULT_MISSING', 'The Wiki directory is missing.');
  };
  const readTool = (name, schema, handler) => tool(name, schema, async (args) => {
    await ensureWikiDirectory();
    return handler(args);
  });

  readTool('wiki_query', z.object({ query: z.string(), limit: z.number().int().min(0).max(20).optional() }), async ({ query, limit }) => {
    const count = limit ?? 5;
    // Edits made outside this server (Obsidian, sync, another agent's MCP process) are picked up here.
    // A failed freshness check (e.g. a file removed between the scan and the read) keeps the current index; the next query retries.
    try { if (searcher.refreshIfChanged() && semanticEnabled) scheduleUpdate(); } catch { /* Keep serving the last good index. */ }
    const answer = searcher.search(query, { limit: count, budgetChars: Math.min(config.retrieval?.budgetChars ?? 4000, TOOL_LIMIT), abstainThreshold: config.retrieval?.abstainThreshold ?? 0.35 });
    const lexical = { results: answer.results, abstained: answer.abstained };
    if (!semanticEnabled) return lexical;
    const fallback = reason => ({ ...lexical, semantic: { used: false, fallbackReason: reason }, mode: 'lexical' });
    try {
      let module;
      try { module = await loadSemantic(); }
      catch (error) { return fallback(error?.fallbackReason === 'module-missing' ? 'module-missing' : 'module-load-error'); }
      const provider = providerFor(module);
      const index = await module.readSemanticIndex(stateDir);
      const emptyIndexWithPages = index && index.entries.length === 0 && Object.keys(index.fileHashes).length === 0 &&
        (await core.listPages(vaultDir)).some(path => !['wiki/index.md', 'wiki/log.md'].includes(path));
      if (!index || emptyIndexWithPages) { scheduleUpdate(false); return fallback(emptyIndexWithPages || !backgroundFailed ? 'index-missing' : 'provider-error'); }
      if (index.providerFingerprint !== provider.fingerprint || index.dims !== provider.dims) { scheduleUpdate(false); return fallback('fingerprint-mismatch'); }
      const snapshot = searcher.snapshot();
      const results = await module.searchHybrid({ query, pages: snapshot.pages, lexicalIndex: snapshot.index, entries: index.entries, provider, limit: count, indexMeta: index, mode: settings.mode, minSemanticScore: settings.minScore, abstainThreshold: config.retrieval?.abstainThreshold ?? 0.35 });
      if (results.fallbackReason) return fallback(results.fallbackReason);
      if (results.abstained) return { ...lexical, semantic: { used: true }, mode: settings.mode };
      let budget = Math.min(config.retrieval?.budgetChars ?? 4000, TOOL_LIMIT);
      const normalized = results.map(item => {
        const original = answer.results.find(row => row.path === item.path);
        const heading = item.headingPath?.split(' > ').at(-1) || null;
        const snippet = String(item.snippet ?? '').slice(0, Math.max(0, budget)); budget -= snippet.length;
        return { ...original, path: item.path, title: item.title, score: item.semanticScore ?? item.score ?? item.rrfScore, snippet, stale: item.stale, status: item.status,
          ...(heading ? { heading, anchor: heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'), headingPath: item.headingPath } : {}) };
      });
      return { results: normalized, abstained: false, semantic: { used: true }, mode: settings.mode };
    } catch (error) { return fallback(error?.fallbackReason === 'remote-not-allowed' ? 'remote-not-allowed' : 'provider-error'); }
  });
  readTool('wiki_read_page', z.object({ path: z.string() }), async ({ path }) => {
    const { target } = await safeFile(path);
    const raw = await readFile(target, 'utf8');
    return { path: `wiki/${(await safeFile(path)).normalized}`, content: raw.slice(0, TOOL_LIMIT), truncated: raw.length > TOOL_LIMIT };
  });
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
    try { indexAgeMs = Math.max(0, Date.now() - (await stat(join(wikiDir, 'index.md'))).mtimeMs); } catch { /* index not initialized */ }
    const entries = await wiki.getWikiStatus(vaultDir);
    return { pageCount: pages.length, okfWarningCount: findings.filter((item) => item.severity === 'warn').length,
      okfErrorCount: findings.filter((item) => item.severity === 'error').length, indexAgeMs,
      readOnly: config.readOnly === true, indexCoveragePct: entries.index_coverage_pct };
  });
  readTool('wiki_lint', z.object({}), () => wiki.lintWiki(wikiDir));

  if (config.readOnly !== true) {
    tool('wiki_write_page', z.object({ path: z.string(), content: z.string() }), async ({ path, content }) => {
      const { normalized, target } = await safeFile(path, { allowIndex: false });
      checkWrite(`wiki/${normalized}`, content);
      const parsed = core.parseFrontmatter(content);
      if (parsed.errors.length) throw mcpError('E_INVALID_INPUT', 'Page frontmatter is invalid.');
      await wiki.writePage(target, { frontmatter: parsed.data, body: parsed.body });
      await logAndRefresh('write-page', `wiki/${normalized}`);
      return { path: `wiki/${normalized}`, written: true };
    });
    tool('wiki_update_page', z.object({ path: z.string(), content: z.string().optional(), patch: z.record(z.string(), z.unknown()).optional() }), async ({ path, content, patch }) => {
      const { normalized, target } = await safeFile(path, { allowIndex: false });
      const old = await wiki.readPage(target);
      let next;
      if (content !== undefined) {
        const parsed = core.parseFrontmatter(content);
        if (parsed.errors.length) throw mcpError('E_INVALID_INPUT', 'Page frontmatter is invalid.');
        next = { frontmatter: parsed.data, body: parsed.body };
      } else if (patch) {
        next = { frontmatter: { ...old.frontmatter, ...(patch.frontmatter && typeof patch.frontmatter === 'object' ? patch.frontmatter : {}) }, body: typeof patch.body === 'string' ? patch.body : old.body + (typeof patch.append === 'string' ? patch.append : '') };
      } else throw mcpError('E_INVALID_INPUT', 'content or patch is required.');
      const output = serializePage(next);
      checkWrite(`wiki/${normalized}`, output);
      await wiki.writePage(target, next);
      await logAndRefresh('update-page', `wiki/${normalized}`);
      return { path: `wiki/${normalized}`, updated: true };
    });
    const create = (name, content, kind) => async () => {
      const slug = wiki.slugify(name);
      const rel = `${kind}/${slug}.md`;
      const title = name;
      const frontmatter = { type: kind === 'entities' ? 'entity' : 'concept', title, tags: [], created: new Date().toISOString() };
      checkWrite(`wiki/${rel}`, serializePage({ frontmatter, body: content }));
      const { target } = await safeFile(rel, { allowIndex: false });
      const indexTarget = (await safeFile('index.md')).target;
      try { await stat(target); throw mcpError('E_ALREADY_EXISTS', 'The destination page already exists.'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const entries = await wiki.readIndex(indexTarget);
      entries.push({ path: rel, title, summary: '', category: kind === 'entities' ? 'Entities' : 'Concepts', tags: [] });
      checkWrite('wiki/index.md', serializeIndex(entries));
      const result = kind === 'entities' ? await wiki.createEntityPage(wikiDir, name, content) : await wiki.createConceptPage(wikiDir, name, content);
      await logAndRefresh(kind === 'entities' ? 'create-entity' : 'create-concept', `wiki/${rel}`);
      return { path: `wiki/${result.path}`, created: true };
    };
    tool('wiki_create_entity', z.object({ name: z.string().min(1), content: z.string() }), ({ name, content }) => create(name, content, 'entities')());
    tool('wiki_create_concept', z.object({ name: z.string().min(1), content: z.string() }), ({ name, content }) => create(name, content, 'concepts')());
    tool('wiki_add_crosslinks', z.object({ path: z.string() }), async ({ path }) => {
      const { normalized, target } = await safeFile(path, { allowIndex: false });
      const page = await wiki.readPage(target);
      const normalizedTargets = wiki.getPageLinksDetailed(page.body).map(({ target: link }) => {
        const rel = posix.normalize(posix.join(posix.dirname(normalized), link));
        if (!rel || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) throw mcpError('E_PATH_ESCAPE', 'Crosslink path is outside the Wiki.');
        return rel;
      });
      for (const rel of normalizedTargets) await safeFile(rel, { allowIndex: false });
      const links = [];
      for (const rel of normalizedTargets) {
        const targetPage = await wiki.readPage((await safeFile(rel, { allowIndex: false })).target);
        const title = typeof targetPage.frontmatter.title === 'string' ? targetPage.frontmatter.title : rel.split('/').at(-1).replace(/\.md$/, '');
        if (core.scanText(title).length) throw mcpError('E_SECRET_DETECTED', 'write refused: secret-like content detected');
        links.push(`- [${wiki.escapeMarkdownLinkText(title)}](${posix.relative(posix.dirname(normalized), rel)})`);
      }
      const resultBody = `${page.body}\n\n## See also\n${links.join('\n')}`;
      checkWrite(`wiki/${normalized}`, serializePage({ frontmatter: page.frontmatter, body: resultBody }));
      await wiki.addCrosslinks(wikiDir, normalized, normalizedTargets);
      await logAndRefresh('add-crosslinks', `wiki/${normalized}`);
      return { path: `wiki/${normalized}`, linked: normalizedTargets.length };
    });
    tool('wiki_update_index', z.object({}), async () => {
      const pages = (await wiki.listPages(wikiDir)).filter((file) => !['index.md', 'log.md'].includes(file.split(sep).at(-1)));
      const entries = [];
      for (const file of pages) {
        const page = await wiki.readPage(file);
        const path = relative(wikiDir, file).split(sep).join('/');
        entries.push({ path, title: typeof page.frontmatter.title === 'string' ? page.frontmatter.title : path, summary: '', category: path.split('/')[0], tags: Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags : [] });
      }
      checkWrite('wiki/index.md', serializeIndex(entries));
      const { target } = await safeFile('index.md');
      await wiki.writeIndex(target, entries);
      await logAndRefresh('update-index', 'wiki/index.md');
      return { indexed: entries.length };
    });
  }
  return server;
}

/** @returns {Promise<void>} */
export async function main() {
  const env = process.env;
  const paths = core.resolvePaths({ env, platform: env.BRAINATLAS_PLATFORM || process.platform });
  if (env.BRAINATLAS_CONFIG) paths.configFile = resolve(env.BRAINATLAS_CONFIG);
  const config = await core.loadConfig({ paths, env });
  const server = createServer({ config, paths, env });
  await server.connect(new StdioServerTransport());
}
