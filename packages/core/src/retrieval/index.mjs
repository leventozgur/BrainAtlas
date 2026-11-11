// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { atomicWriteFileSync } from '../util/index.mjs';

const weights = [4, 3, 2, 1];
const stops = new Set('the a an and or of to in for on is are with how what which when where who why does do will this that bir ve veya ile icin nasil nedir ne hangi bu su de da mi mu'.split(' '));
function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
export function normalizeText(s) {
  if (typeof s !== 'string') fail('E_INVALID_INPUT', 'Expected text');
  return s.replace(/[ıİ]/g, 'i').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}
export function stem(token) {
  let t = normalizeText(token);
  if (t.endsWith('ies') && t.length - 3 >= 4) return t.slice(0, -3) + 'y';
  const suffixes = ['lari', 'leri', 'nin', 'nın', 'dan', 'den', 'tan', 'ten', 'lar', 'ler', 'ing', 'im', 'si', 'ya', 'ye', 'in', 'un', 'da', 'de', 'ta', 'te', 'ma', 'me', 'ed', 'es', 's', 'i', 'u', 'a', 'e'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (t.endsWith(suffix) && t.length - suffix.length >= 4) {
        t = t.slice(0, -suffix.length); changed = true; break;
      }
    }
  }
  return t;
}
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split('/').includes('..');
}
function tokens(text, query = false) {
  return (normalizeText(text).match(/[\p{L}\p{N}]+/gu) || []).filter(t => !query || !stops.has(t)).map(stem);
}
// Identifier tokens (E_WIDGET_TIMEOUT, a1b2c3d, rc.12, src/lib/retry.mjs, --drain-timeout, RouteSnapshotCache) are kept
// whole, unsplit and unstemmed, in a separate exact index. Candidates are runs of letters, digits and `_ . / -`, with
// leading and trailing `_ . / -` removed. Dates, plain numbers, `v2`-style tokens and ordinary hyphenated words are not
// identifiers, so they never trigger the exact rules.
const identifierCandidate = /[\p{L}\p{N}_./-]+/gu;
const identifierEdge = /^[._/-]+|[._/-]+$/gu;
// A purely numeric three-part token with one 4-digit year at either end is a date (DD.MM.YYYY, MM/DD/YYYY, YYYY.MM.DD),
// not a version: the two other parts must be a day (1-31) and a month (1-12) in either order.
function isDateLike(t) {
  const parts = t.split(/[./-]/u);
  if (parts.length !== 3 || !parts.every(p => /^\d+$/u.test(p))) return false;
  const yearAtEnd = parts[2].length === 4, yearAtStart = parts[0].length === 4;
  if (!(yearAtEnd || yearAtStart) || (yearAtEnd && yearAtStart)) return false;
  const [a, b] = yearAtEnd ? [parts[0], parts[1]] : [parts[1], parts[2]];
  const x = Number(a), y = Number(b);
  return (x >= 1 && x <= 31 && y >= 1 && y <= 12) || (x >= 1 && x <= 12 && y >= 1 && y <= 31);
}
function isIdentifier(raw) {
  const t = raw.replace(identifierEdge, '');
  if (isDateLike(t)) return false;                                       // 11.11.2025, 2026.11.11, 11/11/2025
  if (/^\d+(?:\.\d+){2,}$/u.test(t)) return true;                       // 1.2.3
  if (!/\p{L}/u.test(t)) return false;                                   // 2026, 2026-11-11
  if (t.includes('_')) return true;                                      // E_WIDGET_TIMEOUT
  if (/\p{N}/u.test(t) && t.length >= 4) return true;                    // a1b2c3d, ADR-009, ipv6 (v2 is too short)
  if ((raw.match(/\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/gu) || []).length >= 2) return true; // RouteSnapshotCache, URLSessionConfiguration (SwiftUI, iOS are not)
  if (/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(t) && !t.split('.').every(p => p.length === 1)) return true; // rc.12, widget.mjs; not i.e, e.g, a.k.a
  if (/^[^/]+(?:\/[^/]+)+$/u.test(t) && (t.includes('.') || t.split('/').length > 2)) return true; // src/lib/retry, and/or excluded
  if (raw.startsWith('--')) return true;                                 // --drain-timeout
  if (/^[\p{Lu}\p{N}]+(?:-[\p{Lu}\p{N}]+)+$/u.test(t) && /\p{Lu}/u.test(t)) return true; // ERR-BASIL
  return false;
}
// A document identifier also yields its contiguous sub-chains of segments, so `URLSessionConfiguration` finds
// `URLSessionConfiguration.timeoutIntervalForRequest`, `rc.12` finds `2.4.0-rc.12`, and `retry.mjs` finds `src/lib/retry.mjs`.
// Queries use only the whole identifier.
const maxChainSegments = 12;
// Deep keys (more than maxChainSegments segments) start chains only in their last four `/` path components. Each such
// component is taken whole, however many `.` and `-` segments it contains, so a hyphenated basename is covered at any
// depth. A key without `/` is a single component and keeps the last four segments.
function deepChainStarts(pieces, segments) {
  const slashesBefore = [];
  let slashes = 0;
  for (const piece of pieces) {
    if (/^[./-]/.test(piece)) slashes += piece.split('/').length - 1;
    else slashesBefore.push(slashes);
  }
  if (!slashes) return [segments - 4, segments - 3, segments - 2, segments - 1];
  const starts = [];
  for (let s = 0; s < segments; s++) if (slashesBefore[s] >= slashes - 3) starts.push(s);
  return starts;
}
/** Normalized identifier keys of a document text, including the sub-chains described above. */
function identifierKeys(text, keys = new Set()) {
  for (const m of text.matchAll(identifierCandidate)) {
    if (!isIdentifier(m[0])) continue;
    const key = normalizeText(m[0].replace(identifierEdge, ''));
    keys.add(key);
    const pieces = key.match(/[^./-]+|[./-]+/g) || [];
    const segments = Math.ceil(pieces.length / 2);
    if (segments < 2) continue;
    // Short identifiers get every contiguous chain. Deep paths get chains that start in their last four path components,
    // so the basename and its suffixes are always indexed whatever the depth.
    const starts = segments <= maxChainSegments ? Array.from({ length: segments }, (_, k) => k) : deepChainStarts(pieces, segments);
    for (const first of starts) {
      for (let last = first; last < segments; last++) {
        const chain = pieces.slice(2 * first, 2 * last + 1).join('');
        if (chain.length >= 2) keys.add(chain);
      }
    }
  }
  return keys;
}
/** Identifier keys of a query, and the query text with identifiers blanked out (for counting the remaining words). */
function queryIdentifiers(text) {
  const keys = new Set(); let rest = ''; let last = 0;
  for (const m of text.matchAll(identifierCandidate)) {
    rest += text.slice(last, m.index);
    last = m.index + m[0].length;
    if (isIdentifier(m[0])) { keys.add(normalizeText(m[0].replace(identifierEdge, ''))); rest += ' '; }
    else rest += m[0];
  }
  return {keys, rest: rest + text.slice(last)};
}
// An identifier-only query abstains when none of its identifiers occurs in the vault and identifiers make up at least
// this share of its (identifier + remaining content word) units. Tuned on the dev identifier set only.
const IDENTIFIER_ABSTAIN_SHARE = 0.2;
function strings(x) { return Array.isArray(x) ? x.filter(v => typeof v === 'string') : typeof x === 'string' ? [x] : []; }
function dateValue(x) { return x instanceof Date ? x.toISOString().slice(0, 10) : x; }
function canonical(x) {
  if (x instanceof Date) return dateValue(x);
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k,v]) => [k, canonical(v)]));
  return x;
}
/** Regular Markdown files under the vault, in loadPages order; symlinks are never followed. Reads no file contents. */
function markdownFiles(vaultDir) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(full);
    }
  }
  let root;
  try { root = fs.realpathSync(vaultDir); if (!fs.statSync(root).isDirectory()) throw new Error(); walk(root); }
  catch { fail('E_VAULT_MISSING', 'Vault unavailable'); }
  return { root, files };
}
/** Load only regular Markdown files; symlinks are never followed. */
export function loadPages(vaultDir) {
  const { root, files } = markdownFiles(vaultDir);
  return files.map(full => {
    const raw = fs.readFileSync(full, 'utf8');
    const match = raw.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    let frontmatter = {};
    if (match) { try { const obj = parse(match[1], { schema: 'yaml-1.1' }); if (obj && typeof obj === 'object' && !Array.isArray(obj)) frontmatter = canonical(obj); } catch { fail('E_INVALID_INPUT', 'Invalid frontmatter'); } }
    const body = match ? raw.slice(match[0].length) : raw;
    const headings = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim());
    return { path: path.relative(root, full).split(path.sep).join('/'), title: typeof frontmatter.title === 'string' ? frontmatter.title : (headings[0] || path.basename(full, path.extname(full))), aliases: strings(frontmatter.aliases), keywords: strings(frontmatter.keywords), headings, body, frontmatter };
  });
}
function isSupersededPage(p) {
  const fm = p.frontmatter || {};
  return String(fm.status || '').toLowerCase() === 'superseded' || Object.hasOwn(fm, 'superseded_by');
}
function successorOf(p) {
  const value = (p.frontmatter || {}).superseded_by;
  return typeof value === 'string' ? value : null;
}
// The indexed page that a superseded_by chain ends at, or null when the chain loops, leaves the walked pages, or ends at
// a page that is not indexed. A chain A -> B -> C routes both A and B to C.
function finalTarget(start, indexed, byPath) {
  const seen = new Set();
  let current = start;
  while (typeof current === 'string') {
    if (indexed.has(current)) return current;
    if (seen.has(current) || !byPath.has(current)) return null;
    seen.add(current);
    current = successorOf(byPath.get(current));
  }
  return null;
}
/**
 * Superseded routing (BA-04), computed at index time from the walked pages: a Map from each indexed replacement page to
 * the sorted paths of the superseded pages that resolve to it. Superseded pages themselves stay out of the index.
 * Ranking is not affected: no text is added to any indexed page.
 */
