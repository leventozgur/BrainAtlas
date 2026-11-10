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
  const docs = []; const postings = Object.create(null); const totals = [0,0,0,0];
  for (const p of pages) {
    if (!p || typeof p.path !== 'string' || typeof p.title !== 'string') fail('E_INVALID_INPUT', 'Invalid page');
    if (!safePath(p.path)) continue;
    const fm = p.frontmatter || {};
    if (String(fm.status || '').toLowerCase() === 'superseded' || Object.hasOwn(fm, 'superseded_by')) continue;
    const fields = [p.title, [...strings(p.aliases), ...strings(p.keywords)].join(' '), strings(p.headings).join(' '), typeof p.body === 'string' ? p.body : ''];
    const lengths = []; const counts = new Map();
    fields.forEach((field, i) => { const ts = tokens(field); lengths.push(ts.length); totals[i] += ts.length; for (const t of ts) { if (!counts.has(t)) counts.set(t, [0,0,0,0]); counts.get(t)[i]++; } });
    const id = docs.length; docs.push({page: p, lengths});
    for (const [term, countsByField] of counts) (postings[term] ||= []).push([id, countsByField]);
  }
  return { version: 1, docs, postings, averages: totals.map(t => t / (docs.length || 1)), now: (options.now || new Date()).toISOString() };
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
  if (!index || index.version !== 1 || !Array.isArray(index.docs) || !index.postings || !Array.isArray(index.averages)) fail('E_INDEX_CORRUPT', 'Invalid index');
  if (typeof query !== 'string') fail('E_QUERY_INVALID', 'Expected query');
  const terms = [...new Set(tokens(query, true))];
  const limit = options.limit ?? 5, budget = options.budgetChars ?? Infinity, threshold = options.abstainThreshold ?? 0;
  const asOf = options.asOf ?? new Date(index.now);
  if (!Number.isInteger(limit) || limit < 0 || !(budget >= 0) || !(threshold >= 0 && threshold <= 1) || !(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) fail('E_INVALID_INPUT', 'Invalid search options');
  if (!terms.length) return {results: [], abstained: true, reason: 'empty-query', truncated: false};
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
const FINGERPRINT_SCHEMA = 'retrieval-stat-v4';
function statFingerprint(vaultDir) {
  const { root, files } = markdownFiles(vaultDir);
  const fingerprint = createHash('sha256').update(FINGERPRINT_SCHEMA);
  for (const full of files) {
    let token;
    try { const st = fs.lstatSync(full); token = [st.size, st.mtimeMs, st.ctimeMs, st.ino].join('\0'); }
    catch { token = 'unstable'; } // Removed between walk and stat: never equal to a stored key, so the next check rebuilds.
    fingerprint.update(`${path.relative(root, full).split(path.sep).join('/')}\0${token}\n`);
  }
  return fingerprint.digest('hex');
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
function decodeCachedIndex(data, key) {
  if (!data || data.key !== key) return null;
  const index = data.index;
  if (!index || index.version !== 1 || !Array.isArray(index.docs) || !index.postings || typeof index.postings !== 'object' || !Array.isArray(index.averages)) return null;
  if (!index.docs.every(d => d && d.page && safePath(d.page.path) && typeof d.page.title === 'string' && Array.isArray(d.lengths) && d.lengths.length === 4 && d.lengths.every(Number.isFinite))) return null;
  if (index.averages.length !== 4 || !index.averages.every(Number.isFinite)) return null;
  const docCount = index.docs.length, postings = Object.create(null);
  for (const term of Object.keys(index.postings)) {
    const flat = index.postings[term];
    if (!Array.isArray(flat) || flat.length % 5 !== 0) return null;
    const list = new Array(flat.length / 5);
    for (let i = 0, j = 0; i < flat.length; i += 5, j++) {
      const id = flat[i];
      if (!Number.isInteger(id) || id < 0 || id >= docCount || !Number.isFinite(flat[i + 1]) || !Number.isFinite(flat[i + 2]) || !Number.isFinite(flat[i + 3]) || !Number.isFinite(flat[i + 4])) return null;
      list[j] = [id, [flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]]];
    }
    postings[term] = list;
  }
  return {version: 1, docs: index.docs, postings, averages: index.averages, now: index.now};
}
/**
 * Searcher over a vault. `refreshIfChanged()` re-checks the stat fingerprint and rebuilds only when it changed.
 * `snapshot()` returns the pages and lexical index of the last refresh, for callers that need both.
 */
export function createSearcher(options) {
  const {vaultDir, stateDir, now, atomicWriter = atomicWriteFileSync} = options || {};
  if (typeof vaultDir !== 'string' || typeof stateDir !== 'string') fail('E_INVALID_INPUT', 'Expected vault and state directories');
  const cache = path.join(stateDir, 'retrieval-index.json');
  // pages is null when the index came from the cache; snapshot() then loads them on demand.
  let state = null;
  function rebuild(key) {
    try {
      const index = decodeCachedIndex(JSON.parse(fs.readFileSync(cache, 'utf8')), key);
      if (index) { index.now = (now || new Date()).toISOString(); state = {key, index, pages: null}; return; }
    }
    catch { /* Rebuild malformed or missing cache. */ }
    const pages = loadPages(vaultDir);
    const index = buildIndex(pages, {now});
    state = {key, index, pages};
    try {
      fs.mkdirSync(stateDir, {recursive:true});
      atomicWriter(cache, JSON.stringify({key, index: flattenPostings(index)}));
    } catch { /* Search still works without a writable cache. */ }
  }
  rebuild(statFingerprint(vaultDir));
  return {
    search: (q,opts) => search(state.index,q,opts),
    refresh: async () => { rebuild(statFingerprint(vaultDir)); },
    refreshIfChanged() {
      const key = statFingerprint(vaultDir);
      if (key === state.key) return false;
      rebuild(key);
      return true;
    },
    snapshot() {
      state.pages ??= loadPages(vaultDir);
      return {pages: state.pages, index: state.index};
    },
  };
}
