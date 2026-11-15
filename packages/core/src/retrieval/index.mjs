// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
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
export function tokens(text, query = false) {
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
// BA-29: exclusion globs relative to the search root. `**` crosses `/`, `*` and `?` do not, everything else is literal.
function globRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; }
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}
function excludeMatcher(exclude) {
  if (!exclude.length) return () => false;
  const patterns = exclude.map(globRegExp);
  return rel => patterns.some(pattern => pattern.test(rel));
}
/** Regular Markdown files under the vault, in loadPages order; symlinks are never followed. Reads no file contents. */
function markdownFiles(vaultDir) {
  const files = [];
  let root;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(full);
    }
  }
  try { root = fs.realpathSync(vaultDir); if (!fs.statSync(root).isDirectory()) throw new Error(); walk(root); }
  catch { fail('E_VAULT_MISSING', 'Vault unavailable'); }
  return { root, files };
}
const frontmatterPattern = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
/**
 * One page. Throws E_INVALID_INPUT exactly where loadPages always threw: a YAML error (including duplicate keys) or an
 * exception while converting the parsed frontmatter. Any other shape is kept as before: an opening `---` with no closing
 * line leaves frontmatter empty and the whole text as body, and a root that is not a mapping gives empty frontmatter.
 * loadPages keeps throwing (its contract is pinned by the acceptance tests); the searcher and maintenance skip exactly
 * these pages through loadPagesDetailed (BA-23).
 */