function resolveSupersession(pages) {
  const indexed = new Set(), byPath = new Map();
  for (const p of pages) {
    if (!p || typeof p.path !== 'string' || !safePath(p.path)) continue;
    if (isSupersededPage(p)) { if (!byPath.has(p.path)) byPath.set(p.path, p); }
    else indexed.add(p.path);
  }
  const replaced = new Map();
  for (const source of byPath.keys()) {
    const target = finalTarget(successorOf(byPath.get(source)), indexed, byPath);
    if (target === null) continue;
    if (!replaced.has(target)) replaced.set(target, []);
    replaced.get(target).push(source);
  }
  for (const sources of replaced.values()) sources.sort();
  return replaced;
}
// Page links (BA-08). Wikilinks `[[name]]`, `[[name|label]]`, `[[name#section]]` and relative Markdown links
// `[text](dir/page.md#anchor)` become undirected edges between indexed pages. Fenced code, inline code, external URLs,
// links to non-Markdown files and links that leave the vault are ignored. A wikilink name resolves to the one indexed
// page whose exact path matches it, otherwise to the one page whose path suffix, file name, title or alias matches
// (case and diacritics folded); an ambiguous or unknown name links nothing. Superseded pages are never indexed, so links
// to them are skipped.
const LINK_TOP = 3, LINK_ALPHA = 0.5, RELATED_MAX = 5;
const wikiLinkPattern = /(?<!!)\[\[([^\]\n]+)\]\]/gu;
const markdownLinkPattern = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/gu;
const externalOrAbsolute = /^(?:[a-z][a-z0-9+.-]*:|[/\\#])/iu;
/** The body with fenced and inline code removed, line structure kept. */
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
/** Undirected link graph over the indexed documents: a plain object from document id to sorted neighbour ids. */
function buildLinks(docs) {
  const byPath = new Map(), byName = new Map();
  const add = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  docs.forEach((doc, id) => {
    const full = normalizeText(doc.page.path.replace(/\.md$/iu, ''));
    add(byPath, full, id);
    const segments = full.split('/');
    for (let k = 0; k < segments.length; k++) add(byName, segments.slice(k).join('/'), id);
    add(byName, normalizeText(doc.page.title), id);
    for (const alias of doc.page.aliases) add(byName, normalizeText(alias), id);
  });
  const only = (set) => (set && set.size === 1 ? [...set][0] : null);
  const edges = new Map();
  const connect = (a, b) => {
    if (a === b) return;
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from).add(to);
    }
  };
  docs.forEach((doc, id) => {
    const text = withoutCode(typeof doc.page.body === 'string' ? doc.page.body : '');
    for (const m of text.matchAll(wikiLinkPattern)) {
      const name = normalizeText(m[1].split('|')[0].split('#')[0].trim()).replace(/\.md$/u, '').trim();
      const target = name ? (only(byPath.get(name)) ?? only(byName.get(name))) : null;
      if (target !== null && target !== undefined) connect(id, target);
    }
    for (const m of text.matchAll(markdownLinkPattern)) {
      const href = m[1];
      if (externalOrAbsolute.test(href)) continue;
      let target;
      try { target = decodeURI(href.split(/[?#]/u)[0]); } catch { continue; }
      if (!/\.md$/iu.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(doc.page.path), target));
      if (resolved === '.' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) continue;
      const hit = only(byPath.get(normalizeText(resolved.replace(/\.md$/iu, ''))));
      if (hit !== null && hit !== undefined) connect(id, hit);
    }
  });
  const links = {};
  for (const id of [...edges.keys()].sort((x, y) => x - y)) links[id] = [...edges.get(id)].sort((x, y) => x - y);
  return links;
}
export function buildIndex(pages, options = {}) {
  if (!Array.isArray(pages)) fail('E_INVALID_INPUT', 'Expected pages');
  const docs = []; const postings = Object.create(null); const exact = Object.create(null); const totals = [0,0,0,0];
  const replaced = resolveSupersession(pages);
  for (const p of pages) {
    if (!p || typeof p.path !== 'string' || typeof p.title !== 'string') fail('E_INVALID_INPUT', 'Invalid page');
    if (!safePath(p.path)) continue;
    if (isSupersededPage(p)) continue;
    const fields = [p.title, [...strings(p.aliases), ...strings(p.keywords)].join(' '), strings(p.headings).join(' '), typeof p.body === 'string' ? p.body : ''];
    const lengths = []; const counts = new Map(); const identifiers = new Set();
    fields.forEach((field, i) => { const ts = tokens(field); lengths.push(ts.length); totals[i] += ts.length; for (const t of ts) { if (!counts.has(t)) counts.set(t, [0,0,0,0]); counts.get(t)[i]++; } identifierKeys(field, identifiers); });
    const id = docs.length; docs.push({page: p, lengths});
    for (const [term, countsByField] of counts) (postings[term] ||= []).push([id, countsByField]);
    for (const key of identifiers) (exact[key] ||= []).push(id);
  }
  const supersedes = Object.create(null);
  for (const target of [...replaced.keys()].sort()) supersedes[target] = replaced.get(target);
  return { version: 1, docs, postings, exact, averages: totals.map(t => t / (docs.length || 1)), now: (options.now || new Date()).toISOString(), supersedes, links: buildLinks(docs) };
}
function stale(fm, asOf) {
  let expiry = dateValue(fm.stale_after); if (!expiry) return false;
  if (typeof expiry === 'string' && /^P\d+[DW]$/.test(expiry)) {
    const base = new Date(dateValue(fm.generated)); if (!Number.isFinite(base.getTime())) return false;
    const n = Number(expiry.slice(1,-1)) * (expiry.endsWith('W') ? 7 : 1); expiry = new Date(base.getTime() + n * 86400000);
  }
  const time = new Date(expiry).getTime(); return Number.isFinite(time) && time < asOf.getTime();
}
// A heading's date: the first ISO `YYYY-MM-DD` (optionally `THH:MMZ`) or `DD.MM.YYYY`, as UTC milliseconds; null when absent or invalid.
function headingTime(title) {
  const iso = title.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})Z)?(?!\d)/u);
  const dmy = iso ? null : title.match(/(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/u);
  const m = iso || dmy;
  if (!m) return null;
  const [y, mo, d] = iso ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[3]), Number(m[2]), Number(m[1])];
  const hh = iso && m[4] !== undefined ? Number(m[4]) : 0, mm = iso && m[5] !== undefined ? Number(m[5]) : 0;
  const time = Date.UTC(y, mo - 1, d, hh, mm);
  const check = new Date(time);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || hh > 23 || mm > 59) return null;
  return time;
}
// "Current state", "Güncel durum" or "Current" in the heading marks the section as the present state of its topic.
const currentMarker = /\bcurrent\b|\bguncel durum\b/u;
// Sections are deliberately derived at query time, after the ranking is final.
// Date-aware choice (BA-04): among sections whose term score reaches DATED_SECTION_SHARE of the best score, a section
// whose heading is "current" wins, then the newest dated heading not after asOf, then the higher score, then the earlier
// section. Dates after asOf are not yet in force and are not preferred. Without such a candidate, the best score wins
// as before, so pages without dated or current headings are unaffected.
const DATED_SECTION_SHARE = 0.6;
function bestSection(body, terms, index, asOf) {
  const lines = body.split('\n'), sections = [], ancestors = [], used = new Set();
  let current = null, fenceLength = 0, fenceChar = null;
  for (const [lineNumber, rawLine] of lines.entries()) {
    let line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (lineNumber === 0 && line.startsWith('\uFEFF')) line = line.slice(1);
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (!fenceLength) { fenceLength = fence[1].length; fenceChar = fence[1][0]; }
      else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength && !fence[2].trim()) { fenceLength = 0; fenceChar = null; }
      if (current) current.lines.push(rawLine);
      continue;
    }
    const heading = !fenceLength && line.match(/^(#{1,3})[\t ]+(.+)$/);
    if (!heading) { if (current) current.lines.push(rawLine); continue; }
    const level = heading[1].length, title = heading[2].trim();
    ancestors.length = level - 1; ancestors[level - 1] = title;
    const base = /[\p{L}\p{N}]/u.test(title) ? normalizeText(title).replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-') : 'section';
    let anchor = base, suffix = 0;
    while (used.has(anchor)) anchor = `${base}-${++suffix}`;
    used.add(anchor);
    current = {heading:title, anchor, headingPath:ancestors.filter(Boolean).join(' > '), headingLine:rawLine, lines:[], time:headingTime(title), isCurrent:currentMarker.test(normalizeText(title))};
    sections.push(current);
  }
  let best = null, bestScore = 0;
  const scored = [];
  for (const [position, section] of sections.entries()) {
    const text = section.lines.join('\n').trim();
    const found = new Set(tokens(text));
    let score = 0;
    for (const term of terms) if (found.has(term)) {
      const count = Object.hasOwn(index.postings, term) ? index.postings[term].length : 0;
      score += Math.log(1 + (index.docs.length - count + 0.5) / (count + 0.5));
    }
    if (score > 0) scored.push({section, score, position});
    if (score > bestScore) { bestScore = score; best = {...section, text:[section.headingLine, ...section.lines].join('\n').trim()}; }
  }
  const asOfTime = asOf ? asOf.getTime() : Infinity;
  const eligible = scored.filter(({section, score}) => score >= DATED_SECTION_SHARE * bestScore
    && (section.isCurrent || section.time !== null) && (section.time === null || section.time <= asOfTime));
  if (!eligible.length) return best;
  const newer = (a, b) => (a.section.isCurrent !== b.section.isCurrent ? Number(a.section.isCurrent) > Number(b.section.isCurrent)
    : (a.section.time ?? -Infinity) !== (b.section.time ?? -Infinity) ? (a.section.time ?? -Infinity) > (b.section.time ?? -Infinity)
    : a.score !== b.score ? a.score > b.score : a.position < b.position);
  const chosen = eligible.reduce((top, candidate) => (newer(candidate, top) ? candidate : top));
  return {...chosen.section, text:[chosen.section.headingLine, ...chosen.section.lines].join('\n').trim()};
}
// The first `length` UTF-16 units of `text`, except that a surrogate pair is never split: when the cut falls between a
// high and a low surrogate, the high one is dropped too, so the result never ends with a lone surrogate.
function prefixKeepingPairs(text, length) {
  let end = Math.max(0, Math.min(length, text.length));
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end--;
  return text.slice(0, end);
}
const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;
/** Non-string queries raise E_QUERY_INVALID; queries without terms abstain. */
export function search(index, query, options = {}) {
  if (!index || index.version !== 1 || !Array.isArray(index.docs) || !index.postings || !index.exact || !Array.isArray(index.averages)) fail('E_INDEX_CORRUPT', 'Invalid index');
  if (typeof query !== 'string') fail('E_QUERY_INVALID', 'Expected query');
  const terms = [...new Set(tokens(query, true))];
  const limit = options.limit ?? 5, budget = options.budgetChars ?? Infinity, threshold = options.abstainThreshold ?? 0;
  const asOf = options.asOf ?? new Date(index.now);
  if (!Number.isInteger(limit) || limit < 0 || !(budget >= 0) || !(threshold >= 0 && threshold <= 1) || !(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) fail('E_INVALID_INPUT', 'Invalid search options');
  if (!terms.length) return {results: [], abstained: true, reason: 'empty-query', truncated: false};
  const {keys: identifiers, rest} = queryIdentifiers(query);
  const identifierLists = [...identifiers].map(key => Object.hasOwn(index.exact, key) ? index.exact[key] : []);
  if (identifierLists.length && identifierLists.every(list => !list.length)) {
    const share = identifiers.size / (identifiers.size + new Set(tokens(rest, true)).size);
    if (share >= IDENTIFIER_ABSTAIN_SHARE) return {results: [], abstained: true, reason: 'identifier-not-found', truncated: false};
  }
  const scores = new Map(); let maxScore = 0;
  for (const term of terms) {
    const list = Object.hasOwn(index.postings, term) ? index.postings[term] : []; const idf = Math.log(1 + (index.docs.length - list.length + 0.5) / (list.length + 0.5));
    maxScore += idf * 2.5;
    for (const [id, counts] of list) {
      if (!safePath(index.docs[id]?.page?.path)) continue;
      let tf = 0; for (let i=0;i<4;i++) tf += weights[i] * counts[i] / (0.25 + 0.75 * index.docs[id].lengths[i] / (index.averages[i] || 1));
      scores.set(id, (scores.get(id) || 0) + idf * 2.5 * tf / (1.5 + tf));
    }
  }
  // Each identifier is one more query term. A document that contains it exactly gets its full weight; a missing one
  // still lowers the score through maxScore, like any unmatched term.
  for (const list of identifierLists) {
    const idf = Math.log(1 + (index.docs.length - list.length + 0.5) / (list.length + 0.5));
    maxScore += idf * 2.5;
    for (const id of list) scores.set(id, (scores.get(id) || 0) + idf * 2.5);
  }
  // Compress low scores while retaining the penalty for every unmatched query term.
  // The transform is monotonic, so it leaves ranking and tie-breaking intact.
  const ranked = [...scores].map(([id, score]) => ({id, score: Math.sqrt(score / (maxScore || 1))})).sort(rankOrder(index.docs));
  // Abstention is decided on the lexical ranking only: link expansion below never turns an unanswered query into an answer.
  if (!ranked.length || ranked[0].score < threshold) return { results: [], abstained: true, reason: ranked.length ? 'below_threshold' : 'no_match', truncated: false };
  const linked = expandByLinks(ranked, index);
  let remaining = Math.floor(budget), truncated = false;
  const results = linked.slice(0,limit).map(({id,score,via}) => {
    const p = index.docs[id].page, fm = p.frontmatter || {};
    const section = bestSection(p.body || '', terms, index, asOf);
    let snippet = section ? section.text : (p.body || '').trim();
    if (snippet.length > remaining) { truncated = true; snippet = remaining > 0 ? prefixKeepingPairs(snippet, remaining - 1) + '…' : ''; }
    remaining -= snippet.length;
    const result = {path:p.path, title:p.title, score, snippet, stale:stale(fm,asOf), status:typeof fm.status === 'string' ? fm.status : null, heading:section?.heading ?? null, anchor:section?.anchor ?? null, headingPath:section?.headingPath ?? null};
    // Optional (BA-04): the superseded pages this page replaces. Present only when there are some.
    const replaced = index.supersedes?.[p.path];
    if (replaced?.length) result.supersedes = [...replaced];
    // Optional (BA-08): direct link neighbours (both directions, at most RELATED_MAX), and `via` for results that were
    // placed or scored by a link. Both are absent otherwise, so pages without links keep the previous result shape.
    const related = relatedPaths(index, id);
    if (related.length) result.related = related;
    if (via) result.via = via;
    return result;
  });
  return {results, abstained:false, reason:null, truncated};
}
/** Ranking order: higher score first, then path ascending. */
function rankOrder(docs) {
  return (a, b) => b.score - a.score || (docs[a.id].page.path < docs[b.id].page.path ? -1 : docs[a.id].page.path > docs[b.id].page.path ? 1 : 0);
}
/**
 * Graph expansion (BA-08). Each direct neighbour of the top LINK_TOP lexical results gets LINK_ALPHA times its source's
 * score. A neighbour that is already ranked keeps the larger of its own score and that value; a new one is added with
 * `via: 'link'`, as is a neighbour whose link value exceeds its own score. The first result cannot change: every link
 * value is below the best lexical score, so ties and ordering among lexical results stay as they were. No links, no change.
 */
function expandByLinks(ranked, index) {
  const links = index.links || {};
  const boosted = new Map();
  for (const source of ranked.slice(0, LINK_TOP)) {
    const value = LINK_ALPHA * source.score;
    for (const neighbour of links[source.id] || []) if (value > (boosted.get(neighbour) ?? -Infinity)) boosted.set(neighbour, value);
  }
  if (!boosted.size) return ranked;
  const merged = new Map(ranked.map(entry => [entry.id, {...entry}]));
  for (const [id, value] of boosted) {
    const current = merged.get(id);
    if (!current) merged.set(id, {id, score: value, via: 'link'});
    else if (value > current.score) Object.assign(current, {score: value, via: 'link'});
  }
  return [...merged.values()].sort(rankOrder(index.docs));
}
function relatedPaths(index, id) {
  const neighbours = (index.links || {})[id] || [];
  return neighbours.map(n => index.docs[n].page.path).sort().slice(0, RELATED_MAX);
}
// Cheap freshness fingerprint: lstat metadata of the same file set loadPages reads; no file contents are read.
// The tag stays `v6`: BA-17 acceptance tests pin it. The BA-04 cache change (the `supersedes` map) and the BA-08 link graph
// (`links`) are detected by decodeCachedIndex, which rejects any cache without them, so an older cache is rebuilt once.
const FINGERPRINT_SCHEMA = 'retrieval-stat-v6';
function statFingerprint(vaultDir) {
  const { root, files } = markdownFiles(vaultDir);
  const fingerprint = createHash('sha256').update(FINGERPRINT_SCHEMA);
  const paths = new Set();
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    paths.add(rel);
    let token;
    try { const st = fs.lstatSync(full); token = [st.size, st.mtimeMs, st.ctimeMs, st.ino].join('\0'); }
    catch { token = 'unstable'; } // Removed between walk and stat: never equal to a stored key, so the next check rebuilds.
    fingerprint.update(`${rel}\0${token}\n`);
  }
  return { key: fingerprint.digest('hex'), paths };
}
// On-disk postings are flat per term: [id, c0, c1, c2, c3, id, ...]. Decoding restores the in-memory nested shape
// that buildIndex produces, so search results and scores are unchanged. Every field is checked before use.
function flattenPostings(index) {
  const postings = Object.create(null);
  for (const term of Object.keys(index.postings)) {
    const flat = [];
    for (const [id, counts] of index.postings[term]) flat.push(id, counts[0], counts[1], counts[2], counts[3]);
    postings[term] = flat;
  }
  return {...index, postings};
}
// Structural checks on a cache whose key already matches the current stat fingerprint. Any violation returns null,
// and the caller rebuilds from the vault. Checks: pages exist on disk (paths is the walked file set) and are unique;
// page fields have the types search() reads; posting doc ids are strictly increasing and in range; counts are
// non-negative safe integers no larger than the field length they count; averages equal the value buildIndex computes.
const isCount = (x) => Number.isSafeInteger(x) && x >= 0;
const isStringArray = (x) => Array.isArray(x) && x.every(v => typeof v === 'string');
const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
// Structural checks on a cache whose key already matches the current stat fingerprint. Any violation returns null,
// and the caller rebuilds from the vault. The cache records every walked page as either indexed (docs) or skipped
// (superseded or otherwise not indexed); the two lists must partition the walked file set exactly. Page fields
// must have the types search() reads, posting doc ids are strictly increasing and in range, counts are
// non-negative safe integers no larger than the field length they count, and averages equal buildIndex's value.
// Page contents are not re-read: this is structural validation, not content verification (see the threat model in
// docs/contracts/retrieval.md).
function decodeCachedIndex(data, key, paths) {
  if (!isPlainObject(data) || data.key !== key) return null;
  const index = data.index, skipped = data.skipped;
  if (!isPlainObject(index) || index.version !== 1 || !Array.isArray(index.docs) || !isPlainObject(index.postings) || !Array.isArray(index.averages) || !isStringArray(skipped)) return null;
  const docs = index.docs, docCount = docs.length, seen = new Set();
  for (const doc of docs) {
    const page = doc?.page;
    if (!isPlainObject(doc) || !isPlainObject(page) || typeof page.path !== 'string' || !safePath(page.path) || !paths.has(page.path) || seen.has(page.path)) return null;
    seen.add(page.path);
    if (typeof page.title !== 'string' || typeof page.body !== 'string') return null;
    if (!isStringArray(page.headings) || !isStringArray(page.aliases) || !isStringArray(page.keywords)) return null;
    if (!isPlainObject(page.frontmatter)) return null;
    const fm = page.frontmatter;
    if (String(fm.status || '').toLowerCase() === 'superseded' || Object.hasOwn(fm, 'superseded_by')) return null;
    if (!Array.isArray(doc.lengths) || doc.lengths.length !== 4 || !doc.lengths.every(isCount)) return null;
  }
  for (const p of skipped) {
    if (!safePath(p) || !paths.has(p) || seen.has(p)) return null;
    seen.add(p);
  }
  if (seen.size !== paths.size) return null;
  const totals = [0, 0, 0, 0];
  for (const doc of docs) for (let i = 0; i < 4; i++) totals[i] += doc.lengths[i];
  if (index.averages.length !== 4 || !index.averages.every((avg, i) => avg === totals[i] / (docCount || 1))) return null;
  const postings = Object.create(null);
  for (const term of Object.keys(index.postings)) {
    const flat = index.postings[term];
    if (!Array.isArray(flat) || flat.length === 0 || flat.length % 5 !== 0) return null;
    const list = new Array(flat.length / 5);
    let previous = -1;
    for (let i = 0, j = 0; i < flat.length; i += 5, j++) {
      const id = flat[i];
      if (!Number.isInteger(id) || id <= previous || id >= docCount) return null;
      previous = id;
      const lengths = docs[id].lengths, counts = [flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]];
      for (let k = 0; k < 4; k++) if (!isCount(counts[k]) || counts[k] > lengths[k]) return null;
      list[j] = [id, counts];
    }
    postings[term] = list;
  }
  // Exact identifier postings: non-empty lists of strictly increasing, in-range document ids.
  if (!isPlainObject(index.exact)) return null;
  const exact = Object.create(null);
  for (const key of Object.keys(index.exact)) {
    const list = index.exact[key];
    if (!Array.isArray(list) || list.length === 0) return null;
    let previous = -1;
    for (const id of list) {
      if (!Number.isInteger(id) || id <= previous || id >= docCount) return null;
      previous = id;
    }
    exact[key] = list;
  }
  // Superseded routing (BA-04): each target is an indexed page, each non-empty sorted list holds skipped pages only.
  // A cache written before BA-04 has no `supersedes` and is rejected here, so it is rebuilt once.
  if (!isPlainObject(index.supersedes)) return null;
  const skippedSet = new Set(skipped), indexedPaths = new Set(docs.map(doc => doc.page.path)), supersedes = Object.create(null);
  for (const target of Object.keys(index.supersedes)) {
    const sources = index.supersedes[target];
    if (!indexedPaths.has(target) || !Array.isArray(sources) || sources.length === 0) return null;
    let previous = null;
    for (const source of sources) {
      if (typeof source !== 'string' || !skippedSet.has(source) || (previous !== null && source <= previous)) return null;
      previous = source;
    }
    supersedes[target] = sources;
  }
  // Link graph (BA-08): a cache without `links` (written before BA-08) is rejected and rebuilt once. Keys are document ids,
  // each neighbour list is a non-empty, strictly increasing list of other in-range ids, and every edge is symmetric.
  if (!isPlainObject(index.links)) return null;
  const links = Object.create(null);
  for (const key of Object.keys(index.links)) {
    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= docCount) return null;
    const id = Number(key), list = index.links[key];
    if (!Array.isArray(list) || list.length === 0) return null;
    let previous = -1;
    for (const n of list) {
      if (!Number.isInteger(n) || n <= previous || n >= docCount || n === id) return null;
      previous = n;
    }
    links[id] = list;
  }
  for (const key of Object.keys(links)) for (const n of links[key]) if (!links[n] || !links[n].includes(Number(key))) return null;
  return {version: 1, docs, postings, exact, averages: index.averages, now: index.now, supersedes, links};
}
/**
 * Searcher over a vault. `refreshIfChanged()` re-checks the stat fingerprint and rebuilds only when it changed.
 * `snapshot()` returns pages and lexical index that describe the same vault state.
 */
