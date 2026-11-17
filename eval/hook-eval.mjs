// SPDX-License-Identifier: MIT
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runHook } from '../packages/hooks/src/index.mjs';
import { buildIndex, loadPages, search } from '../packages/core/src/retrieval/index.mjs';
import { parseBlockHeading, parseInjectedPaths, summarizeHookRecords } from './lib/hook-records.mjs';
import { caseKind, isPoisonPage, loadMetaPredicate } from './lib/case-schema.mjs';

export const DEFAULT_NOW = '2026-11-10T00:00:00Z';
const MODES = new Set(['normal', 'economic']);

/**
 * Run the real hook (runHook with its retrieval worker) for every case and return per-case records.
 * Each case uses its own session id, so per-session dedup never leaks between cases.
 * A case's optional `cwd` is passed in the hook stdin; the product does not read it yet.
 * Record: {category, kind, cwd, abstain, relevant, excluded, injected, chars, durationMs, meta, poisoned, sectionHit, sectionSource}.
 * `meta` flags the first five injected pages (true for corpus meta pages). `poisoned` is true when an `eval_poison` page
 * was injected. `sectionHit` is set only for cases with `expectedHeading`: the first injected relevant block's heading line
 * is compared (sectionSource 'hook'); when that block has no heading line, the core search heading for the same query is
 * used instead (sectionSource 'search'). A case with no injected relevant block is a miss (sectionHit false).
 * BA-32: `disclosure` is `full` (default, the hook config is exactly as before) or `progressive`, which sets
 * `hooks.disclosure` in the hook config.
 * @param {{corpusDir:string,cases:object[],mode?:string,abstainThreshold?:number,disclosure?:string,now?:Date}} options
 */
export async function runHookCases({
  corpusDir,
  cases,
  mode = 'normal',
  abstainThreshold = 0.35,
  disclosure = 'full',
  now = new Date(DEFAULT_NOW),
}) {
  if (!MODES.has(mode)) throw new Error('Invalid mode');
  if (
    typeof abstainThreshold !== 'number' ||
    !Number.isFinite(abstainThreshold) ||
    abstainThreshold < 0 ||
    abstainThreshold > 1
  )
    throw new Error('Invalid abstain threshold');
  if (disclosure !== 'full' && disclosure !== 'progressive') throw new Error('Invalid disclosure');
  if (!Array.isArray(cases)) throw new Error('Invalid cases');
  const vaultDir = resolve(corpusDir);
  const pages = loadPages(vaultDir);
  const knownPaths = new Set(pages.map((page) => page.path));
  const poisonPaths = new Set(pages.filter((page) => isPoisonPage(page.frontmatter)).map((page) => page.path));
  const isMeta = loadMetaPredicate(vaultDir);
  let index = null;
  const stateDir = mkdtempSync(join(tmpdir(), 'ba-hook-eval-'));
  const config = {
    vault: { path: vaultDir },
    stateDir,
    hooks: { mode, deadlineMs: 4700, ...(disclosure === 'progressive' ? { disclosure: 'progressive' } : {}) },
    retrieval: { abstainThreshold },
  };
  const records = [];
  try {
    for (const [caseIndex, item] of cases.entries()) {
      const relevant = Array.isArray(item?.relevant) ? item.relevant.filter((p) => typeof p === 'string') : [];
      const abstain = Boolean(item?.abstain || !relevant.length);
      const category = typeof item?.category === 'string' ? item.category : 'uncategorized';
      const query = typeof item?.query === 'string' ? item.query : '';
      const cwd = typeof item?.cwd === 'string' ? item.cwd : null;
      const excluded = Array.isArray(item?.excluded) ? item.excluded.filter((p) => typeof p === 'string') : [];
      const stdinData = { session_id: `hook-eval-${caseIndex}`, prompt: query };
      if (cwd !== null) stdinData.cwd = cwd;
      const stdin = JSON.stringify(stdinData);
      const start = performance.now();
      const { stdout } = await runHook({ client: 'claude', event: 'prompt', stdin, env: {}, config, now });
      const durationMs = Math.max(0, performance.now() - start);
      let context = '';
      try {
        context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext || '';
      } catch {
        context = '';
      }
      const injected = parseInjectedPaths(context, knownPaths);
      let sectionHit = null,
        sectionSource = null;
      if (typeof item?.expectedHeading === 'string' && relevant.length && !abstain) {
        const first = injected.find((p) => relevant.includes(p));
        if (!first) sectionHit = false;
        else {
          let heading = parseBlockHeading(context, first);
          sectionSource = 'hook';
          if (heading === null) {
            sectionSource = 'search';
            index ||= buildIndex(pages, { now });
            heading =
              search(index, query, { limit: 10, asOf: now, abstainThreshold }).results.find((entry) =>
                relevant.includes(entry.path)
              )?.heading ?? null;
          }
          sectionHit = heading === item.expectedHeading;
        }
      }
      records.push({
        category,
        kind: caseKind(item),
        cwd,
        abstain,
        relevant,
        excluded,
        injected,
        chars: context.length,
        durationMs,
        meta: injected.slice(0, 5).map((p) => isMeta(p)),
        poisoned: injected.some((p) => poisonPaths.has(p)),
        sectionHit,
        sectionSource,
      });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  return records;
}

/**
 * Hook-level metrics for one corpus and one case file.
 * @param {{corpusDir:string,casesFile:string,mode?:string,abstainThreshold?:number,disclosure?:string,now?:Date}} options
 */
export async function runHookEval({ corpusDir, casesFile, ...rest }) {
  const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
  return summarizeHookRecords(await runHookCases({ corpusDir, cases, ...rest }));
}

function parseArgs(args) {
  const options = { json: false, mode: 'normal', abstainThreshold: 0.35, now: DEFAULT_NOW };
  const valueFlags = new Set(['--corpus', '--cases', '--mode', '--abstain-threshold', '--now']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    if (!valueFlags.has(flag) || i + 1 >= args.length || args[i + 1].startsWith('--'))
      throw new Error('Invalid arguments');
    const value = args[++i];
    if (flag === '--abstain-threshold') {
      if (!value.trim()) throw new Error('Invalid abstain threshold');
      options.abstainThreshold = Number(value);
    } else if (flag === '--corpus') options.corpusDir = value;
    else if (flag === '--cases') options.casesFile = value;
    else options[flag.slice(2)] = value;
  }
  if (!options.corpusDir || !options.casesFile) throw new Error('Invalid arguments');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runHookEval({
      corpusDir: args.corpusDir,
      casesFile: args.casesFile,
      mode: args.mode,
      abstainThreshold: args.abstainThreshold,
      now: new Date(args.now),
    });
    console.log(JSON.stringify(result, null, args.json ? 0 : 2));
  } catch {
    console.error('Hook eval failed');
    process.exitCode = 1;
  }
}
