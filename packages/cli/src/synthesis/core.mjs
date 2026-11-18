// SPDX-License-Identifier: MIT
// BA-48 phase B1: the deterministic core of "current state" synthesis proposals. Target selection, input sanitising,
// output schema validation, the five blocking gates, the current-state block renderer and the proposal store live here.
// Pure helpers take `now`/`date` arguments; nothing in this module calls a model, writes a vault page or reads the clock.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicWriteFile, parseFrontmatter } from '@brainatlas/core';
import { listWikiMarkdown, vaultRoot, withoutCode } from '../maintain.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const asString = value => (typeof value === 'string' ? value : '');
const countWords = text => asString(text).trim().split(/\s+/u).filter(Boolean).length;

// Same dated-update rule as `maintain`: an `Update`/`Güncelleme` heading that contains an ISO date.
const UPDATE_HEADING = /^\s{0,3}#{1,6}\s+(?:update|güncelleme)\b[^\n]*$/iu;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/u;
const NEAR_DUPLICATE_THRESHOLD = 0.8;
const LEADING_BODY_WORDS = 200;
const SCORE_REASONS = Object.freeze(['oversized', 'update-sprawl', 'stale', 'orphan', 'near-duplicate']);

const EXCLUDED_PREFIXES = Object.freeze(['raw/', 'planning/', 'archive/', 'inbox/', 'wiki/archive/']);
const EXCLUDED_EXACT = Object.freeze(['wiki/index.md', 'wiki/log.md']);

const OPEN_MARKER = '<!-- brainatlas:current-state -->';
const CLOSE_MARKER = '<!-- /brainatlas:current-state -->';
const BLOCK_HEADING = /^##\s+Current state\b/u;

const RAW_CAVEAT_MARKERS = Object.freeze([
  'unverified', 'not verified', 'doğrulanmadı', 'disputed', 'uncertain', 'belirsiz', 'çelişkili', 'no go', 'blocked'
]);

// A token that gate G3 must find in an anchor quote: an ISO date, a version token, or a plain number. The alternatives
// are ordered so a date or a version is consumed as one token and its parts are not counted again as numbers.
const NUMBER_TOKEN = /\d{4}-\d{2}-\d{2}|v?\d+(?:\.\d+)+(?:-[A-Za-z0-9.]+)?|\d+/gu;

/** The caveat normalization shared by text and markers: NFC first, Turkish letters folded, dots removed, spaces and '-' collapsed. */
function normalizeCaveat(value) {
  return String(value)
    .normalize('NFC')
    .replaceAll('İ', 'i')
    .replaceAll('ı', 'i')
    .replace(/\u0307/gu, '')
    .replace(/[\s-]+/gu, ' ')
    .toLowerCase()
    .trim();
}

function normalizeCaveatTr(value) {
  return String(value).normalize('NFC').replace(/[\s-]+/gu, ' ').toLocaleLowerCase('tr').trim();
}

/** Caveat markers normalized the same way as the text they are searched in. */
const CAVEAT_MARKERS = Object.freeze(RAW_CAVEAT_MARKERS.map(normalizeCaveat));
const CAVEAT_MARKERS_TR = Object.freeze(RAW_CAVEAT_MARKERS.map(normalizeCaveatTr));

/** True when either locale normalization of `text` contains a marker normalized the same way. */
const hasCaveat = text => {
  const form = normalizeCaveat(text);
  const formTr = normalizeCaveatTr(text);
  return CAVEAT_MARKERS.some(marker => form.includes(marker)) || CAVEAT_MARKERS_TR.some(marker => formTr.includes(marker));
};

/** G3 tokens of a text or a quote, with one leading `v` stripped from versions so `v2.4.0` matches `2.4.0`. */
const g3Tokens = value => [...asString(value).matchAll(NUMBER_TOKEN)].map(match => match[0].replace(/^v/u, ''));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A vault-relative `wiki/...md` page path. */
function validPagePath(page) {
  if (typeof page !== 'string' || !page.startsWith('wiki/') || !page.endsWith('.md')) return false;
  if (page.includes('\\') || page.includes('\0')) return false;
  return !page.split('/').some(part => !part || part === '.' || part === '..');
}