export function createSearcher(options) {
  const {vaultDir, stateDir, now, atomicWriter = atomicWriteFileSync} = options || {};
  if (typeof vaultDir !== 'string' || typeof stateDir !== 'string') fail('E_INVALID_INPUT', 'Expected vault and state directories');
  const cache = path.join(stateDir, 'retrieval-index.json');
  // pages is null when the index came from the cache; snapshot() then loads them on demand.
  let state = null;
  function rebuild({key, paths}) {
    try {
      const index = decodeCachedIndex(JSON.parse(fs.readFileSync(cache, 'utf8')), key, paths);
      if (index) { index.now = (now || new Date()).toISOString(); state = {key, index, pages: null}; return; }
    }
    catch { /* Rebuild malformed or missing cache. */ }
    const pages = loadPages(vaultDir);
    const index = buildIndex(pages, {now});
    state = {key, index, pages};
    const indexed = new Set(index.docs.map(d => d.page.path));
    const skipped = pages.map(p => p.path).filter(p => !indexed.has(p));
    try {
      fs.mkdirSync(stateDir, {recursive:true});
      atomicWriter(cache, JSON.stringify({key, index: flattenPostings(index), skipped}));
    } catch { /* Search still works without a writable cache. */ }
  }
  // Loads pages for a cache-hit state. They must describe the same vault state as the index: if the vault changed
  // while they were read, pages and index are rebuilt together from that one read, under the pre-read key.
  function loadPagesForSnapshot() {
    const before = statFingerprint(vaultDir);
    if (before.key !== state.key) rebuild(before);
    if (state.pages) return;
    const key = state.key, pages = loadPages(vaultDir);
    if (statFingerprint(vaultDir).key === key) { state.pages = pages; return; }
    state = {key: before.key, index: buildIndex(pages, {now}), pages};
  }
  rebuild(statFingerprint(vaultDir));
  return {
    search: (q,opts) => search(state.index,q,opts),
    refresh: async () => { rebuild(statFingerprint(vaultDir)); },
    refreshIfChanged() {
      const current = statFingerprint(vaultDir);
      if (current.key === state.key) return false;
      rebuild(current);
      return true;
    },
    snapshot() {
      if (state.pages === null) loadPagesForSnapshot();
      return {pages: state.pages, index: state.index};
    },
  };
}
