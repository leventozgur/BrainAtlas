// SPDX-License-Identifier: MIT
// BA-48 phase B3: human review of stored current-state proposals. `show` only reads; `accept` writes the page and its
// archive inside the Wiki write lock and reverts both when a post-apply check regresses. `reject` changes the store only.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_EXCLUDE_WIKI,
  appendLog,
  atomicWriteFile,
  buildIndex,
  checkPage,
  loadPagesDetailed,
  parseFrontmatter,
  search,
} from '@brainatlas/core';
import { lintWiki } from '@llmwiki/core';
import { planCompaction } from '../compact.mjs';
import { vaultRoot } from '../maintain.mjs';
import { createStore, insertBlock, renderBlock, runGates } from './core.mjs';
import { withCompaction, withDisputed } from './propose.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const MAX_QUERIES = 5;
const TOP_RESULTS = 10;
const RANK_SLACK = 2;
const CONFLICTED_COPY = /conflicted copy|\.conflict-/iu;
const CONTEXT_LINES = 3;
const DIFF_DP_LIMIT = 4_000_000;

const require = createRequire(import.meta.url);
let lockModule = null;

/** The same Wiki write lock loader as `compact.mjs`; it is imported only by `accept`. */
async function lockApi() {
  if (lockModule) return lockModule;
  const candidates = [];
  try {
    candidates.push(
      pathToFileURL(join(dirname(require.resolve('@brainatlas/mcp/package.json')), 'src', 'lock.mjs')).href
    );
  } catch {
    /* no installed MCP package: use the sibling copy below */
  }
  candidates.push(new URL('../../mcp/src/lock.mjs', import.meta.url).href);
  let cause = null;
  for (const url of candidates) {
    try {
      lockModule = await import(url);
      return lockModule;
    } catch (error) {
      cause = cause ?? error;
    }
  }
  const detail = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
  throw failure('E_LOCK_UNAVAILABLE', `The Wiki write lock module could not be loaded${detail}.`);
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex');
const timeOf = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
};

/** True when a record's `expiresAt` has passed at `now`. */
function expired(record, now) {
  const expires = timeOf(record?.expiresAt);
  return expires !== null && expires <= now.getTime();
}

/** The archive path of a page, with the same naming rule as `compact`. */
function archivePathOf(page) {
  return `wiki/archive/${page.slice('wiki/'.length).replace(/\.md$/u, '').replaceAll('/', '--')}-history.md`;
}

