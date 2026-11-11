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
function isIdentifier(raw) {
  const t = raw.replace(identifierEdge, '');
  if (/^\d+(?:\.\d+){2,}$/u.test(t)) return true;                       // 1.2.3
  if (!/\p{L}/u.test(t)) return false;                                   // 2026, 2026-11-11
  if (t.includes('_')) return true;                                      // E_WIDGET_TIMEOUT
  if (/\p{N}/u.test(t) && t.length >= 4) return true;                    // a1b2c3d, ADR-009, ipv6 (v2 is too short)
  if ((raw.match(/\p{Ll}\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/gu) || []).length >= 2) return true; // RouteSnapshotCache, URLSessionConfiguration (SwiftUI, iOS are not)
  if (/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(t)) return true;                // rc.12, widget.mjs, settings.json
  if (/^[^/]+(?:\/[^/]+)+$/u.test(t) && (t.includes('.') || t.split('/').length > 2)) return true; // src/lib/retry, and/or excluded
  if (raw.startsWith('--')) return true;                                 // --drain-timeout
  if (/^[\p{Lu}\p{N}]+(?:-[\p{Lu}\p{N}]+)+$/u.test(t) && /\p{Lu}/u.test(t)) return true; // ERR-BASIL
  return false;
}
// A document identifier also yields its contiguous sub-chains of segments, so `URLSessionConfiguration` finds
// `URLSessionConfiguration.timeoutIntervalForRequest`, `rc.12` finds `2.4.0-rc.12`, and `retry.mjs` finds `src/lib/retry.mjs`.
// Queries use only the whole identifier.
const maxChainSegments = 12;
/** Normalized identifier keys of a document text, including the sub-chains described above. */
function identifierKeys(text, keys = new Set()) {
  for (const m of text.matchAll(identifierCandidate)) {
    if (!isIdentifier(m[0])) continue;
    const key = normalizeText(m[0].replace(identifierEdge, ''));
    keys.add(key);
    const pieces = key.match(/[^./-]+|[./-]+/g) || [];
    const segments = Math.ceil(pieces.length / 2);
    if (segments < 2 || segments > maxChainSegments) continue;
    for (let i = 0; i < pieces.length; i += 2) {
      for (let j = i; j < pieces.length; j += 2) {
        const chain = pieces.slice(i, j + 1).join('');
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
export function buildIndex(pages, options = {}) {
  if (!Array.isArray(pages)) fail('E_INVALID_INPUT', 'Expected pages');
  const docs = []; const postings = Object.create(null); const exact = Object.create(null); const totals = [0,0,0,0];
  for (const p of pages) {
    if (!p || typeof p.path !== 'string' || typeof p.title !== 'string') fail('E_INVALID_INPUT', 'Invalid page');
    if (!safePath(p.path)) continue;
    const fm = p.frontmatter || {};
    if (String(fm.status || '').toLowerCase() === 'superseded' || Object.hasOwn(fm, 'superseded_by')) continue;
    const fields = [p.title, [...strings(p.aliases), ...strings(p.keywords)].join(' '), strings(p.headings).join(' '), typeof p.body === 'string' ? p.body : ''];
    const lengths = []; const counts = new Map(); const identifiers = new Set();
    fields.forEach((field, i) => { const ts = tokens(field); lengths.push(ts.length); totals[i] += ts.length; for (const t of ts) { if (!counts.has(t)) counts.set(t, [0,0,0,0]); counts.get(t)[i]++; } identifierKeys(field, identifiers); });
    const id = docs.length; docs.push({page: p, lengths});
    for (const [term, countsByField] of counts) (postings[term] ||= []).push([id, countsByField]);
    for (const key of identifiers) (exact[key] ||= []).push(id);
  }
  return { version: 1, docs, postings, exact, averages: totals.map(t => t / (docs.length || 1)), now: (options.now || new Date()).toISOString() };
}
function stale(fm, asOf) {
  let expiry = dateValue(fm.stale_after); if (!expiry) return false;
  if (typeof expiry === 'string' && /^P\d+[DW]$/.test(expiry)) {
    const base = new Date(dateValue(fm.generated)); if (!Number.isFinite(base.getTime())) return false;
    const n = Number(expiry.slice(1,-1)) * (expiry.endsWith('W') ? 7 : 1); expiry = new Date(base.getTime() + n * 86400000);
  }
  const time = new Date(expiry).getTime(); return Number.isFinite(time) && time < asOf.getTime();
}
// Sections are deliberately derived at query time, after the ranking is final.
function bestSection(body, terms, index) {
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
    current = {heading:title, anchor, headingPath:ancestors.filter(Boolean).join(' > '), headingLine:rawLine, lines:[]};
    sections.push(current);
  }
  let best = null, bestScore = 0;
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    const found = new Set(tokens(text));
    let score = 0;
    for (const term of terms) if (found.has(term)) {
      const count = Object.hasOwn(index.postings, term) ? index.postings[term].length : 0;
      score += Math.log(1 + (index.docs.length - count + 0.5) / (count + 0.5));
    }
    if (score > bestScore) { bestScore = score; best = {...section, text:[section.headingLine, ...section.lines].join('\n').trim()}; }
  }
  return best;
}
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
  const ranked = [...scores].map(([id, score]) => ({id, score: Math.sqrt(score / (maxScore || 1))})).sort((a,b) => b.score - a.score || (index.docs[a.id].page.path < index.docs[b.id].page.path ? -1 : index.docs[a.id].page.path > index.docs[b.id].page.path ? 1 : 0));
  if (!ranked.length || ranked[0].score < threshold) return { results: [], abstained: true, reason: ranked.length ? 'below_threshold' : 'no_match', truncated: false };
  let remaining = Math.floor(budget), truncated = false;
  const results = ranked.slice(0,limit).map(({id,score}) => {
    const p = index.docs[id].page, fm = p.frontmatter || {};
    const section = bestSection(p.body || '', terms, index);
    let snippet = section ? section.text : (p.body || '').trim();
    if (snippet.length > remaining) { truncated = true; snippet = remaining > 0 ? snippet.slice(0, Math.max(0, remaining - 1)) + '…' : ''; }
    remaining -= snippet.length;
    return {path:p.path, title:p.title, score, snippet, stale:stale(fm,asOf), status:typeof fm.status === 'string' ? fm.status : null, heading:section?.heading ?? null, anchor:section?.anchor ?? null, headingPath:section?.headingPath ?? null};
  });
  return {results, abstained:false, reason:null, truncated};
}
// Cheap freshness fingerprint: lstat metadata of the same file set loadPages reads; no file contents are read.
const FINGERPRINT_SCHEMA = 'retrieval-stat-v5';
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
  return {version: 1, docs, postings, exact, averages: index.averages, now: index.now};
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