/** Lowercase word tokens that contain at least three letters. */
function tokenSet(text) {
  const tokens = new Set();
  for (const match of String(text).toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    const letters = [...token].filter(character => /\p{L}/u.test(character)).length;
    if (letters >= 3) tokens.add(token);
  }
  return tokens;
}

function jaccard(left, right) {
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

/**
 * Ranks the Wiki content pages of `vault` for a current-state proposal. `report` is a `runMaintenance` result; findings
 * of kind oversized, stale, orphan and update-sprawl contribute, and a page that is a near duplicate of another page
 * (Jaccard similarity ≥ 0.8 between the lowercase 3+ letter tokens of title plus first 200 body words) gets 0.5.
 * Pages with score 0 are dropped. Sorted by score descending, then path ascending.
 * @param {string} vault
 * @param {{now?: Date, report?: any}} [options]
 * @returns {Promise<Array<{path: string, score: number, reasons: string[]}>>}
 */
export async function scorePages(vault, options = {}) {
  const report = options.report ?? { findings: [] };
  const root = await vaultRoot(vault);
  const paths = await listWikiMarkdown(root);
  const kinds = new Map();
  for (const finding of Array.isArray(report.findings) ? report.findings : []) {
    if (!finding || typeof finding.path !== 'string' || typeof finding.kind !== 'string') continue;
    if (!kinds.has(finding.path)) kinds.set(finding.path, new Set());
    kinds.get(finding.path).add(finding.kind);
  }

  const pages = [];
  for (const path of paths) {
    const raw = await readFile(join(root, path), 'utf8');
    const parsed = parseFrontmatter(raw);
    const body = parsed.body;
    const title = typeof parsed.data.title === 'string' ? parsed.data.title : '';
    const leading = body.trim().split(/\s+/u).filter(Boolean).slice(0, LEADING_BODY_WORDS).join(' ');
    pages.push({
      path,
      body,
      words: countWords(body),
      dated: withoutCode(body).split('\n').filter(line => UPDATE_HEADING.test(line) && ISO_DATE.test(line)).length,
      kinds: kinds.get(path) ?? new Set(),
      tokens: tokenSet(`${title} ${leading}`)
    });
  }

  const duplicates = new Set();
  for (let left = 0; left < pages.length; left++) {
    for (let right = left + 1; right < pages.length; right++) {
      if (jaccard(pages[left].tokens, pages[right].tokens) < NEAR_DUPLICATE_THRESHOLD) continue;
      duplicates.add(pages[left].path);
      duplicates.add(pages[right].path);
    }
  }

  const scored = [];
  for (const page of pages) {
    const contributions = new Map();
    if (page.kinds.has('oversized')) contributions.set('oversized', page.words / 3000);
    const datedScore = Math.min(page.dated / 6, 2);
    if (datedScore > 0) contributions.set('update-sprawl', datedScore);
    if (page.kinds.has('stale')) contributions.set('stale', 1);
    if (page.kinds.has('orphan')) contributions.set('orphan', 0.5);
    if (duplicates.has(page.path)) contributions.set('near-duplicate', 0.5);
    let score = 0;
    for (const value of contributions.values()) score += value;
    if (score <= 0) continue;
    scored.push({ path: page.path, score, reasons: SCORE_REASONS.filter(reason => contributions.has(reason)) });
  }
  scored.sort((left, right) => (right.score - left.score) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return scored;
}

/** True for a path that a proposal may never target. */
function ineligiblePath(path) {
  if (typeof path !== 'string' || !path) return true;
  const lowered = path.toLowerCase();
  if (EXCLUDED_EXACT.includes(lowered)) return true;
  return EXCLUDED_PREFIXES.some(prefix => lowered.startsWith(prefix));
}

/**
 * Picks at most `maxPages` (1..3) target paths from a `scorePages` result. Excludes reserved folders, index and log,
 * paths that already have an open proposal and paths the caller marks as recently edited.
 * @param {Array<{path: string}>} scored
 * @param {{now?: Date, maxPages?: number, openProposalPaths?: string[], recentlyEdited?: (path: string) => boolean}} [options]
 * @returns {string[]}
 */
export function selectTargets(scored, options = {}) {
  const maxPages = options.maxPages ?? 3;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3) {
    throw failure('E_ARGUMENT', 'maxPages must be an integer from 1 to 3.');
  }
  const open = new Set((Array.isArray(options.openProposalPaths) ? options.openProposalPaths : []).map(asString));
  const recentlyEdited = typeof options.recentlyEdited === 'function' ? options.recentlyEdited : () => false;
  const picked = [];
  const seen = new Set();
  for (const entry of Array.isArray(scored) ? scored : []) {
    const path = typeof entry === 'string' ? entry : entry?.path;
    if (typeof path !== 'string' || seen.has(path) || ineligiblePath(path)) continue;
    if (open.has(path)) continue;
    if (recentlyEdited(path)) continue;
    seen.add(path);
    picked.push(path);
    if (picked.length >= maxPages) break;
  }
  return picked;
}

/**
 * Removes HTML comments (including multi-line), zero-width and bidi control characters, and normalises CRLF to LF.
 * Nothing else changes.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForModel(text) {
  return asString(text)
    .replace(/\r\n/gu, '\n')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu, '');
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const SENTENCE_END = /[.!?](?=\s|$)/gu;
const HEADING_LINE = /^#{1,6}\s+\S/u;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+\S/u;

/** Splits one paragraph-like text on sentence punctuation. */
function splitParagraph(text) {
  const out = [];
  const source = text.trim();
  if (!source) return out;
  let start = 0;
  for (const match of source.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + 1;
    const piece = source.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const tail = source.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Deterministic sentence split for markdown body text. Sentence punctuation (`.` `!` `?`) followed by whitespace or the
 * end of the text splits; headings and list items are one item per line, and hard line breaks also end a paragraph. A
 * line inside a fenced code block is kept whole as one sentence; the fence delimiters themselves are dropped. Empty
 * strings are dropped.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const out = [];
  let fence = null;
  let paragraph = '';
  const flush = () => {
    if (paragraph) out.push(...splitParagraph(paragraph));
    paragraph = '';
  };
  for (const raw of asString(text).split('\n')) {
    const trimmed = raw.trim();
    if (fence) {
      const close = FENCE_CLOSE.exec(raw);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) { fence = null; continue; }
      if (trimmed) out.push(trimmed);
      continue;
    }
    const opener = FENCE_OPEN.exec(raw);
    if (opener) { flush(); fence = { char: opener[1][0], length: opener[1].length }; continue; }
    if (!trimmed) { flush(); continue; }
    if (HEADING_LINE.test(trimmed)) { flush(); out.push(trimmed); continue; }
    if (LIST_ITEM.test(trimmed)) { flush(); out.push(...splitParagraph(trimmed)); continue; }
    paragraph = paragraph ? `${paragraph} ${trimmed}` : trimmed;
  }
  flush();
  return out;
}

const anchorErrors = (anchor, where, errors) => {
  if (!isObject(anchor)) { errors.push(`${where} must be an object`); return; }
  const keys = Object.keys(anchor);
  for (const key of keys) if (key !== 'source' && key !== 'quote') errors.push(`${where} has an unknown key "${key}"`);
  if (anchor.source !== 'page' && anchor.source !== 'archive') errors.push(`${where}.source must be "page" or "archive"`);
  if (typeof anchor.quote !== 'string') errors.push(`${where}.quote must be a string`);
  else if (anchor.quote.length < 1 || anchor.quote.length > 600) errors.push(`${where}.quote must be 1..600 characters`);
};

/**
 * Validates a proposal object against the phase B1 schema. Extra keys at any level are errors; the total word count of
 * all `sentences[].text` values may not exceed 250.
 * @param {any} obj
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProposal(obj) {
  const errors = [];
  if (!isObject(obj)) return { ok: false, errors: ['proposal must be an object'] };
  for (const key of Object.keys(obj)) {
    if (!['schemaVersion', 'page', 'sentences', 'conflicts'].includes(key)) errors.push(`proposal has an unknown key "${key}"`);
  }
  if (obj.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!validPagePath(obj.page)) errors.push('page must be a wiki/...md path');

  const sentences = obj.sentences;
  if (!Array.isArray(sentences)) errors.push('sentences must be an array');
  else if (sentences.length < 1 || sentences.length > 20) errors.push('sentences must have 1 to 20 items');
  else {
    sentences.forEach((sentence, index) => {
      const where = `sentences[${index}]`;
      if (!isObject(sentence)) { errors.push(`${where} must be an object`); return; }
      for (const key of Object.keys(sentence)) {
        if (key !== 'text' && key !== 'anchors') errors.push(`${where} has an unknown key "${key}"`);
      }
      if (typeof sentence.text !== 'string') errors.push(`${where}.text must be a string`);
      else if (sentence.text.length < 1 || sentence.text.length > 400) errors.push(`${where}.text must be 1..400 characters`);
      if (!Array.isArray(sentence.anchors)) errors.push(`${where}.anchors must be an array`);
      else if (sentence.anchors.length < 1 || sentence.anchors.length > 3) errors.push(`${where}.anchors must have 1 to 3 items`);
      else sentence.anchors.forEach((anchor, at) => anchorErrors(anchor, `${where}.anchors[${at}]`, errors));
    });
  }

  const conflicts = obj.conflicts;
  if (!Array.isArray(conflicts)) errors.push('conflicts must be an array');
  else if (conflicts.length > 5) errors.push('conflicts must have 0 to 5 items');
  else conflicts.forEach((item, index) => {
    const where = `conflicts[${index}]`;
    if (!isObject(item)) { errors.push(`${where} must be an object`); return; }
    for (const key of Object.keys(item)) {
      if (key !== 'a' && key !== 'b') errors.push(`${where} has an unknown key "${key}"`);
    }
    if (typeof item.a !== 'string') errors.push(`${where}.a must be a string`);
    if (typeof item.b !== 'string') errors.push(`${where}.b must be a string`);
  });

  if (Array.isArray(sentences)) {
    const words = sentences.reduce((sum, sentence) => sum + countWords(sentence?.text), 0);
    if (words > 250) errors.push(`total sentence words must be at most 250 (got ${words})`);
  }
  return { ok: errors.length === 0, errors };
}

/** Stable JSON for frontmatter comparison (keys sorted, so YAML key order never matters). */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The text between the current-state markers of a page, or '' when the page has no complete block. */
function blockBody(text) {
  const source = asString(text);
  const start = source.indexOf(OPEN_MARKER);
  if (start < 0) return '';
  const end = source.indexOf(CLOSE_MARKER, start + OPEN_MARKER.length);
  return end < 0 ? '' : source.slice(start + OPEN_MARKER.length, end);
}

/**
 * Runs the five blocking gates over an old page, its old archive and the proposed new texts. `archiveText` and
 * `newArchiveText` may be ''. `delta` is computed even when one or more gates fail.
 * @param {{pageText: string, archiveText?: string, newPageText: string, newArchiveText?: string, proposal: any}} input
 * @returns {{ok: boolean, failures: Array<{gate: string, detail: string}>, delta: {droppedSentences: number, changedNumbers: string[], lostCaveats: number, blockWords: number}}}
 */
export function runGates(input) {
  const pageText = asString(input?.pageText);
  const archiveText = asString(input?.archiveText);
  const newPageText = asString(input?.newPageText);
  const newArchiveText = asString(input?.newArchiveText);
  const proposal = input?.proposal;
  const failures = [];

  // Fail closed: a proposal that does not satisfy the schema never reaches a gate, and nothing is treated as empty.
  const schema = validateProposal(proposal);
  if (!schema.ok) {
    return {
      ok: false,
      failures: [{ gate: 'SCHEMA', detail: schema.errors.join('; ') }],
      delta: { droppedSentences: 0, changedNumbers: [], lostCaveats: 0, blockWords: 0 }
    };
  }
  const sentences = proposal.sentences;
  const conflicts = proposal.conflicts;

  // G1: every old body sentence survives, in the new page or the new archive.
  const oldSentences = splitSentences(parseFrontmatter(pageText).body);
  const missing = oldSentences.filter(sentence => !newPageText.includes(sentence) && !newArchiveText.includes(sentence));
  if (missing.length) {
    failures.push({ gate: 'G1', detail: `${missing.length} old sentence(s) not preserved` });
  }

  // G2: frontmatter is unchanged, except that status may become disputed when conflicts are proposed.
  const oldData = parseFrontmatter(pageText).data;
  const newData = parseFrontmatter(newPageText).data;
  const keys = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
  for (const key of keys) {
    if (key === 'status') continue;
    if (stable(oldData[key]) !== stable(newData[key])) {
      failures.push({ gate: 'G2', detail: `frontmatter field "${key}" changed` });
    }
  }
  if (stable(oldData.status) !== stable(newData.status)) {
    const allowed = newData.status === 'disputed' && conflicts.length > 0;
    if (!allowed) failures.push({ gate: 'G2', detail: 'status may only change to disputed when conflicts are proposed' });
  }

  // G3: numbers, dates and version tokens in a sentence text are anchored, and each quote exists verbatim in its source.
  // Matching is token-exact: "5" never matches "512", "2.4.0" never matches "2.4.0-rc.12", "7070" never matches "17070".
  const sanitizedPage = sanitizeForModel(pageText);
  const sanitizedArchive = sanitizeForModel(archiveText);
  const changedNumbers = new Set();
  sentences.forEach((sentence, index) => {
    const text = asString(sentence.text);
    const anchors = sentence.anchors;
    const quoteTokens = new Set(anchors.flatMap(entry => g3Tokens(entry.quote)));
    for (const token of g3Tokens(text)) {
      if (!quoteTokens.has(token)) {
        changedNumbers.add(token);
        failures.push({ gate: 'G3', detail: `sentences[${index}] token "${token}" is not in any anchor quote` });
      }
    }
    anchors.forEach((entry, at) => {
      const quote = asString(entry.quote);
      const source = entry.source === 'archive' ? sanitizedArchive : sanitizedPage;
      if (!quote || !source.includes(quote)) {
        failures.push({ gate: 'G3', detail: `sentences[${index}].anchors[${at}] quote not found in the ${entry.source}` });
      }
    });
  });

  // G4: a caveat in an anchor quote must be present in the sentence, and no old caveat sentence may disappear.
  let lostCaveats = 0;
  oldSentences.forEach((sentence, index) => {
    if (!hasCaveat(sentence)) return;
    if (newPageText.includes(sentence) || newArchiveText.includes(sentence)) return;
    lostCaveats++;
    failures.push({ gate: 'G4', detail: `caveat sentence lost: #${index + 1}` });
  });
  sentences.forEach((sentence, index) => {
    const text = asString(sentence?.text);
    const anchors = Array.isArray(sentence?.anchors) ? sentence.anchors : [];
    if (!anchors.some(anchor => hasCaveat(anchor?.quote))) return;
    if (hasCaveat(text)) return;
    lostCaveats++;
    failures.push({ gate: 'G4', detail: `sentences[${index}] quotes a caveat but does not repeat one` });
  });

  // G5: each conflict pair is real (two distinct, non-trivial strings in the old text), visible in the new block, and the
  // page is marked disputed.
  if (conflicts.length) {
    const block = blockBody(newPageText);
    const oldText = `${sanitizedPage}\n${sanitizedArchive}`;
    conflicts.forEach((item, index) => {
      const a = asString(item.a).trim();
      const b = asString(item.b).trim();
      const where = `conflicts[${index}]`;
      const real = a !== b && countWords(a) >= 3 && countWords(b) >= 3 && oldText.includes(a) && oldText.includes(b);
      if (!real) {
        failures.push({ gate: 'G5', detail: `${where} must name two distinct, at least three-word strings from the old page or archive` });
      }
      if (!a || !b || !block.includes(a) || !block.includes(b)) {
        failures.push({ gate: 'G5', detail: `${where} is not present verbatim in the new current-state block` });
      }
    });
    if (newData.status !== 'disputed') failures.push({ gate: 'G5', detail: 'new frontmatter status must be disputed' });
  }

  const blockWords = sentences.reduce((sum, sentence) => sum + countWords(sentence?.text), 0);
  return {
    ok: failures.length === 0,
    failures,
    delta: { droppedSentences: missing.length, changedNumbers: [...changedNumbers], lostCaveats, blockWords }
  };
}

/**
 * Renders the proposed current-state block: heading, opening marker, one bullet per sentence, one disputed bullet per
 * conflict pair, closing marker.
 * @param {any} proposal
 * @param {{date: string|Date}} options
 * @returns {string}
 */
export function renderBlock(proposal, options = /** @type {any} */ ({})) {
  const sentences = Array.isArray(proposal?.sentences) ? proposal.sentences : [];
  const conflicts = Array.isArray(proposal?.conflicts) ? proposal.conflicts : [];
  const day = options.date instanceof Date && !Number.isNaN(options.date.getTime())
    ? options.date.toISOString().slice(0, 10)
    : asString(options.date);
  const lines = [`## Current state (proposed ${day})`, OPEN_MARKER];
  for (const sentence of sentences) lines.push(`- ${asString(sentence?.text)}`);
  for (const item of conflicts) lines.push(`- Disputed: "${asString(item?.a)}" vs "${asString(item?.b)}"`);
  lines.push(CLOSE_MARKER);
  return lines.join('\n');
}

/** Index just after a closed frontmatter block, or 0. */
function frontmatterEnd(lines) {
  if (lines[0] !== '---') return 0;
  for (let index = 1; index < lines.length; index++) if (lines[index] === '---') return index + 1;
  return 0;
}

/**
 * Inserts `block` after the first `# ` heading line that follows the frontmatter and is outside a fenced code block,
 * with one blank line before and after. Without such a heading the block goes right after the frontmatter (or at the
 * top when there is none). An existing block between the markers (plus its `## Current state` heading) is replaced, and
 * its lines are returned as `replaced`. No other line changes.
 * @param {string} pageText
 * @param {string} block
 * @returns {{pageText: string, replaced: string[]}}
 */
export function insertBlock(pageText, block) {
  const lines = asString(pageText).split('\n');
  let replaced = [];
  const openAt = lines.findIndex(line => line.trim() === OPEN_MARKER);
  const closeAt = openAt < 0 ? -1 : lines.findIndex((line, index) => index > openAt && line.trim() === CLOSE_MARKER);
  if (openAt >= 0 && closeAt >= 0) {
    let start = openAt;
    if (start > 0 && BLOCK_HEADING.test(lines[start - 1].trim())) start--;
    replaced = lines.slice(start, closeAt + 1);
    lines.splice(start, closeAt - start + 1);
    if (lines[start - 1] === '' && lines[start] === '') lines.splice(start, 1);
  }

  const bodyStart = frontmatterEnd(lines);
  let heading = -1;
  let fence = null;
  for (let index = bodyStart; index < lines.length; index++) {
    const raw = lines[index];
    if (fence) {
      const close = FENCE_CLOSE.exec(raw);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const opener = FENCE_OPEN.exec(raw);
    if (opener) { fence = { char: opener[1][0], length: opener[1].length }; continue; }
    if (/^#\s+\S/u.test(raw)) { heading = index; break; }
  }
  const insertAt = heading < 0 ? bodyStart : heading + 1;
  const blockLines = asString(block).split('\n');
  const leading = insertAt === 0 ? [] : [''];
  const tail = (lines[insertAt] ?? '').trim() === '' ? [] : [''];
  lines.splice(insertAt, 0, ...leading, ...blockLines, ...tail);
  return { pageText: lines.join('\n'), replaced };
}

const PROPOSAL_ID = /^\d{8}-[0-9a-f]{8}$/u;
const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REVIEW_VERDICTS = new Set(['accepted', 'rejected']);
const NON_REVIEWABLE_STATUSES = new Set(['gate-failed', 'rejected-schema']);

/** Epoch milliseconds of a Date, epoch number or ISO string, or null. */
function timeOf(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

function requiredTime(value, field) {
  const time = timeOf(value);
  if (time === null) throw failure('E_ARGUMENT', `${field} must be a valid date`);
  return time;
}

/** `<YYYYMMDD>` in UTC. */
const dayStamp = time => new Date(time).toISOString().slice(0, 10).replaceAll('-', '');

function proposalId(page, baseHash, createdAt) {
  const digest = createHash('sha256').update(`${page}${baseHash}`).digest('hex').slice(0, 8);
  return `${dayStamp(createdAt)}-${digest}`;
}

/** A stored record, or null only when the file does not exist. Anything unreadable, unparsable or misnamed is E_STORE_CORRUPT. */
async function readRecord(file) {
  const corrupt = () => failure('E_STORE_CORRUPT', `proposal record is unreadable or invalid: ${basename(file)}`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw corrupt();
  }
  let value;
  try { value = JSON.parse(text); } catch { throw corrupt(); }
  if (!isObject(value)) throw corrupt();
  const name = basename(file);
  const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null;
  if (typeof value.id !== 'string' || !PROPOSAL_ID.test(value.id) || value.id !== id) throw corrupt();
  return value;
}

/**
 * The proposal store under `<stateDir>/synthesis/proposals`. Records are written atomically and contain no page text
 * beyond the proposal itself. `now` is always an explicit argument; the store never reads the clock.
 * @param {string} stateDir
 */
export function createStore(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) throw failure('E_ARGUMENT', 'stateDir must be a directory path');
  const directory = join(stateDir, 'synthesis', 'proposals');
  const fileOf = id => join(directory, `${id}.json`);

  async function save(record) {
    if (!isObject(record)) throw failure('E_ARGUMENT', 'proposal record must be an object');
    if (!validPagePath(record.page)) throw failure('E_ARGUMENT', 'proposal record page must be a wiki/...md path');
    if (typeof record.baseHash !== 'string' || !record.baseHash) throw failure('E_ARGUMENT', 'proposal record baseHash must be a string');
    const created = requiredTime(record.createdAt, 'createdAt');
    const createdAt = typeof record.createdAt === 'string' ? record.createdAt : new Date(created).toISOString();
    const id = proposalId(record.page, record.baseHash, created);
    const exists = await lstat(fileOf(id)).then(() => true, error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw failure('E_PROPOSAL_EXISTS', `a proposal with id ${id} already exists`);
    const status = NON_REVIEWABLE_STATUSES.has(record.status) ? record.status : 'open';
    const stored = {
      id,
      batch: record.batch,
      page: record.page,
      baseHash: record.baseHash,
      createdAt,
      expiresAt: new Date(created + PROPOSAL_TTL_MS).toISOString(),
      status,
      proposal: record.proposal,
      gates: record.gates,
      ...(typeof record.shadow === 'boolean' ? { shadow: record.shadow } : {})
    };
    await atomicWriteFile(fileOf(id), `${JSON.stringify(stored, null, 2)}\n`);
    return stored;
  }

  async function readAll() {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw failure('E_STORE_CORRUPT', `proposal directory is unreadable: ${basename(directory)}`);
    }
    const records = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const record = await readRecord(join(directory, name));
      if (record === null) continue;
      records.push(record);
    }
    return records;
  }

  async function list(options = /** @type {any} */ ({})) {
    const now = requiredTime(options.now, 'now');
    const records = await readAll();
    for (const record of records) {
      if (record.status !== 'open') continue;
      const expires = timeOf(record.expiresAt);
      if (expires === null || expires > now) continue;
      record.status = 'expired';
      await atomicWriteFile(fileOf(record.id), `${JSON.stringify(record, null, 2)}\n`);
    }
    records.sort((left, right) => (timeOf(left.createdAt) ?? 0) - (timeOf(right.createdAt) ?? 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return records;
  }

  async function get(id) {
    if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) return null;
    return readRecord(fileOf(id));
  }

  async function markReviewed(id, verdict) {
    if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) throw failure('E_ARGUMENT', 'invalid proposal id');
    if (!REVIEW_VERDICTS.has(verdict)) throw failure('E_ARGUMENT', 'verdict must be accepted or rejected');
    const record = await get(id);
    if (!record) throw failure('E_NOT_FOUND', 'proposal not found');
    if (record.status !== 'open') throw failure('E_PROPOSAL_STATE', 'only an open proposal can be reviewed');
    record.status = verdict;
    await atomicWriteFile(fileOf(id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  async function openPaths(options = /** @type {any} */ ({})) {
    const records = await list({ now: options.now });
    return [...new Set(records.filter(record => record.status === 'open').map(record => record.page))].sort();
  }

  async function unreviewedBatches(options = /** @type {any} */ ({})) {
    const records = await list({ now: options.now });
    return new Set(records.filter(record => record.status === 'open').map(record => record.batch)).size;
  }

  /** Overwrites the review status of an existing record (for example `invalidated` or `reverted`). */
  async function setStatus(id, status) {
    if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) throw failure('E_ARGUMENT', 'invalid proposal id');
    if (typeof status !== 'string' || !status) throw failure('E_ARGUMENT', 'status must be a non-empty string');
    const record = await get(id);
    if (!record) throw failure('E_NOT_FOUND', 'proposal not found');
    record.status = status;
    await atomicWriteFile(fileOf(id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  return { save, list, get, markReviewed, setStatus, openPaths, unreviewedBatches };
}