/** The regular page file below `root`; symlinks anywhere on the path are refused. */
async function pageFile(root, page) {
  const parts = page.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        throw failure('E_NOT_FOUND', 'Page not found in the vault.');
      throw error;
    });
    if (info.isSymbolicLink()) throw failure('E_PATH_ESCAPE', 'Page path is not a regular file.');
    const last = index === parts.length - 1;
    if (last ? !info.isFile() : !info.isDirectory()) throw failure('E_PATH_ESCAPE', 'Page path is not a regular file.');
  }
  const real = await realpath(current).catch(() => null);
  if (!real) throw failure('E_NOT_FOUND', 'Page not found in the vault.');
  const from = relative(root, real);
  if (!from || from === '..' || from.startsWith(`..${sep}`))
    throw failure('E_PATH_ESCAPE', 'Page path leaves the vault.');
  return real;
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The exact bytes of an optional file, or null when it does not exist. */
async function readOptionalBytes(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** A recursive conflicted-copy name check over one directory; symlinks are skipped and each real directory is visited once. */
async function hasConflictIn(directory, visited) {
  const real = await realpath(directory).catch(() => null);
  if (!real || visited.has(real)) return false;
  visited.add(real);
  let entries;
  try {
    entries = await readdir(real, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (CONFLICTED_COPY.test(entry.name)) return true;
    if (entry.isDirectory() && (await hasConflictIn(join(real, entry.name), visited))) return true;
  }
  return false;
}

/** True when the page folder or `wiki/archive/` holds a conflicted copy. */
async function hasConflictedCopy(root, page) {
  const folder = join(root, ...page.split('/').slice(0, -1));
  const visited = new Set();
  if (await hasConflictIn(folder, visited)) return true;
  return hasConflictIn(join(root, 'wiki', 'archive'), visited);
}

/** The delta summary kept on the record, with the proposed conflict count. */
function deltaOf(record) {
  const delta = isObject(record?.gates?.delta) ? record.gates.delta : {};
  const conflicts = Array.isArray(record?.proposal?.conflicts) ? record.proposal.conflicts.length : 0;
  return {
    droppedSentences: Number.isInteger(delta.droppedSentences) ? delta.droppedSentences : 0,
    changedNumbers: Array.isArray(delta.changedNumbers) ? delta.changedNumbers.map(String) : [],
    lostCaveats: Number.isInteger(delta.lostCaveats) ? delta.lostCaveats : 0,
    blockWords: Number.isInteger(delta.blockWords) ? delta.blockWords : 0,
    conflicts,
  };
}

/** A list summary: identity and gate state only, never page or proposal text. */
function summaryOf(record) {
  return {
    id: record.id,
    page: record.page,
    batch: record.batch,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    shadow: record.shadow === true,
    status: record.status,
    gateStatus: record?.gates?.ok === true ? 'passed' : 'failed',
  };
}

/** Open proposals, newest first. The store marks newly expired records before the filter. */
export async function listProposals(options = /** @type {any} */ ({})) {
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const store = createStore(options.stateDir);
  const records = await store.list({ now });
  const proposals = records
    .filter((record) => record.status === 'open')
    .sort(
      (left, right) =>
        (timeOf(right.createdAt) ?? 0) - (timeOf(left.createdAt) ?? 0) ||
        (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)
    )
    .map(summaryOf);
  return { action: 'list', proposals };
}

/** Rendered block, page text and archive text of a proposal against one current page. */
async function previewOf({ vault, root, page, pageText, proposal, now, plan = planCompaction, lenientPlan = true }) {
  const archiveRel = archivePathOf(page);
  const archiveFile = join(root, ...archiveRel.split('/'));
  const originalArchive = (await readOptional(archiveFile)) ?? '';
  const planned = lenientPlan
    ? await plan(vault, { page, keep: 3, now }).catch(() => null)
    : await plan(vault, { page, keep: 3, now });
  const compacted = await withCompaction(root, page, pageText, planned);
  const block = renderBlock(proposal, { date: now });
  const base =
    Array.isArray(proposal?.conflicts) && proposal.conflicts.length
      ? withDisputed(compacted.pageText)
      : compacted.pageText;
  const { pageText: newPageText } = insertBlock(base, block);
  return { archiveRel, archiveFile, originalArchive, block, newPageText, newArchiveText: compacted.archiveText };
}

/** The queries of a page: its title, then its frontmatter keywords, at most five. */
function retrievalQueries(pageText) {
  const parsed = parseFrontmatter(pageText);
  const heading = /^#\s+(.+)$/mu.exec(parsed.body)?.[1]?.trim() ?? '';
  const title = typeof parsed.data.title === 'string' && parsed.data.title.trim() ? parsed.data.title.trim() : heading;
  const keywords = Array.isArray(parsed.data.keywords)
    ? parsed.data.keywords.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    : [];
  const queries = [];
  for (const query of [title, ...keywords]) {
    if (!query || queries.includes(query)) continue;
    queries.push(query);
    if (queries.length >= MAX_QUERIES) break;
  }
  return queries;
}

/** A fresh lexical index of the Wiki pages (same root and exclusion rules as `wiki query`). */
function wikiIndex(root, now) {
  const { pages } = loadPagesDetailed(join(root, 'wiki'));
  return buildIndex(pages, { now, exclude: DEFAULT_EXCLUDE_WIKI });
}

/** The 1-based rank of `page` (a `wiki/` path) in the top ten results of `query`, or null. */
function rankOf(index, query, page, now) {
  const target = page.slice('wiki/'.length);
  const results = search(index, query, { limit: TOP_RESULTS, abstainThreshold: 0, asOf: now }).results;
  const at = results.findIndex((item) => item.path === target);
  return at < 0 ? null : at + 1;
}

/** Identifier of one lint finding of the page, compared before and after the write. */
const lintKey = (finding) => `${finding.category}\u0000${finding.message}`;

/** The Core lint findings of one page, as a set of category/message keys. A lint failure is never hidden. */
async function lintFindings(root, page) {
  const result = await lintWiki(root);
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const rel = page.slice('wiki/'.length);
  return new Set(findings.filter((item) => item.file === rel).map(lintKey));
}

/** The OKF error findings of one page text, as a set of rule/message keys. */
function okfErrors(pageText, page, now) {
  const parsed = parseFrontmatter(pageText);
  const findings = checkPage(
    { path: page, data: parsed.data, body: parsed.body, raw: pageText, errors: parsed.errors },
    { asOf: now }
  );
  return new Set(
    findings.filter((item) => item.severity === 'error').map((item) => `${item.rule}\u0000${item.message}`)
  );
}

/** Line diff operations, with the unchanged prefix and suffix kept as context. */
function diffOperations(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const operations = [];
  for (let index = 0; index < start; index++) operations.push({ type: ' ', line: before[index] });
  const left = before.slice(start, endBefore);
  const right = after.slice(start, endAfter);
  if (left.length * right.length > DIFF_DP_LIMIT) {
    for (const line of left) operations.push({ type: '-', line });
    for (const line of right) operations.push({ type: '+', line });
  } else {
    const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        operations.push({ type: ' ', line: left[i] });
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        operations.push({ type: '-', line: left[i] });
        i++;
      } else {
        operations.push({ type: '+', line: right[j] });
        j++;
      }
    }
    while (i < left.length) operations.push({ type: '-', line: left[i++] });
    while (j < right.length) operations.push({ type: '+', line: right[j++] });
  }
  for (let index = endBefore; index < before.length; index++) operations.push({ type: ' ', line: before[index] });
  return operations;
}

