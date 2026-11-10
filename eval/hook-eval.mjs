// SPDX-License-Identifier: MIT
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runHook } from '../packages/hooks/src/index.mjs';
import { loadPages } from '../packages/core/src/retrieval/index.mjs';
import { parseInjectedPaths, summarizeHookRecords } from './lib/hook-records.mjs';

export const DEFAULT_NOW = '2026-11-10T00:00:00Z';
const MODES = new Set(['normal', 'economic']);

/**
 * Run the real hook (runHook with its retrieval worker) for every case and return per-case records.
 * Each case uses its own session id, so per-session dedup never leaks between cases.
 * @param {{corpusDir:string,cases:object[],mode?:string,abstainThreshold?:number,now?:Date}} options
 * @returns {Promise<Array<{category:string,abstain:boolean,relevant:string[],injected:string[],chars:number,durationMs:number}>>}
 */
export async function runHookCases({corpusDir, cases, mode = 'normal', abstainThreshold = 0.35, now = new Date(DEFAULT_NOW)}) {
  if (!MODES.has(mode)) throw new Error('Invalid mode');
  if (typeof abstainThreshold !== 'number' || !Number.isFinite(abstainThreshold) || abstainThreshold < 0 || abstainThreshold > 1) throw new Error('Invalid abstain threshold');
  if (!Array.isArray(cases)) throw new Error('Invalid cases');
  const vaultDir = resolve(corpusDir);
  const knownPaths = new Set(loadPages(vaultDir).map((page) => page.path));
  const stateDir = mkdtempSync(join(tmpdir(), 'ba-hook-eval-'));
  const config = {vault: {path: vaultDir}, stateDir, hooks: {mode, deadlineMs: 4700}, retrieval: {abstainThreshold}};
  const records = [];
  try {
    for (const [index, item] of cases.entries()) {
      const relevant = Array.isArray(item?.relevant) ? item.relevant.filter((p) => typeof p === 'string') : [];
      const abstain = Boolean(item?.abstain || !relevant.length);
      const category = typeof item?.category === 'string' ? item.category : 'uncategorized';
      const query = typeof item?.query === 'string' ? item.query : '';
      const stdin = JSON.stringify({session_id: `hook-eval-${index}`, prompt: query});
      const start = performance.now();
      const {stdout} = await runHook({client: 'claude', event: 'prompt', stdin, env: {}, config, now});
      const durationMs = Math.max(0, performance.now() - start);
      let context = '';
      try { context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext || ''; } catch { context = ''; }
      records.push({
        category,
        abstain,
        relevant,
        injected: parseInjectedPaths(context, knownPaths),
        chars: context.length,
        durationMs,
      });
    }
  } finally {
    rmSync(stateDir, {recursive: true, force: true});
  }
  return records;
}

/**
 * Hook-level metrics for one corpus and one case file.
 * @param {{corpusDir:string,casesFile:string,mode?:string,abstainThreshold?:number,now?:Date}} options
 */
export async function runHookEval({corpusDir, casesFile, ...rest}) {
  const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
  return summarizeHookRecords(await runHookCases({corpusDir, cases, ...rest}));
}

function parseArgs(args) {
  const options = {json: false, mode: 'normal', abstainThreshold: 0.35, now: DEFAULT_NOW};
  const valueFlags = new Set(['--corpus', '--cases', '--mode', '--abstain-threshold', '--now']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { options.json = true; continue; }
    if (!valueFlags.has(flag) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
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
