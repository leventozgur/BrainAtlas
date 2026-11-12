// SPDX-License-Identifier: MIT
/**
 * Plain-grep baseline: how an agent that only greps the vault would rank the pages of a case set.
 *
 * Query terms: folded with the core normalizer (Turkish dotless i, case, diacritics), split on letters and digits,
 * stop words removed, no stemming. A term matches a line when the folded line contains it as a substring (grep -F).
 * Ranking per file: number of distinct matched terms (desc), then number of matching lines summed over terms (desc),
 * then relative path (asc). Only files with at least one matched term are returned, as grep prints only matching files.
 * Superseded pages are searched like any other page: grep does not read indexes.
 *
 * `rgRanking` produces the same ordering with `rg -i -c -F` per term (local cross-check only, not used by the tests):
 * rg folds case but not Turkish dotless i or diacritics, so the two can differ on Turkish-only queries.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeText } from '../packages/core/src/retrieval/index.mjs';

const STOP = new Set('the a an and or of to in for on is are with how what which when where who why does do will this that bir ve veya ile icin nasil nedir ne hangi bu su de da mi mu'.split(' '));

/** Folded, de-duplicated query terms without stop words. */
export function grepTerms(query) {
  const words = normalizeText(String(query)).match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

function markdownFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Per-file folded text is cached per corpus directory: one read per corpus, however many queries.
const corpusCache = new Map();
function corpusText(corpusDir) {
  if (!corpusCache.has(corpusDir)) {
    const files = markdownFiles(corpusDir);
    const lines = new Map(files.map((rel) => [rel, normalizeText(readFileSync(join(corpusDir, rel), 'utf8')).split('\n')]));
    corpusCache.set(corpusDir, {files, lines});
  }
  return corpusCache.get(corpusDir);
}

function rgLineCounts(corpusDir, term) {
  const result = spawnSync('rg', ['-i', '-c', '-F', '--no-ignore', '--hidden', '--no-messages', '--', term, '.'], {cwd: corpusDir, encoding: 'utf8'});
  const counts = new Map();
  for (const line of (result.stdout || '').split('\n')) {
    const cut = line.lastIndexOf(':');
    if (cut < 0) continue;
    const count = Number(line.slice(cut + 1));
    if (Number.isInteger(count) && count > 0) counts.set(line.slice(0, cut).replace(/^\.\//u, ''), count);
  }
  return counts;
}

/**
 * Rank every page of the corpus for one query.
 * @param {string} corpusDir
 * @param {string} query
 * @param {{rg?: boolean}} [options]
 * @returns {string[]} corpus-relative paths of the matching files, best first
 */
export function grepRanking(corpusDir, query, {rg = false} = {}) {
  const root = resolve(corpusDir);
  const {files, lines} = corpusText(root);
  const terms = grepTerms(query);
  const distinct = new Map(files.map((f) => [f, 0]));
  const total = new Map(files.map((f) => [f, 0]));
  for (const term of terms) {
    const counts = rg ? rgLineCounts(root, term) : null;
    for (const file of files) {
      const count = counts ? (counts.get(file) || 0) : lines.get(file).filter((line) => line.includes(term)).length;
      if (count > 0) {
        distinct.set(file, distinct.get(file) + 1);
        total.set(file, total.get(file) + count);
      }
    }
  }
  return files
    .filter((file) => distinct.get(file) > 0)
    .sort((a, b) => (distinct.get(b) - distinct.get(a)) || (total.get(b) - total.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Grep-baseline metrics for one case file. Recall and MRR follow the BM25 definitions (answerable cases only).
 * currentFirstRate covers current-state cases: category `current-state` or an `expectedHeading`; null when there are none.
 * unansweredReturnedRate: share of unanswerable cases where some term matches (grep then prints lines, i.e. "returns").
 * abstainAccuracy is 1 - unansweredReturnedRate (0 when there are no unanswerable cases); abstainN is the denominator.
 * @param {{corpusDir:string,casesFile:string,rg?:boolean}} options
 */
export function runGrepBaseline({corpusDir, casesFile, rg = false}) {
  const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('Invalid cases');
  let recall = 0, reciprocal = 0, answerable = 0, currentHits = 0, currentCases = 0, abstainN = 0, unanswered = 0;
  for (const item of cases) {
    const relevant = Array.isArray(item?.relevant) ? item.relevant : [];
    if (item?.abstain || !relevant.length) {
      // Grep has no abstention of its own: an unanswerable case counts as answered when some term matches a line.
      abstainN++;
      if (grepRanking(corpusDir, item?.query ?? '', {rg}).length) unanswered++;
      continue;
    }
    answerable++;
    const ranked = grepRanking(corpusDir, item.query, {rg});
    const top5 = ranked.slice(0, 5).filter((p) => relevant.includes(p)).length;
    recall += top5 / relevant.length;
    const rank = ranked.slice(0, 10).findIndex((p) => relevant.includes(p));
    reciprocal += rank < 0 ? 0 : 1 / (rank + 1);
    if (item.category === 'current-state' || typeof item.expectedHeading === 'string') {
      currentCases++;
      if (relevant.includes(ranked[0])) currentHits++;
    }
  }
  const recallAt5 = answerable ? recall / answerable : 0;
  return {
    n: cases.length,
    recallAt5,
    mrrAt10: answerable ? reciprocal / answerable : 0,
    currentFirstRate: currentCases ? currentHits / currentCases : null,
    currentCases,
    answerableRecallAt5: recallAt5,
    abstainN,
    unansweredReturnedRate: abstainN ? unanswered / abstainN : 0,
    abstainAccuracy: abstainN ? 1 - unanswered / abstainN : 0,
  };
}

function parseArgs(args) {
  const options = {rg: false};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rg') { options.rg = true; continue; }
    if (!['--corpus', '--cases'].includes(args[i]) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.corpus || !options.cases) throw new Error('Invalid arguments');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(runGrepBaseline({corpusDir: resolve(args.corpus), casesFile: resolve(args.cases), rg: args.rg})));
  } catch {
    console.error('Grep baseline failed');
    process.exitCode = 1;
  }
}