/** A unified diff with three lines of context, or '' when the two texts are identical. */
function unifiedDiff(before, after, page) {
  const operations = diffOperations(String(before).split('\n'), String(after).split('\n'));
  const changes = operations
    .map((operation, index) => (operation.type === ' ' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changes.length) return '';

  const groups = [];
  let first = changes[0];
  let last = changes[0];
  for (const index of changes.slice(1)) {
    if (index - last <= CONTEXT_LINES * 2 + 1) last = index;
    else {
      groups.push([first, last]);
      first = index;
      last = index;
    }
  }
  groups.push([first, last]);

  let oldLine = 1;
  let newLine = 1;
  const annotated = operations.map((operation) => {
    const item = { ...operation, oldLine, newLine };
    if (operation.type !== '+') oldLine++;
    if (operation.type !== '-') newLine++;
    return item;
  });

  const lines = [`--- a/${page}`, `+++ b/${page}`];
  for (const [start, end] of groups) {
    const from = Math.max(0, start - CONTEXT_LINES);
    const to = Math.min(annotated.length - 1, end + CONTEXT_LINES);
    let oldCount = 0;
    let newCount = 0;
    for (let index = from; index <= to; index++) {
      if (annotated[index].type !== '+') oldCount++;
      if (annotated[index].type !== '-') newCount++;
    }
    lines.push(`@@ -${annotated[from].oldLine},${oldCount} +${annotated[from].newLine},${newCount} @@`);
    for (let index = from; index <= to; index++) lines.push(`${annotated[index].type}${annotated[index].line}`);
  }
  return lines.join('\n');
}

/** `show`: delta summary, rendered block and a freshly computed unified diff. A changed page marks the record invalidated. */
export async function showProposal(options = /** @type {any} */ ({})) {
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const store = createStore(options.stateDir);
  const record = await store.get(options.id);
  if (!record) throw failure('E_NOT_FOUND', 'proposal not found');
  const root = await vaultRoot(options.vault);
  const file = await pageFile(root, record.page);
  const pageText = await readFile(file, 'utf8');
  const invalidatedNow = hashOf(pageText) !== record.baseHash && record.status === 'open';
  let status = record.status;
  if (invalidatedNow) {
    await store.setStatus(record.id, 'invalidated');
    status = 'invalidated';
  }
  const preview = await previewOf({
    vault: options.vault,
    root,
    page: record.page,
    pageText,
    proposal: record.proposal,
    now,
  });
  return {
    action: 'show',
    id: record.id,
    page: record.page,
    batch: record.batch,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    shadow: record.shadow === true,
    status,
    ...(invalidatedNow ? { reason: 'page-changed' } : {}),
    delta: deltaOf(record),
    block: preview.block,
    diff: unifiedDiff(pageText, preview.newPageText, record.page),
  };
}

/** `reject`: only the store record changes. */
export async function rejectProposal(options = /** @type {any} */ ({})) {
  const store = createStore(options.stateDir);
  const record = await store.markReviewed(options.id, 'rejected');
  return { action: 'reject', id: record.id, page: record.page, status: record.status };
}

/** Restores both originals byte for byte; a newly created archive is deleted. A failed step is E_APPLY_RESTORE_FAILED. */
async function restore(file, archiveFile, originalPage, originalArchive, write = atomicWriteFile) {
  const failed = [];
  try {
    await write(file, originalPage);
  } catch {
    failed.push(basename(file));
  }
  if (originalArchive === null) {
    try {
      await unlink(archiveFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') failed.push(basename(archiveFile));
    }
  } else {
    try {
      await write(archiveFile, originalArchive);
    } catch {
      failed.push(basename(archiveFile));
    }
  }
  if (failed.length) {
    throw failure('E_APPLY_RESTORE_FAILED', `restore failed for: ${[...new Set(failed)].join(', ')}`);
  }
}

/**
 * `accept`: all refusals first, then one locked apply. The page is written only after the gates pass, and both files are
 * restored when a byte verification or a post-apply lint, OKF or retrieval check regresses.
 */
export async function acceptProposal(options = /** @type {any} */ ({})) {
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const deps = isObject(options.dependencies) ? options.dependencies : {};
  const writeFileFn = deps.atomicWriteFile ?? atomicWriteFile;
  const appendLogFn = deps.appendLog ?? appendLog;
  const lintPage = deps.lintFindings ?? lintFindings;
  const plan = deps.planCompaction ?? planCompaction;
  const indexOf = deps.wikiIndex ?? wikiIndex;
  const okfCheck = deps.okfErrors ?? okfErrors;

  const store = createStore(options.stateDir);
  const record = await store.get(options.id);
  if (!record) throw failure('E_NOT_FOUND', 'proposal not found');
  if (record.status !== 'open') {
    if (record.status === 'expired') throw failure('E_PROPOSAL_EXPIRED', 'proposal expired');
    throw failure('E_PROPOSAL_STATE', 'only an open proposal can be accepted');
  }
  if (record.shadow === true) throw failure('E_PROPOSAL_SHADOW', 'shadow proposals are never applied');
  if (expired(record, now)) {
    await store.setStatus(record.id, 'expired');
    throw failure('E_PROPOSAL_EXPIRED', 'proposal expired');
  }

  const root = await vaultRoot(options.vault);
  const file = await pageFile(root, record.page);
  const pageText = await readFile(file, 'utf8');
  if (hashOf(pageText) !== record.baseHash) {
    await store.setStatus(record.id, 'invalidated');
    throw failure('E_PROPOSAL_STALE', 'page changed since the proposal');
  }
  if (await hasConflictedCopy(root, record.page))
    throw failure('E_CONFLICTED_COPY', 'a conflicted copy exists for this page');

  const archiveRel = archivePathOf(record.page);
  const archiveFile = join(root, ...archiveRel.split('/'));
  const { withLock, LOCK_FILE_NAME } = await lockApi();

  return withLock(join(root, 'wiki', LOCK_FILE_NAME), async () => {
    const lockedText = await readFile(file, 'utf8');
    if (hashOf(lockedText) !== record.baseHash) {
      await store.setStatus(record.id, 'invalidated');
      throw failure('E_PROPOSAL_STALE', 'page changed since the proposal');
    }

    // Plan errors refuse the apply: nothing has been written at this point.
    const preview = await previewOf({
      vault: options.vault,
      root,
      page: record.page,
      pageText: lockedText,
      proposal: record.proposal,
      now,
      plan,
      lenientPlan: false,
    });
    const originalPage = await readFile(file);
    const originalArchive = await readOptionalBytes(archiveFile);
    const gates = runGates({
      pageText: lockedText,
      archiveText: originalArchive === null ? '' : originalArchive.toString('utf8'),
      newPageText: preview.newPageText,
      newArchiveText: preview.newArchiveText,
      proposal: record.proposal,
    });
    if (!gates.ok) {
      const error = failure(
        'E_GATE_FAILED',
        `gates failed: ${[...new Set(gates.failures.map((item) => item.gate))].join(', ')}`
      );
      /** @type {any} */ (error).gates = gates.failures;
      throw error;
    }

    const queries = retrievalQueries(lockedText);
    const indexBefore = indexOf(root, now);
    const before = queries.map((query) => ({ query, rank: rankOf(indexBefore, query, record.page, now) }));
    let lintBefore;
    try {
      lintBefore = await lintPage(root, record.page);
    } catch {
      throw failure('E_APPLY_CHECK', 'lint baseline failed; nothing was written');
    }
    const okfBefore = okfCheck(lockedText, record.page, now);

    const writeArchive = originalArchive !== null || preview.newArchiveText !== '';
    let written = false;
    try {
      written = true;
      if (writeArchive) await mkdir(dirname(archiveFile), { recursive: true });
      if (writeArchive) await writeFileFn(archiveFile, preview.newArchiveText);
      await writeFileFn(file, preview.newPageText);

      let verified = (await readFile(file, 'utf8').catch(() => null)) === preview.newPageText;
      if (verified && writeArchive)
        verified = (await readFile(archiveFile, 'utf8').catch(() => null)) === preview.newArchiveText;
      if (!verified) throw failure('E_APPLY_VERIFY', 'written bytes differ from the intended text');

      const indexAfter = indexOf(root, now);
      const after = queries.map((query) => ({ query, rank: rankOf(indexAfter, query, record.page, now) }));
      let lintAfter = lintBefore;
      try {
        lintAfter = await lintPage(root, record.page);
      } catch {
        lintAfter = null;
      }
      const okfAfter = okfCheck(preview.newPageText, record.page, now);
      const checks = [];
      if (lintAfter === null) checks.push('lint');
      else if ([...lintAfter].some((key) => !lintBefore.has(key))) checks.push('lint');
      if ([...okfAfter].some((key) => !okfBefore.has(key))) checks.push('okf');
      const afterRank = (entry) => after.find((item) => item.query === entry.query)?.rank ?? null;
      if (
        before.some(
          (entry) => entry.rank !== null && (afterRank(entry) === null || afterRank(entry) > entry.rank + RANK_SLACK)
        )
      )
        checks.push('retrieval');

      if (checks.length) {
        const error = failure('E_APPLY_REGRESSION', [...new Set(checks)].join(', '));
        /** @type {any} */ (error).checks = [...new Set(checks)];
        throw error;
      }

      await store.setStatus(record.id, 'accepted');
      await appendLogFn(root, { action: 'synthesis-accept', path: record.page, id: record.id }, { now });
      return {
        action: 'accept',
        id: record.id,
        page: record.page,
        status: 'accepted',
        shadow: false,
        archive: archiveRel,
        gateStatus: 'passed',
        retrieval: { before, after },
      };
    } catch (error) {
      if (written) {
        await restore(file, archiveFile, originalPage, originalArchive, writeFileFn);
        try {
          await store.setStatus(record.id, 'reverted');
        } catch {
          /* the original error is the result */
        }
      }
      throw error;
    }
  });
}

/** Human output; the result comes first and every command stays short. */
export function formatProposalResult(result) {
  if (result.action === 'list') {
    const lines = [`open proposals: ${result.proposals.length}`];
    for (const item of result.proposals) {
      lines.push(
        `${item.id}  ${item.page}  batch=${item.batch}  created=${item.createdAt}  expires=${item.expiresAt}  shadow=${item.shadow ? 'yes' : 'no'}  gates=${item.gateStatus}`
      );
    }
    return lines.join('\n');
  }
  if (result.action === 'show') {
    const delta = result.delta;
    const lines = [
      `delta: dropped ${delta.droppedSentences} sentence(s), changed numbers ${JSON.stringify(delta.changedNumbers)}, lost caveats ${delta.lostCaveats}, block words ${delta.blockWords}, conflicts ${delta.conflicts}`,
    ];
    lines.push(`${result.status}: ${result.page}${result.reason ? ` (${result.reason})` : ''}`);
    lines.push(result.block);
    if (result.diff) lines.push(result.diff);
    return lines.join('\n');
  }
  if (result.action === 'accept') return `accepted: ${result.id} (${result.page})`;
  if (result.action === 'reject') return `rejected: ${result.id} (${result.page})`;
  return JSON.stringify(result, null, 2);
}
