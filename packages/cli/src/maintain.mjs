// SPDX-License-Identifier: MIT
// `brainatlas maintain`: read-only Wiki maintenance report. Nothing here writes to the vault.
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { checkPage, parseFrontmatter } from '@brainatlas/core';

export const KINDS = Object.freeze(['stale', 'superseded-broken', 'broken-link', 'orphan', 'index-missing', 'index-stale', 'oversized', 'update-sprawl']);
export const LIMITS = Object.freeze({ oversizedWords: 3000, updateSprawl: 6 });
const SKIP_ROOT = new Set(['wiki/index.md', 'wiki/log.md']);
// Same wikilink and Markdown link shapes as the retrieval link graph (packages/core/src/retrieval), copied because that
// module does not export its resolver.
const wikiLinkPattern = /(?<!!)\[\[([^\]\n]+)\]\]/gu;
const markdownLinkPattern = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/gu;
const externalOrAbsolute = /^(?:[a-z][a-z0-9+.-]*:|[/\\#])/iu;
const updateHeading = /^\s{0,3}#{1,6}\s+(?:update|güncelleme)\b[^\n]*$/iu;
const isoDate = /\d{4}-\d{2}-\d{2}/u;
const INDEX_CATEGORY_LINE = /^##\s+(.+)$/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;

const finding = (kind, path, detail) => ({ kind, path, detail });
const keyOf = (text) => String(text).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().trim();
const short = (value, limit = 120) => String(value).replace(/\s+/g, ' ').slice(0, limit);

/** Vault root as a real directory. Symlinked pages and directories are never followed below it. */
async function vaultRoot(vault) {
  let root;
  try { root = await realpath(resolve(vault)); } catch { throw Object.assign(new Error('Vault is missing or not a directory.'), { code: 'E_VAULT_MISSING' }); }
  const info = await stat(root).catch(() => null);
  if (!info || !info.isDirectory()) throw Object.assign(new Error('Vault is missing or not a directory.'), { code: 'E_VAULT_MISSING' });
  return root;
}

async function isRegularFile(root, rel) {
  try { const info = await lstat(join(root, rel)); return info.isFile() && !info.isSymbolicLink(); } catch { return false; }
}

async function readOptionalText(root, rel) {
  if (!(await isRegularFile(root, rel))) return null;
  const text = await readFile(join(root, rel), 'utf8');
  return text.length ? text : null;
}

/** Every Markdown file under wiki/, vault-relative, sorted. Symlinks are skipped; a symlinked wiki/ counts as absent. */
async function listWikiMarkdown(root) {
  const wiki = await lstat(join(root, 'wiki')).catch(() => null);
  if (!wiki || !wiki.isDirectory() || wiki.isSymbolicLink()) return [];
  const out = [];
  async function visit(rel) {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child);
    }
  }
  await visit('wiki');
  return out.sort();
}