function readPage(root, full) {
  const raw = fs.readFileSync(full, 'utf8');
  const match = raw.match(frontmatterPattern);
  let frontmatter = {};
  if (match) {
    try {
      const doc = parseDocument(match[1], { schema: 'yaml-1.1' });
      if (doc.errors.length) throw doc.errors[0];
      const obj = doc.toJS();
      // BA-09: an unquoted YAML 1.1 timestamp is parsed to a Date that may have rolled over (2026-02-30 -> 2026-03-02).
      // The verified record's date is taken from the author's text instead, so trust sees the real calendar value.
      const verifiedNodes = isMap(doc.contents) ? doc.get('verified', true) : null;
      if (isSeq(verifiedNodes) && Array.isArray(obj?.verified)) verifiedNodes.items.forEach((item, i) => {
        const dateNode = isMap(item) ? item.get('date', true) : null;
        const record = obj.verified[i];
        if (isScalar(dateNode) && dateNode.type === 'PLAIN' && typeof dateNode.source === 'string' && record && typeof record === 'object' && !Array.isArray(record)) record.date = dateNode.source;
      });
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) frontmatter = canonical(obj);
    } catch (error) { if (error?.code === 'E_INVALID_INPUT') throw error; fail('E_INVALID_INPUT', 'Invalid frontmatter'); }
  }
  const body = match ? raw.slice(match[0].length) : raw;
  const headings = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim());
  return { path: path.relative(root, full).split(path.sep).join('/'), title: typeof frontmatter.title === 'string' ? frontmatter.title : (headings[0] || path.basename(full, path.extname(full))), aliases: strings(frontmatter.aliases), keywords: strings(frontmatter.keywords), headings, body, frontmatter };
}
/** Pages under the vault and, when `skipUnreadable`, the relative paths of pages whose frontmatter cannot be parsed. */
function readVault(vaultDir, skipUnreadable) {
  const { root, files } = markdownFiles(vaultDir);
  const pages = [], skipped = [];
  for (const full of files) {
    try { pages.push(readPage(root, full)); }
    catch (error) {
      if (!skipUnreadable || error?.code !== 'E_INVALID_INPUT') throw error;
      skipped.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return { pages, skipped };
}
/** Load only regular Markdown files; symlinks are never followed. Throws E_INVALID_INPUT on a page with unparseable frontmatter. */
export function loadPages(vaultDir) {
  return readVault(vaultDir, false).pages;
}
/**
 * Like loadPages, but a page whose frontmatter cannot be parsed is skipped (BA-23) instead of failing the whole load.
 * `skipped` lists the vault-relative paths of those pages; they are not in `pages`. Paths only, no content or error text.
 */
export function loadPagesDetailed(vaultDir) {
  return readVault(vaultDir, true);
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
    current = byPath.get(current).successor;
  }
  return null;
}
/**
 * Superseded routing (BA-04) from per-page records in walk order, `{path, superseded, successor}`, for every walked page with
 * a safe path. Returns a plain object from each indexed replacement path to the sorted paths of the superseded pages that
 * resolve to it. Superseded pages themselves stay out of the index, and ranking is not affected. BA-41: the incremental
 * update and the full build both use this function, and cache validation recomputes it.
 */
function supersessionOf(records) {
  const indexed = new Set(), byPath = new Map();
  for (const record of records) {
    if (record.superseded) { if (!byPath.has(record.path)) byPath.set(record.path, record); }
    else indexed.add(record.path);
  }
  const replaced = new Map();
  for (const source of byPath.keys()) {
    const target = finalTarget(byPath.get(source).successor, indexed, byPath);
    if (target === null) continue;
    if (!replaced.has(target)) replaced.set(target, []);
    replaced.get(target).push(source);
  }
  // Null-prototype, as in the cache decoder (BA-41): both paths must be deepStrictEqual.
  const supersedes = Object.create(null);
  for (const target of [...replaced.keys()].sort()) supersedes[target] = replaced.get(target).sort();
  return supersedes;
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
/**
 * Link references of one page, before resolution (BA-41): `{w: name}` for a wikilink, normalized the way buildLinks matches
 * names, and `{m: key}` for a relative Markdown link, normalized to the key of the page it names. The incremental update keeps
 * these references per file, so an unchanged body is not scanned again.
 */
function linkRefs(page) {
  const refs = [];
  const text = withoutCode(typeof page.body === 'string' ? page.body : '');
  for (const m of text.matchAll(wikiLinkPattern)) {
    const name = normalizeText(m[1].split('|')[0].split('#')[0].trim()).replace(/\.md$/u, '').trim();
    if (name) refs.push({w: name});
  }
  for (const m of text.matchAll(markdownLinkPattern)) {
    const href = m[1];
    if (externalOrAbsolute.test(href)) continue;
    let target;
    try { target = decodeURI(href.split(/[?#]/u)[0]); } catch { continue; }
    if (!/\.md$/iu.test(target)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page.path), target));
    if (resolved === '.' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) continue;
    refs.push({m: normalizeText(resolved.replace(/\.md$/iu, ''))});
  }
  return refs;
}
/** Undirected link graph over the indexed documents: a plain object from document id to sorted neighbour ids. `refs[id]` lists the references of document id (see linkRefs). */
function buildLinks(docs, refs) {
  // No references anywhere: no edges, whatever the names are, so the name maps are not built.
  if (refs.every(list => list.length === 0)) return {};
  // A key maps to the one document that has it, or to AMBIGUOUS when two or more documents have it (BA-41: no Set per key).
  const AMBIGUOUS = -1;
  const byPath = new Map(), byName = new Map();
  const add = (map, key, id) => {
    const current = map.get(key);
    if (current === undefined) map.set(key, id);
    else if (current !== id) map.set(key, AMBIGUOUS);
  };
  docs.forEach((doc, id) => {
    const full = normalizeText(doc.page.path.replace(/\.md$/iu, ''));
    add(byPath, full, id);
    const segments = full.split('/');
    for (let k = 0; k < segments.length; k++) add(byName, segments.slice(k).join('/'), id);
    add(byName, normalizeText(doc.page.title), id);
    for (const alias of doc.page.aliases) add(byName, normalizeText(alias), id);
  });
  const only = (found) => (found === undefined || found === AMBIGUOUS ? null : found);
  const edges = new Map();
  const connect = (a, b) => {
    if (a === b) return;
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from).add(to);
    }
  };
  docs.forEach((doc, id) => {
    for (const ref of refs[id]) {
      const target = ref.w !== undefined ? (only(byPath.get(ref.w)) ?? only(byName.get(ref.w))) : only(byPath.get(ref.m));
      if (target !== null && target !== undefined) connect(id, target);
    }
  });
  const links = {};
  for (const id of [...edges.keys()].sort((x, y) => x - y)) links[id] = [...edges.get(id)].sort((x, y) => x - y);
  return links;
}
// Provenance trust (BA-09). A page is `verified` when its status is `confirmed` and at least one `verified` record has a
// valid date and non-empty evidence, scope and source. It is `weak` when its status is `proposed` or `disputed`. Every
// other page is `neutral`: no provenance fields, a status outside these, or `confirmed` without a valid record.
// Trust is computed at index time. It scales the lexical score after the abstention decision (see search). Neutral
// pages keep the factor 1, so a corpus without provenance gets exactly the previous scores and order. The two constants
// were tuned on the BA-09 development set (eval/dev/trust-cases.json) only; they are not configuration keys.
const TRUST_BOOST = 0.5, TRUST_PENALTY = 0.1;
const trustFactor = {verified: 1 + TRUST_BOOST, weak: 1 - TRUST_PENALTY, neutral: 1};
const dateOnly = /^\d{4}-\d{2}-\d{2}$/u, utcStamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
// Quoted or unquoted (already canonical) UTC date or timestamp; an impossible calendar day such as 2026-02-30 is invalid.
function validDate(value) {
  const text = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : '') : value;
  if (typeof text !== 'string' || !(dateOnly.test(text) || utcStamp.test(text))) return false;
  const time = Date.parse(text);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text.slice(0, 10);
}
function validVerifiedRecord(record) {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record) && validDate(record.date)
    && ['evidence', 'scope', 'source'].every(key => typeof record[key] === 'string' && record[key].trim() !== '');
}
function trustOf(frontmatter) {
  const fm = frontmatter || {};
  if (fm.status === 'confirmed') return Array.isArray(fm.verified) && fm.verified.some(validVerifiedRecord) ? 'verified' : 'neutral';
  return fm.status === 'proposed' || fm.status === 'disputed' ? 'weak' : 'neutral';
}
// BA-26: a page with `sensitivity: personal` or `inject: never` is searchable as before, but the hook must never inject it.
// The class is stored per document (only when true, so other documents keep the previous cache shape) and checked on cache load.
function restrictedOf(frontmatter) {
  const fm = frontmatter || {};
  const sensitivity = typeof fm.sensitivity === 'string' ? fm.sensitivity.trim().toLowerCase() : '';
  const inject = typeof fm.inject === 'string' ? fm.inject.trim().toLowerCase() : '';
  return sensitivity === 'personal' || inject === 'never';
}
/** Tokens, term counts and identifiers of one page. `lengths` holds the token count of each field. */
function analyzePage(p) {
  const fields = [p.title, [...strings(p.aliases), ...strings(p.keywords)].join(' '), strings(p.headings).join(' '), typeof p.body === 'string' ? p.body : ''];
  const lengths = [], counts = new Map(), identifiers = new Set();
  fields.forEach((field, i) => {
    const ts = tokens(field);
    lengths.push(ts.length);
    for (const t of ts) { if (!counts.has(t)) counts.set(t, [0,0,0,0]); counts.get(t)[i]++; }
    identifierKeys(field, identifiers);
  });
  return {lengths, counts, identifiers};
}
/** The indexed document of a page. Flags are stored only when true, as before. */
function docEntry(p, lengths, excluded) {
  return {page: p, lengths, trust: trustOf(p.frontmatter), ...(restrictedOf(p.frontmatter) ? {restricted: true} : {}), ...(excluded(p.path) ? {excluded: true} : {})};
}
/** Merges two lists sorted by document id. The ids of the two lists are disjoint. */
function mergeById(a, b, idOf) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push(idOf(a[i]) < idOf(b[j]) ? a[i++] : b[j++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}
/**
 * Rebuilds one inverted map (postings or exact) for a new document numbering (BA-41). Each old list is remapped through
 * `oldToNew`, where a removed or replaced document maps to -1 and its entry is dropped. The additions of the changed
 * documents are merged in by id, so every list stays strictly increasing. A term left without documents is removed.
 * `remap` returns the entry itself when its id is unchanged, so a list that moves nowhere and gains nothing is shared with
 * the previous index as it is. Lists are never mutated, so sharing them between two index versions is safe.
 */
function mergeLists(oldLists, oldToNew, additions, remap, idOf) {
  const out = Object.create(null);
  for (const term of Object.keys(oldLists)) {
    const old = oldLists[term], extra = additions.get(term);
    additions.delete(term);
    if (!extra && old.every(entry => remap(entry, oldToNew) === entry)) { out[term] = old; continue; }
    const kept = [];
    for (const entry of old) { const mapped = remap(entry, oldToNew); if (mapped !== null) kept.push(mapped); }
    const list = extra ? mergeById(kept, extra, idOf) : kept;
    if (list.length) out[term] = list;
  }
  for (const [term, extra] of additions) out[term] = extra;
  return out;
}
export function buildIndex(pages, options = {}) {
  if (!Array.isArray(pages)) fail('E_INVALID_INPUT', 'Expected pages');
  const excluded = excludeMatcher(options.exclude ?? []);
  const docs = []; const postings = Object.create(null); const exact = Object.create(null); const totals = [0,0,0,0];
  const refs = []; const records = [];
  for (const p of pages) {
    if (!p || typeof p.path !== 'string' || typeof p.title !== 'string') fail('E_INVALID_INPUT', 'Invalid page');
    if (!safePath(p.path)) continue;
    records.push({path: p.path, superseded: isSupersededPage(p), successor: successorOf(p)});
    if (isSupersededPage(p)) continue;
    const {lengths, counts, identifiers} = analyzePage(p);
    lengths.forEach((n, i) => { totals[i] += n; });
    const id = docs.length;
    docs.push(docEntry(p, lengths, excluded));
    refs.push(linkRefs(p));
    for (const [term, countsByField] of counts) (postings[term] ||= []).push([id, countsByField]);
    for (const key of identifiers) (exact[key] ||= []).push(id);
  }
  return { version: 1, docs, postings, exact, averages: totals.map(t => t / (docs.length || 1)), now: (options.now || new Date()).toISOString(), supersedes: supersessionOf(records), links: buildLinks(docs, refs) };
}
export function stale(fm, asOf) {
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
export function bestSection(body, terms, index, asOf) {
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
export function prefixKeepingPairs(text, length) {
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
  const lexical = [...scores].map(([id, score]) => ({id, score: Math.sqrt(score / (maxScore || 1))}));
  // Abstention is decided on the best lexical score only, before trust and before link expansion: neither a weak page nor a
  // link can turn an unanswered query into an answer, and a weak page cannot turn an answer into an abstention.
  const best = lexical.reduce((top, entry) => Math.max(top, entry.score), -Infinity);
  if (!lexical.length || best < threshold) return { results: [], abstained: true, reason: lexical.length ? 'below_threshold' : 'no_match', truncated: false };
  // Trust (BA-09) scales each lexical score after that decision. Neutral pages keep factor 1, so their scores and order are unchanged.
  // BA-29: the abstention decision above uses the best score of every page, as before. Excluded pages are then removed from the
  // results only, so a query whose best match is excluded is not abstained on: it returns no results (abstained: false).
  const trusted = lexical.filter(entry => !index.docs[entry.id].excluded).map(entry => ({...entry, score: entry.score * (trustFactor[index.docs[entry.id].trust] ?? 1)})).sort(rankOrder(index.docs));
  if (!trusted.length) return {results: [], abstained: false, reason: null, truncated: false};
  const linked = expandByLinks(trusted, index);
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
    // Optional (BA-09): `verified` or `weak` for pages with provenance; absent for neutral pages.
    const trust = index.docs[id].trust;
    if (trust === 'verified' || trust === 'weak') result.trust = trust;
    // Optional (BA-26): `never` for restricted pages (sensitivity personal or inject never); absent otherwise.
    if (index.docs[id].restricted === true) result.inject = 'never';
    return result;
  });
  return {results, abstained:false, reason:null, truncated};
}
/** Ranking order: higher score first, then path ascending. */
function rankOrder(docs) {
  return (a, b) => b.score - a.score || (docs[a.id].page.path < docs[b.id].page.path ? -1 : docs[a.id].page.path > docs[b.id].page.path ? 1 : 0);
}
/**
 * Graph expansion (BA-08). Each direct neighbour of the top LINK_TOP results (trust-adjusted scores, BA-09) gets LINK_ALPHA
 * times its source's score times its own trust factor (BA-09). A neighbour that is already ranked keeps the larger of its own
 * score and that value; a new one is added with `via: 'link'`, as is a neighbour whose link value exceeds its own score. The
 * first result cannot change: a link value is at most LINK_ALPHA * 1.5 = 0.75 of its source score, and the source score is at
 * most the best adjusted score, so ties and ordering among ranked results stay as they were. No links, no change.
 */
function expandByLinks(ranked, index) {
  const links = index.links || {};
  const boosted = new Map();
  for (const source of ranked.slice(0, LINK_TOP)) {
    for (const neighbour of links[source.id] || []) {
      if (index.docs[neighbour].excluded) continue;
      // BA-09: the link value carries the neighbour's own trust factor, so a weak neighbour cannot escape its penalty by a link.
      const value = LINK_ALPHA * source.score * (trustFactor[index.docs[neighbour].trust] ?? 1);
      if (value > (boosted.get(neighbour) ?? -Infinity)) boosted.set(neighbour, value);
    }
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
  const neighbours = ((index.links || {})[id] || []).filter(n => !index.docs[n].excluded);
  return neighbours.map(n => index.docs[n].page.path).sort().slice(0, RELATED_MAX);
}
// BA-41: the searcher keeps a single cache file under stateDir, `retrieval-index.json`. Its `schema` tag changed (format 2),
// because it now also holds the per-file records that an incremental update needs (stat token, kind, successor) next to the
// index and its skipped list. Link references are not stored: they are re-derived from the cached page bodies in memory, so a
// record stays small and the cache does not duplicate the link text. A cache with a missing or different schema tag (format 1,
// written before BA-41) is rebuilt once; no separate records file is written.
const CACHE_SCHEMA = 'retrieval-index-v2';
// Cheap freshness fingerprint: lstat metadata of the same file set loadPages reads; no file contents are read.
// The tag stays `v6`: BA-17 acceptance tests pin it. A cache whose key differs from the current one is not accepted as a
// whole, but its per-file records are reused for the files whose stat tokens still match (see refreshTo).
const FINGERPRINT_SCHEMA = 'retrieval-stat-v6';
// BA-29: a non-empty exclusion list is part of the key, so a changed rule rebuilds the cache. An empty list adds nothing.
// Returns the key, the realpath root and the walked entries `{rel, full, token}` in walk order. The token is the lstat
// metadata of the file (BA-41: kept per file, so an unchanged file is not read again).
function statFingerprint(vaultDir, exclude = []) {
  const { root, files } = markdownFiles(vaultDir);
  const fingerprint = createHash('sha256').update(FINGERPRINT_SCHEMA);
  if (exclude.length) fingerprint.update(`\nexclude\0${JSON.stringify(exclude)}\n`);
  const entries = [];
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    let token;
    try { const st = fs.lstatSync(full); token = [st.size, st.mtimeMs, st.ctimeMs, st.ino].join('\0'); }
    catch { token = 'unstable'; } // Removed between walk and stat: never equal to a stored token, so the next check rebuilds.
    fingerprint.update(`${rel}\0${token}\n`);
    entries.push({rel, full, token});
  }
  return { key: fingerprint.digest('hex'), root, entries };
}
// The cache text is assembled from per-object fragments (BA-41): a document, or a postings or identifier list, that the
// incremental update shares with the previous index keeps its fragment, so a refresh serializes only what changed. The text is
// the JSON that JSON.stringify gives for `{key, index: <postings flattened per term>, skipped}`, the layout used before BA-41.
// On-disk postings are flat per term: [id, c0, c1, c2, c3, id, ...]. Decoding restores the in-memory nested shape
// that buildIndex produces, so search results and scores are unchanged. Every field is checked before use.
const fragments = new WeakMap();
function fragmentOf(object, render) {
  let text = fragments.get(object);
  if (text === undefined) { text = render(object); fragments.set(object, text); }
  return text;
}
const flatPostingText = (list) => JSON.stringify(list.flatMap(([id, counts]) => [id, counts[0], counts[1], counts[2], counts[3]]));
// On disk an indexed record is just `[token]`: its path is the document path at the same position, so it is not repeated.
// A page that is not indexed carries its path and kind (superseded also carries its `superseded_by` value). The token is
// stored compactly: the four NUL-separated stat values are written with `:` and an empty ctime field means "equal to mtime".
// decodeRecords expands it back, so the in-memory token and the fingerprint key keep their exact previous form.
function compactToken(token) {
  const [size, mtime, ctime, ino] = token.split('\0');
  return ctime === mtime ? `${size}:${mtime}::${ino}` : `${size}:${mtime}:${ctime}:${ino}`;
}
function expandToken(text) {
  const parts = text.split(':');
  if (parts.length !== 4) return text;
  const [size, mtime, ctime, ino] = parts;
  return [size, mtime, ctime === '' ? mtime : ctime, ino].join('\0');
}
const recordText = (rel, rec) => rec.kind === 'indexed'
  ? JSON.stringify([compactToken(rec.token)])
  : JSON.stringify(rec.kind === 'superseded' ? [rel, compactToken(rec.token), fileKindCode[rec.kind], rec.successor] : [rel, compactToken(rec.token), fileKindCode[rec.kind]]);
function cacheText(key, index, skipped, files) {
  const docs = index.docs.map(doc => fragmentOf(doc, JSON.stringify)).join(',');
  const postings = Object.keys(index.postings).map(term => `${JSON.stringify(term)}:${fragmentOf(index.postings[term], flatPostingText)}`).join(',');
  const exact = Object.keys(index.exact).map(identifier => `${JSON.stringify(identifier)}:${fragmentOf(index.exact[identifier], JSON.stringify)}`).join(',');
  const records = [...files].map(([rel, rec]) => recordText(rel, rec)).join(',');
  const body = `{"version":${JSON.stringify(index.version)},"docs":[${docs}],"postings":{${postings}},"exact":{${exact}},"averages":${JSON.stringify(index.averages)},"now":${JSON.stringify(index.now)},"supersedes":${JSON.stringify(index.supersedes)},"links":${JSON.stringify(index.links)}}`;
  return `{"schema":${JSON.stringify(CACHE_SCHEMA)},"key":${JSON.stringify(key)},"files":[${records}],"index":${body},"skipped":${JSON.stringify(skipped)}}`;
}
const isCount = (x) => Number.isSafeInteger(x) && x >= 0;
const isStringArray = (x) => Array.isArray(x) && x.every(v => typeof v === 'string');
const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const fileKinds = ['indexed', 'superseded', 'other', 'unreadable'];
const fileKindCode = Object.fromEntries(fileKinds.map((kind, code) => [kind, code]));
/**
 * Structural checks on a cache (the layout of BA-02 onwards, plus the BA-41 records). Any violation returns null, and the
 * caller rebuilds from the vault. `paths` is the walked file set when the cache describes the current vault (same key): the
 * documents and the skipped pages must then partition it exactly. The BA-41 records are checked against the index and the
 * skipped list by decodeRecords. Page contents are not re-read: this is structural validation, not content verification (see
 * the threat model in docs/contracts/retrieval.md).
 */
function decodeCache(data, exclude, paths) {
  if (!isPlainObject(data) || data.schema !== CACHE_SCHEMA || typeof data.key !== 'string' || !isStringArray(data.skipped) || !Array.isArray(data.files)) return null;
  const index = data.index, skipped = data.skipped;
  if (!isPlainObject(index) || index.version !== 1 || !Array.isArray(index.docs) || !isPlainObject(index.postings) || !Array.isArray(index.averages) || !isPlainObject(index.exact)) return null;
  const excluded = excludeMatcher(exclude);
  const docs = index.docs, docCount = docs.length, seen = new Set();
  for (const doc of docs) {
    const page = doc?.page;
    if (!isPlainObject(doc) || !isPlainObject(page) || typeof page.path !== 'string' || !safePath(page.path) || (paths && !paths.has(page.path)) || seen.has(page.path)) return null;
    seen.add(page.path);
    if (typeof page.title !== 'string' || typeof page.body !== 'string') return null;
    if (!isStringArray(page.headings) || !isStringArray(page.aliases) || !isStringArray(page.keywords)) return null;
    if (!isPlainObject(page.frontmatter)) return null;
    // Trust (BA-09) is stored per document and must equal the class its frontmatter gives; a cache without it is rebuilt once.
    if (doc.trust !== trustOf(page.frontmatter)) return null;
    // BA-26: the restriction flag must agree with the frontmatter; a missing or forged flag forces a rebuild.
    if (doc.restricted !== undefined && doc.restricted !== true) return null;
    if ((doc.restricted === true) !== restrictedOf(page.frontmatter)) return null;
    // BA-29: the excluded flag must agree with the exclusion rule that the cache was written with.
    if (doc.excluded !== undefined && doc.excluded !== true) return null;
    if ((doc.excluded === true) !== excluded(page.path)) return null;
    const fm = page.frontmatter;
    if (String(fm.status || '').toLowerCase() === 'superseded' || Object.hasOwn(fm, 'superseded_by')) return null;
    if (!Array.isArray(doc.lengths) || doc.lengths.length !== 4 || !doc.lengths.every(isCount)) return null;
  }
  for (const p of skipped) {
    if (!safePath(p) || (paths && !paths.has(p)) || seen.has(p)) return null;
    seen.add(p);
  }
  if (paths && seen.size !== paths.size) return null;
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
  // Link graph (BA-08): a plain object of in-range document ids; each neighbour list is non-empty, strictly increasing, in range,
  // never self-referential, and every edge is symmetric.
  if (!isPlainObject(index.links)) return null;
  // Plain object, matching buildLinks (BA-41): both paths must be deepStrictEqual.
  const links = {};
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
  const files = decodeRecords(data.files, skipped, docs, supersedes);
  if (!files) return null;
  return {key: data.key, skipped, files, index: {version: 1, docs, postings, exact, averages: index.averages, now: index.now, supersedes, links}};
}
/**
 * The per-file records of a cache (BA-41), validated against the index it belongs to: one record per walked file, the indexed
 * records are exactly the documents in order, the skipped list is the records that are not indexed (superseded or unsafe pages
 * first, then unreadable pages, each in walk order, as the index writes it), and the superseded routing equals the value
 * recomputed from the records. Returns the records as a Map from path (docId set for indexed records), or null.
 */
function decodeRecords(entries, skipped, docs, supersedes) {
  const files = new Map(), indexed = [], notIndexed = [], unreadable = [], records = [];
  let docIndex = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry)) return null;
    // Indexed record: only the stat token; the path is that of the next document, in document order.
    if (entry.length === 1) {
      if (typeof entry[0] !== 'string' || docIndex >= docs.length) return null;
      const rel = docs[docIndex].page.path;
      if (files.has(rel)) return null;
      files.set(rel, {token: expandToken(entry[0]), kind: 'indexed', successor: null, refs: null, docId: docIndex});
      indexed.push(rel);
      records.push({path: rel, superseded: false, successor: null});
      docIndex++;
      continue;
    }
    if (entry.length < 3 || entry.length > 4) return null;
    const [rel, token, code, successor] = entry;
    const kind = Number.isInteger(code) ? fileKinds[code] : undefined;
    if (typeof rel !== 'string' || typeof token !== 'string' || files.has(rel) || kind === undefined || kind === 'indexed') return null;
    // Only a superseded record carries its `superseded_by` value (a string or null); the other kinds have exactly three fields.
    if (kind === 'superseded' ? entry.length !== 4 || !(successor === null || typeof successor === 'string') : entry.length !== 3) return null;
    files.set(rel, {token: expandToken(token), kind, successor: kind === 'superseded' ? successor : null, refs: null, docId: -1});
    if (kind === 'unreadable') unreadable.push(rel);
    else notIndexed.push(rel);
    if (kind === 'superseded') records.push({path: rel, superseded: true, successor});
  }
  if (docIndex !== docs.length) return null;
  if (indexed.length !== docs.length) return null;
  for (let id = 0; id < docs.length; id++) {
    const docPath = docs[id].page.path;
    if (docPath !== indexed[id]) return null;
    files.get(docPath).docId = id;
  }
  const expected = notIndexed.concat(unreadable);
  if (expected.length !== skipped.length || expected.some((rel, i) => rel !== skipped[i])) return null;
  if (JSON.stringify(supersedes) !== JSON.stringify(supersessionOf(records))) return null;
  return files;
}
/** BA-29: whether a search-root-relative path is excluded by the rule (the hook also filters its semantic hits with it). */
export function isExcludedPath(relPath, exclude = []) { return excludeMatcher(exclude)(relPath); }
// BA-29: the default exclusions. At a wiki root only its own navigation and agent-policy files are left out; a vault root
// (no wiki directory, the legacy layout) also leaves out its planning, archive, inbox and raw folders. Nested files are not affected.
export const DEFAULT_EXCLUDE_WIKI = Object.freeze(['index.md', 'log.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
export const DEFAULT_EXCLUDE_VAULT = Object.freeze([...DEFAULT_EXCLUDE_WIKI, 'planning/**', 'archive/**', 'inbox/**', 'raw/**']);
/**
 * The search root and exclusion list shared by the hook and the MCP server (BA-29). The root is `<vault>/wiki` when that is a
 * directory whose real path lies inside the vault (a symlink that leaves the vault is not followed); otherwise the vault itself.
 * `prefix` is the root's vault-relative folder with a trailing `/` (`wiki/`), or '' for the vault root: the hook reports paths
 * vault-relative with it. `configured` is `retrieval.exclude`: absent (undefined) gives the default for the root kind, an array
 * replaces it, and an empty array restores the legacy scope with every page.
 * @param {string} vaultDir
 * @param {string[]} [configured]
 * @returns {{root: string, exclude: string[], prefix: string}}
 */
export function searchScope(vaultDir, configured) {
  const wiki = path.join(vaultDir, 'wiki');
  let wikiRoot = false;
  try {
    const vaultReal = fs.realpathSync(vaultDir), wikiReal = fs.realpathSync(wiki);
    wikiRoot = fs.statSync(wikiReal).isDirectory() && wikiReal.startsWith(vaultReal + path.sep);
  } catch { wikiRoot = false; }
  const fallback = wikiRoot ? DEFAULT_EXCLUDE_WIKI : DEFAULT_EXCLUDE_VAULT;
  return { root: wikiRoot ? wiki : vaultDir, exclude: [...(configured ?? fallback)], prefix: wikiRoot ? 'wiki/' : '' };
}
/**
 * Incremental update (BA-41). `base` is `{index, files}` for the last state, or null for a cold build. A walked file whose stat
 * token is unchanged keeps its record and its document; every other file is read and analysed again. Postings, exact lists,
 * averages, superseded routing and the link graph are then recomputed from those records in walk order, so the result equals
 * buildIndex over the same pages. Returns {index, files, skipped, pages}; `pages` lists every readable page when all of them
 * were read in this pass, and null otherwise.
 */
function update(base, walk, excluded, nowIso) {
  const oldFiles = base ? base.files : new Map();
  const oldDocs = base ? base.index.docs : [];
  const oldToNew = new Int32Array(oldDocs.length).fill(-1);
  const files = new Map(), docs = [], refs = [], adds = [], reads = [];
  let reused = 0;
  for (const {rel, full, token} of walk.entries) {
    const old = oldFiles.get(rel);
    if (old && old.token === token) {
      reused++;
      const rec = {token, kind: old.kind, successor: old.successor, refs: [], docId: -1};
      if (old.kind === 'indexed') {
        const pageRefs = old.refs ?? linkRefs(oldDocs[old.docId].page);
        rec.refs = pageRefs;
        rec.docId = docs.length;
        oldToNew[old.docId] = docs.length;
        docs.push(oldDocs[old.docId]);
        refs.push(pageRefs);
      }
      files.set(rel, rec);
      continue;
    }
    let page;
    try { page = readPage(walk.root, full); }
    catch (error) {
      if (error?.code !== 'E_INVALID_INPUT') throw error;
      files.set(rel, {token, kind: 'unreadable', successor: null, refs: [], docId: -1});
      continue;
    }
    reads.push(page);
    if (!safePath(rel)) { files.set(rel, {token, kind: 'other', successor: null, refs: [], docId: -1}); continue; }
    if (isSupersededPage(page)) { files.set(rel, {token, kind: 'superseded', successor: successorOf(page), refs: [], docId: -1}); continue; }
    const {lengths, counts, identifiers} = analyzePage(page);
    const id = docs.length, pageRefs = linkRefs(page);
    docs.push(docEntry(page, lengths, excluded));
    refs.push(pageRefs);
    adds.push({id, counts, identifiers});
    files.set(rel, {token, kind: 'indexed', successor: null, refs: pageRefs, docId: id});
  }
  const postingAdds = new Map(), exactAdds = new Map();
  for (const {id, counts, identifiers} of adds) {
    for (const [term, c] of counts) { if (!postingAdds.has(term)) postingAdds.set(term, []); postingAdds.get(term).push([id, c]); }
    for (const key of identifiers) { if (!exactAdds.has(key)) exactAdds.set(key, []); exactAdds.get(key).push(id); }
  }
  const postings = mergeLists(base ? base.index.postings : {}, oldToNew, postingAdds, (entry, map) => {
    const nid = map[entry[0]];
    return nid === entry[0] ? entry : nid < 0 ? null : [nid, entry[1]];
  }, entry => entry[0]);
  const exact = mergeLists(base ? base.index.exact : {}, oldToNew, exactAdds, (id, map) => {
    const nid = map[id];
    return nid === id ? id : nid < 0 ? null : nid;
  }, id => id);
  const totals = [0, 0, 0, 0];
  for (const doc of docs) for (let i = 0; i < 4; i++) totals[i] += doc.lengths[i];
  const records = [], skipped = [], unreadable = [];
  for (const [rel, rec] of files) {
    if (rec.kind === 'indexed' || rec.kind === 'superseded') records.push({path: rel, superseded: rec.kind === 'superseded', successor: rec.successor});
    if (rec.kind === 'superseded' || rec.kind === 'other') skipped.push(rel);
    else if (rec.kind === 'unreadable') unreadable.push(rel);
  }
  const index = {version: 1, docs, postings, exact, averages: totals.map(t => t / (docs.length || 1)), now: nowIso(), supersedes: supersessionOf(records), links: buildLinks(docs, refs)};
  return {index, files, skipped: skipped.concat(unreadable), pages: reused === 0 ? reads : null};
}
/**
 * Searcher over a vault. `refreshIfChanged()` re-checks the stat fingerprint and updates only the files whose stat token
 * changed (BA-41). `snapshot()` returns pages and lexical index that describe the same vault state.
 */
export function createSearcher(options) {
  const {vaultDir, stateDir, now, atomicWriter = atomicWriteFileSync, exclude} = options || {};
  if (typeof vaultDir !== 'string' || typeof stateDir !== 'string') fail('E_INVALID_INPUT', 'Expected vault and state directories');
  // BA-29: `exclude` lists glob patterns (relative to vaultDir) whose pages are never returned as results; they stay in the index and its statistics. Absent or empty: every page is returned.
  if (exclude !== undefined && (!Array.isArray(exclude) || exclude.some(p => typeof p !== 'string' || !p))) fail('E_INVALID_INPUT', 'Expected exclude patterns');
  const rules = exclude ?? [];
  const excluded = excludeMatcher(rules);
  const nowIso = () => (now || new Date()).toISOString();
  const fingerprintOf = () => statFingerprint(vaultDir, rules);
  const cache = path.join(stateDir, 'retrieval-index.json');
  // state: {key, index, skipped, files, pages}. `pages` is null when they must be loaded on demand (snapshot). `files` are the
  // per-file records, kept in memory so the next change is incremental. `key` is null only after a race in snapshot().
  let state = null;
  // The cache file, structurally checked. Its partition is checked against the walked files only when it describes this vault.
  function readCache(walk) {
    let data;
    try { data = JSON.parse(fs.readFileSync(cache, 'utf8')); }
    catch { return null; }
    if (!isPlainObject(data) || typeof data.key !== 'string') return null;
    const paths = data.key === walk.key ? new Set(walk.entries.map(entry => entry.rel)) : null;
    return decodeCache(data, rules, paths);
  }
  function persist(next) {
    try {
      fs.mkdirSync(stateDir, {recursive: true});
      atomicWriter(cache, cacheText(next.key, next.index, next.skipped, next.files));
    } catch { /* Search still works without a writable cache. */ }
  }
  // Brings the state to the walked vault. Nothing is written when the key is unchanged.
  function refreshTo(walk) {
    if (state && state.key === walk.key) return;
    let base = state;
    if (!base) {
      base = readCache(walk);
      // The cache on disk describes this vault: use it as it is, with the current clock.
      if (base && base.key === walk.key) {
        state = {key: walk.key, index: {...base.index, now: nowIso()}, skipped: base.skipped, files: base.files, pages: null};
        return;
      }
      // A key that differs although every walked file and stat token is the same cannot describe an edited vault: it was
      // written with another fingerprint schema tag or exclusion rule (or its key was forged). Its records are not reused.
      if (base && base.files.size === walk.entries.length && walk.entries.every(entry => base.files.get(entry.rel)?.token === entry.token)) base = null;
    }
    const next = update(base && base.files ? base : null, walk, excluded, nowIso);
    persist({key: walk.key, ...next});
    state = {key: walk.key, index: next.index, skipped: next.skipped, files: next.files, pages: next.pages};
  }
  // Loads pages for a state that came from the cache. They must describe the same vault state as the index: if the vault changed
  // while they were read, pages and index are rebuilt together from that one read, and the key is left unmatched.
  function loadPagesForSnapshot() {
    const before = fingerprintOf();
    if (before.key !== state.key) refreshTo(before);
    if (state.pages) return;
    const key = state.key, pages = loadPagesDetailed(vaultDir).pages;
    if (fingerprintOf().key === key) { state.pages = pages; return; }
    state = {key: null, index: buildIndex(pages, {now, exclude: rules}), skipped: [], files: null, pages};
  }
  refreshTo(fingerprintOf());
  return {
    search: (q,opts) => search(state.index,q,opts),
    refresh: async () => { refreshTo(fingerprintOf()); },
    refreshIfChanged() {
      const current = fingerprintOf();
      if (current.key === state.key) return false;
      refreshTo(current);
      return true;
    },
    snapshot() {
      if (state.pages === null) loadPagesForSnapshot();
      return {pages: state.pages, index: state.index};
    },
  };
}
