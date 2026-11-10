// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runEval } from './run-eval.mjs';
import { DEFAULT_NOW, runHookCases } from './hook-eval.mjs';
import { summarizeHookRecords } from './lib/hook-records.mjs';
import { runScaleBench } from './scale-bench.mjs';

const evalRoot = fileURLToPath(new URL('.', import.meta.url));
const SET_THRESHOLD = 0.35;
const HOLDOUT_SETS = {identifier: 'identifier-cases.json', currentState: 'current-state-cases.json', multihop: 'multihop-cases.json', nearNegative: 'near-negative-cases.json'};

function gitCommit(cwd) {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {cwd, encoding: 'utf8'});
  const value = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return result.status === 0 && /^[0-9a-f]{4,40}$/u.test(value) ? value : 'unknown';
}

/**
 * Run every BM25 set, the hook-level evaluation and optionally the scale benchmark; return one JSON-ready object.
 * `sourceRoot` is the eval directory (defaults to this one). `holdoutDir` replaces the four new sets and their corpus only.
 * @param {{sourceRoot?:string,holdoutDir?:string,scale?:boolean,now?:Date,scaleOptions?:object}} options
 */
export async function runBaSuite({sourceRoot = evalRoot, holdoutDir, scale = false, now = new Date(DEFAULT_NOW), scaleOptions = {}} = {}) {
  const root = resolve(sourceRoot);
  const corpus = (name) => resolve(root, name);
  const dev = (name) => resolve(root, 'dev', name);
  const newSetSources = Object.fromEntries(Object.entries(HOLDOUT_SETS).map(([key, file]) => [key, holdoutDir
    ? {corpusDir: resolve(holdoutDir, 'corpus'), casesFile: resolve(holdoutDir, file)}
    : {corpusDir: corpus('corpus-ba'), casesFile: dev(file)}]));
  const bm25 = (corpusDir, casesFile) => runEval({corpusDir, casesFile, now, repeat: 1, abstainThreshold: SET_THRESHOLD, extended: true});

  const naturalSource = {corpusDir: corpus('corpus-natural'), casesFile: dev('natural-cases.json')};
  const readCases = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const hookRecords = [];
  for (const source of [naturalSource, ...Object.values(newSetSources)]) {
    if (!existsSync(source.casesFile)) throw new Error('Missing case file');
    hookRecords.push(...await runHookCases({corpusDir: source.corpusDir, cases: readCases(source.casesFile), mode: 'normal', abstainThreshold: SET_THRESHOLD, now}));
  }

  const suite = {
    cases: bm25(corpus('corpus'), dev('cases.json')),
    natural: bm25(naturalSource.corpusDir, naturalSource.casesFile),
    xling: bm25(corpus('corpus-natural'), dev('xling-cases.json')),
    identifier: bm25(newSetSources.identifier.corpusDir, newSetSources.identifier.casesFile),
    currentState: bm25(newSetSources.currentState.corpusDir, newSetSources.currentState.casesFile),
    multihop: bm25(newSetSources.multihop.corpusDir, newSetSources.multihop.casesFile),
    nearNegative: bm25(newSetSources.nearNegative.corpusDir, newSetSources.nearNegative.casesFile),
    hook: summarizeHookRecords(hookRecords),
    scale: scale ? await runScaleBench({now, ...scaleOptions}) : null,
    meta: {commit: gitCommit(evalRoot), date: now.toISOString().slice(0, 10), node: process.version, holdout: Boolean(holdoutDir)},
  };
  return suite;
}

function parseArgs(args) {
  const options = {scale: false};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--scale') { options.scale = true; continue; }
    if (!['--out', '--holdout-dir', '--now'].includes(flag) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    const value = args[++i];
    if (flag === '--out') options.out = value;
    else if (flag === '--holdout-dir') options.holdoutDir = value;
    else options.now = value;
  }
  if (!options.out) throw new Error('Invalid arguments');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const now = args.now ? new Date(args.now) : new Date(DEFAULT_NOW);
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid now');
    const suite = await runBaSuite({holdoutDir: args.holdoutDir ? resolve(args.holdoutDir) : undefined, scale: args.scale, now});
    writeFileSync(resolve(args.out), `${JSON.stringify(suite, null, 2)}\n`, 'utf8');
    console.log('BA suite written');
  } catch {
    console.error('BA suite failed');
    process.exitCode = 1;
  }
}