/** The body with fenced and inline code removed, line structure kept (same rule as the retrieval link graph). */
function withoutCode(body) {
  let out = '', fenceLength = 0, fenceChar = null;
  for (const rawLine of body.split('\n')) {
    const fence = rawLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (!fenceLength) { fenceLength = fence[1].length; fenceChar = fence[1][0]; }
      else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength && !fence[2].trim()) { fenceLength = 0; fenceChar = null; }
      out += '\n';
      continue;
    }
    out += fenceLength ? '\n' : rawLine.replace(/`[^`\n]*`/gu, ' ') + '\n';
  }
  return out;
}

// ---- Index parsing: same rules as packages/mcp (CommonMark-style destinations, fences opaque, anchors and queries dropped).
function unescapeDestination(raw) { return raw.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'); }
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
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth === 0) break; depth--; }
  }
  if (i >= trimmed.length || i === start) return undefined;
  return unescapeDestination(trimmed.slice(start, i));
}
function indexLineInfo(line) {
  const trimmed = line.trim();
  const heading = trimmed.match(INDEX_CATEGORY_LINE);
  if (heading) return {};
  const destination = entryDestination(trimmed);
  if (destination === undefined) return {};
  if (externalOrAbsolute.test(destination)) return { external: true };
  const path = destination.replace(/[#?].*$/s, '');
  return path ? { entryPath: posix.normalize(path) } : {};
}
/** Entries of an index text: wiki-relative local targets (entries are relative to wiki/, as in the MCP coverage check). */
function indexEntries(content) {
  const entries = [];
  let fence = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const marker = trimmed.match(FENCE_OPEN);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && trimmed === marker[1]) fence = null;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && trimmed.slice(marker[1].length).includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    const info = indexLineInfo(line);
    if (info.entryPath !== undefined) entries.push(info.entryPath);
  }
  return entries;
}

/** Superseded-by and wikilink/Markdown link resolution against the scanned Wiki pages. */
function buildNameIndex(pagePaths, pages) {
  const byPath = new Map(), byName = new Map();
  const add = (map, key, path) => { if (!key) return; if (!map.has(key)) map.set(key, new Set()); map.get(key).add(path); };
  for (const path of pagePaths) {
    const full = keyOf(path.slice('wiki/'.length).replace(/\.md$/iu, ''));
    add(byPath, full, path);
    const segments = full.split('/');
    for (let k = 0; k < segments.length; k++) add(byName, segments.slice(k).join('/'), path);
    const data = pages.get(path).data;
    if (typeof data.title === 'string') add(byName, keyOf(data.title), path);
    if (Array.isArray(data.aliases)) for (const alias of data.aliases) if (typeof alias === 'string') add(byName, keyOf(alias), path);
  }
  return { byPath, byName };
}
function resolveWikiName(index, name) {
  const pathHits = index.byPath.get(name);
  if (pathHits && pathHits.size === 1) return { target: [...pathHits][0] };
  const nameHits = index.byName.get(name);
  if (!nameHits || nameHits.size === 0) return null;
  if (nameHits.size > 1) return { ambiguous: true };
  return { target: [...nameHits][0] };
}

/**
 * Read-only maintenance scan of the Wiki under `vault`. Returns findings `{kind, path, detail}` (detail holds only counts,
 * paths, field names or short link targets, never page bodies), counts per kind, the number of content pages scanned
 * (wiki/index.md and wiki/log.md excluded) and the duration. Nothing is written.
 */
export async function runMaintenance(vault, { now = new Date() } = {}) {
  const started = Date.now();
  const root = await vaultRoot(vault);
  const pagePaths = await listWikiMarkdown(root);
  const pages = new Map();
  for (const path of pagePaths) {
    const raw = await readFile(join(root, path), 'utf8');
    const parsed = parseFrontmatter(raw);
    pages.set(path, { path, raw, data: parsed.data, body: parsed.body, errors: parsed.errors });
  }
  const content = pagePaths.filter(path => !SKIP_ROOT.has(path));
  const findings = [];
  const add = (kind, path, detail) => findings.push(finding(kind, path, detail));

  // stale: reuse the OKF page check and keep only its expiry rule.
  for (const page of content.map(path => pages.get(path))) {
    for (const item of checkPage({ path: page.path, data: page.data, raw: page.raw, errors: page.errors }, { asOf: now })) {
      if (item.rule === 'stale.expired') add('stale', page.path, `stale_after ${short(page.data.stale_after, 40)} has passed`);
    }
  }

  // superseded-broken: missing target, a target that is itself superseded, or a superseded_by loop.
  const supersededNext = (page) => {
    if (page.data.status !== 'superseded' || typeof page.data.superseded_by !== 'string') return null;
    return pages.get(page.data.superseded_by) ?? null;
  };
  for (const page of content.map(path => pages.get(path))) {
    if (page.data.status !== 'superseded') continue;
    const target = pages.get(page.data.superseded_by);
    if (typeof page.data.superseded_by !== 'string' || !target) {
      add('superseded-broken', page.path, 'superseded_by target is missing');
      continue;
    }
    const seen = new Set([page.path]);
    let cursor = supersededNext(page);
    let loops = false;
    while (cursor) {
      if (seen.has(cursor.path)) { loops = true; break; }
      seen.add(cursor.path);
      cursor = supersededNext(cursor);
    }
    if (loops) add('superseded-broken', page.path, 'superseded_by chain loops');
    else if (target.data.status === 'superseded') add('superseded-broken', page.path, 'superseded_by target is itself superseded');
  }

  // broken-link, and the inbound-link graph used for orphan detection.
  const names = buildNameIndex(pagePaths, pages);
  const inbound = new Set();
  for (const path of content) {
    const page = pages.get(path);
    const text = withoutCode(page.body);
    for (const match of text.matchAll(wikiLinkPattern)) {
      const name = keyOf(match[1].split('|')[0].split('#')[0]).replace(/\.md$/u, '').trim();
      if (!name) continue;
      const resolved = resolveWikiName(names, name);
      if (resolved === null) add('broken-link', path, `wikilink target not found: "${short(match[1].split('|')[0].split('#')[0].trim())}"`);
      else if (resolved.ambiguous) add('broken-link', path, `wikilink target is ambiguous: "${short(match[1].split('|')[0].split('#')[0].trim())}"`);
      else if (resolved.target !== path) inbound.add(resolved.target);
    }
    for (const match of text.matchAll(markdownLinkPattern)) {
      const href = match[1];
      if (externalOrAbsolute.test(href)) continue;
      let target;
      try { target = decodeURI(href.split(/[?#]/u)[0]); } catch { continue; }
      if (!/\.md$/iu.test(target)) continue;
      const resolvedPath = posix.normalize(posix.join(posix.dirname(path), target));
      // Links that leave the vault are ignored, not reported.
      if (resolvedPath === '.' || resolvedPath.startsWith('../') || posix.isAbsolute(resolvedPath)) continue;
      if (pages.has(resolvedPath)) { if (resolvedPath !== path) inbound.add(resolvedPath); continue; }
      if (await isRegularFile(root, resolvedPath)) continue;
      add('broken-link', path, `markdown target not found: ${short(resolvedPath)}`);
    }
  }
  for (const path of content) {
    const data = pages.get(path).data;
    if (data.status === 'superseded' && pages.has(data.superseded_by) && data.superseded_by !== path) inbound.add(data.superseded_by);
  }

  // index-missing / index-stale.
  const indexText = await readOptionalText(root, 'wiki/index.md');
  const indexed = new Set();
  if (indexText === null) {
    add('index-missing', 'wiki/index.md', `index absent; ${content.length} page(s) not listed`);
  } else {
    for (const entry of indexEntries(indexText)) indexed.add(entry);
    for (const entry of indexed) {
      if (!entry.endsWith('.md')) continue;
      const full = posix.normalize(posix.join('wiki', entry));
      if (pages.has(full)) continue;
      if (!full.startsWith('wiki/') && !full.startsWith('../') && await isRegularFile(root, full)) continue;
      add('index-stale', 'wiki/index.md', `entry target not found: ${short(entry)}`);
    }
    for (const path of content) {
      if (!indexed.has(path.slice('wiki/'.length))) add('index-missing', path, 'page is not listed in the index');
    }
  }

  // orphan: no inbound link from another page and not listed in the index.
  for (const path of content) {
    if (inbound.has(path)) continue;
    if (indexed.has(path.slice('wiki/'.length))) continue;
    add('orphan', path, 'no page links to it and it is not in the index');
  }

  // oversized and update-sprawl.
  for (const path of content) {
    const page = pages.get(path);
    const words = page.body.trim().split(/\s+/u).filter(Boolean).length;
    if (words > LIMITS.oversizedWords) add('oversized', path, `body has ${words} words (limit ${LIMITS.oversizedWords})`);
    const lines = withoutCode(page.body).split('\n');
    const dated = lines.filter(line => updateHeading.test(line) && isoDate.test(line)).length;
    if (dated >= LIMITS.updateSprawl) add('update-sprawl', path, `${dated} dated Update sections (threshold ${LIMITS.updateSprawl})`);
  }

  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)) || (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
  const counts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
  for (const item of findings) counts[item.kind]++;
  return { ok: true, findings, counts, pages: content.length, durationMs: Date.now() - started };
}

/** Human summary: counts per kind, then each finding grouped by kind. */
export function formatMaintenance(report) {
  const lines = [`BrainAtlas maintenance report (read-only): ${report.pages} pages, ${report.findings.length} findings, ${report.durationMs} ms`];
  if (!report.findings.length) lines.push('No findings.');
  for (const kind of KINDS) {
    const items = report.findings.filter(item => item.kind === kind);
    if (!items.length) continue;
    lines.push('', `${kind} (${items.length})`);
    for (const item of items) lines.push(`  ${item.path}: ${item.detail}`);
  }
  return lines.join('\n');
}

/** One review candidate per finding kind for the receipts queue: paths and counts only, never page content. */
export function receiptCandidates(findings) {
  return KINDS.flatMap(kind => {
    const items = findings.filter(item => item.kind === kind);
    if (!items.length) return [];
    return [{
      title: `Maintenance review: ${kind} (${items.length})`,
      summary: `${items.length} finding(s) of kind ${kind} from brainatlas maintain. Review the listed pages; no page content is included.`,
      sources: [...new Set(items.map(item => item.path))].slice(0, 20),
    }];
  });
}
