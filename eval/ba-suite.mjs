// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runEval } from './run-eval.mjs';
import { DEFAULT_NOW, runHookCases } from './hook-eval.mjs';
import { summarizeHookRecords } from './lib/hook-records.mjs';
import { runGrepBaseline } from './grep-baseline.mjs';
import { bm25Fair } from './lib/bm25-fair.mjs';
import { runScaleBench } from './scale-bench.mjs';

const evalRoot = fileURLToPath(new URL('.', import.meta.url));
const SET_THRESHOLD = 0.35;
const HOLDOUT_SETS = {
  identifier: 'identifier-cases.json',
  currentState: 'current-state-cases.json',
  multihop: 'multihop-cases.json',
  nearNegative: 'near-negative-cases.json',
};
const NEW_SETS = {
  hookRealistic: { corpus: 'corpus-hook-realistic', cases: 'hook-realistic-cases.json' },
  longpage: { corpus: 'corpus-longpage', cases: 'longpage-cases.json' },
  temporal: { corpus: 'corpus-temporal', cases: 'temporal-cases.json' },
  poison: { corpus: 'corpus-poison', cases: 'poison-cases.json' },
  realDocs: { corpus: null, cases: 'realdocs-cases.json' },
};

function gitCommit(cwd) {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  const value = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return result.status === 0 && /^[0-9a-f]{4,40}$/u.test(value) ? value : 'unknown';
}

const readCases = (file) => JSON.parse(readFileSync(file, 'utf8'));

export async function runBaSuite({
  sourceRoot = evalRoot,
  holdoutDir,
  scale = false,
  now = new Date(DEFAULT_NOW),
  scaleOptions = {},
  docsDir = resolve(evalRoot, '..', 'docs'),
} = {}) {
  const root = resolve(sourceRoot);
  const corpus = (name) => resolve(root, name);
  const dev = (name) => resolve(root, 'dev', name);
  const newSetSources = Object.fromEntries(
    Object.entries(HOLDOUT_SETS).map(([key, file]) => [
      key,
      holdoutDir
        ? { corpusDir: resolve(holdoutDir, 'corpus'), casesFile: resolve(holdoutDir, file) }
        : { corpusDir: corpus('corpus-ba'), casesFile: dev(file) },
    ])
  );
  const bm25 = (corpusDir, casesFile) =>
    runEval({ corpusDir, casesFile, now, repeat: 1, abstainThreshold: SET_THRESHOLD, extended: true });

  const naturalSource = { corpusDir: corpus('corpus-natural'), casesFile: dev('natural-cases.json') };
  const xlingSource = { corpusDir: corpus('corpus-natural'), casesFile: dev('xling-cases.json') };
  const sources = {
    cases: { corpusDir: corpus('corpus'), casesFile: dev('cases.json') },
    natural: naturalSource,
    xling: xlingSource,
    identifier: newSetSources.identifier,
    currentState: newSetSources.currentState,
    multihop: newSetSources.multihop,
    nearNegative: newSetSources.nearNegative,
  };
  for (const [key, spec] of Object.entries(NEW_SETS)) {
    if (!holdoutDir)
      sources[key] = {
        corpusDir: spec.corpus === null ? resolve(docsDir) : corpus(spec.corpus),
        casesFile: dev(spec.cases),
      };
    else
      sources[key] = existsSync(resolve(holdoutDir, key))
        ? { corpusDir: resolve(holdoutDir, key, 'corpus'), casesFile: resolve(holdoutDir, key, 'cases.json') }
        : null;
  }
  const requireFile = (source) => {
    if (!existsSync(source.casesFile)) throw new Error('Missing case file');
  };

  const hookRecords = [];
  for (const source of [naturalSource, ...Object.values(newSetSources)]) {
    requireFile(source);
    hookRecords.push(
      ...(await runHookCases({
        corpusDir: source.corpusDir,
        cases: readCases(source.casesFile),
        mode: 'normal',
        abstainThreshold: SET_THRESHOLD,
        now,
      }))
    );
  }
  const bm25Set = (key) => {
    const source = sources[key];
    requireFile(source);
    return bm25(source.corpusDir, source.casesFile);
  };
  const newSet = async (key) => {
    const source = sources[key];
    if (!source) return null;
    requireFile(source);
    const cases = readCases(source.casesFile);
    const records = await runHookCases({
      corpusDir: source.corpusDir,
      cases,
      mode: 'normal',
      abstainThreshold: SET_THRESHOLD,
      now,
    });
    return { n: cases.length, bm25: bm25(source.corpusDir, source.casesFile), hook: summarizeHookRecords(records) };
  };
  const grepSet = (key) => {
    const source = sources[key];
    if (!source) return null;
    requireFile(source);
    const bm25Both = {
      atThreshold: bm25Fair({
        corpusDir: source.corpusDir,
        casesFile: source.casesFile,
        now,
        abstainThreshold: SET_THRESHOLD,
      }),
      noAbstain: bm25Fair({ corpusDir: source.corpusDir, casesFile: source.casesFile, now, abstainThreshold: 0 }),
    };
    return { ...runGrepBaseline({ corpusDir: source.corpusDir, casesFile: source.casesFile }), bm25: bm25Both };
  };

  const newResults = {};
  for (const key of Object.keys(NEW_SETS)) newResults[key] = await newSet(key);
  const grepKeys = [
    'cases',
    'natural',
    'xling',
    'identifier',
    'currentState',
    'multihop',
    'nearNegative',
    ...Object.keys(NEW_SETS),
  ];

  const suite = {
    cases: bm25Set('cases'),
    natural: bm25Set('natural'),
    xling: bm25Set('xling'),
    identifier: bm25Set('identifier'),
    currentState: bm25Set('currentState'),
    multihop: bm25Set('multihop'),
    nearNegative: bm25Set('nearNegative'),
    hook: summarizeHookRecords(hookRecords),
    hookRealistic: newResults.hookRealistic,
    longpage: newResults.longpage,
    temporal: newResults.temporal,
    poison: newResults.poison,
    realDocs: newResults.realDocs,
    grepBaseline: Object.fromEntries(grepKeys.map((key) => [key, grepSet(key)])),
    scale: scale ? await runScaleBench({ now, ...scaleOptions }) : null,
    meta: {
      commit: gitCommit(evalRoot),
      date: now.toISOString().slice(0, 10),
      node: process.version,
      holdout: Boolean(holdoutDir),
    },
  };
  return suite;
}

function parseArgs(args) {
  const options = { scale: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--scale') {
      options.scale = true;
      continue;
    }
    if (!['--out', '--holdout-dir', '--now'].includes(flag) || i + 1 >= args.length || args[i + 1].startsWith('--'))
      throw new Error('Invalid arguments');
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
    const suite = await runBaSuite({
      holdoutDir: args.holdoutDir ? resolve(args.holdoutDir) : undefined,
      scale: args.scale,
      now,
    });
    writeFileSync(resolve(args.out), `${JSON.stringify(suite, null, 2)}\n`, 'utf8');
    console.log('BA suite written');
  } catch {
    console.error('BA suite failed');
    process.exitCode = 1;
  }
}
