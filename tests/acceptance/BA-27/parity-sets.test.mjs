// SPDX-License-Identifier: MIT
// BA-27 independent acceptance (parity, determinism, set validity). Written from the brief only.
// The main-checkout comparisons skip themselves once main carries BA-27 (its ba-suite then has the new keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KINDS, validateCase } from '../../../eval/lib/case-schema.mjs';
import { runGrepBaseline } from '../../../eval/grep-baseline.mjs';
import { runBaSuite } from '../../../eval/ba-suite.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');
const EVAL = join(ROOT, 'eval');
const dirs = [];
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (prefix) => { const d = mkdtempSync(join(tmpdir(), `ba27-${prefix}-`)); dirs.push(d); return d; };
const skipHolder = (src) => !src.startsWith(join(EVAL, 'holdout'));

function walkFiles(root, base = root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

const TIMING = new Set(['latencyMs', 'indexBuildMs', 'durationMs']);
const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (TIMING.has(k) ? undefined : x)));
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// ---------- determinism of the dev generators ----------

test('BA-27 determinism: re-running eval/gen/dev-corpora.mjs and longpage.mjs in a copy reproduces every eval file byte for byte', () => {
  const work = tempDir('gen');
  const copy = join(work, 'eval');
  cpSync(EVAL, copy, { recursive: true, filter: skipHolder });
  for (const gen of ['dev-corpora.mjs', 'longpage.mjs']) {
    const r = spawnSync(process.execPath, [join(copy, 'gen', gen)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${gen}: ${r.stderr}`);
  }
  const mine = walkFiles(EVAL).filter((p) => !p.startsWith('holdout/'));
  const theirs = walkFiles(copy).filter((p) => !p.startsWith('holdout/'));
  assert.deepEqual(theirs, mine, 'same file set');
  for (const rel of mine) {
    assert.ok(Buffer.compare(readFileSync(join(EVAL, rel)), readFileSync(join(copy, rel))) === 0, `${rel} differs after regeneration`);
  }
});

test('BA-27 determinism: grep baseline on each new dev set is identical across two runs', () => {
  const sets = [['corpus-hook-realistic', 'hook-realistic-cases.json'], ['corpus-longpage', 'longpage-cases.json'], ['corpus-temporal', 'temporal-cases.json'], ['corpus-poison', 'poison-cases.json']];
  for (const [corpus, cases] of sets) {
    const a = runGrepBaseline({ corpusDir: join(EVAL, corpus), casesFile: join(EVAL, 'dev', cases) });
    const b = runGrepBaseline({ corpusDir: join(EVAL, corpus), casesFile: join(EVAL, 'dev', cases) });
    assert.deepEqual(a, b, corpus);
  }
  const rd = runGrepBaseline({ corpusDir: join(ROOT, 'docs'), casesFile: join(EVAL, 'dev', 'realdocs-cases.json') });
  assert.deepEqual(rd, runGrepBaseline({ corpusDir: join(ROOT, 'docs'), casesFile: join(EVAL, 'dev', 'realdocs-cases.json') }), 'realDocs');
});

// ---------- schema validity of every case in the five new dev sets (independent of the developer validator) ----------

function corpusPages(dir) {
  const map = new Map();
  for (const rel of walkFiles(dir)) if (rel.endsWith('.md')) map.set(rel, { body: readFileSync(join(dir, rel), 'utf8') });
  return map;
}

const NEW_SETS = [
  { name: 'hookRealistic', corpus: join(EVAL, 'corpus-hook-realistic'), cases: join(EVAL, 'dev', 'hook-realistic-cases.json'), n: 72 },
  { name: 'longpage', corpus: join(EVAL, 'corpus-longpage'), cases: join(EVAL, 'dev', 'longpage-cases.json'), n: 39 },
  { name: 'temporal', corpus: join(EVAL, 'corpus-temporal'), cases: join(EVAL, 'dev', 'temporal-cases.json'), n: 25 },
  { name: 'poison', corpus: join(EVAL, 'corpus-poison'), cases: join(EVAL, 'dev', 'poison-cases.json'), n: 26 },
  { name: 'realDocs', corpus: join(ROOT, 'docs'), cases: join(EVAL, 'dev', 'realdocs-cases.json'), n: 75 },
];

for (const set of NEW_SETS) {
  test(`BA-27 set validity: every ${set.name} case passes validateCase; ids unique; counts as documented`, () => {
    const cases = JSON.parse(readFileSync(set.cases, 'utf8'));
    assert.equal(cases.length, set.n);
    const paths = corpusPages(set.corpus);
    const projects = new Set(walkFiles(set.corpus).filter((p) => p.includes('/')).map((p) => p.split('/')[0]));
    const ids = new Set();
    for (const item of cases) {
      validateCase(item, { paths, projects: set.name === 'realDocs' ? null : projects });
      assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
      ids.add(item.id);
      assert.ok(KINDS.includes(item.kind ?? 'knowledge'));
    }
  });
}

test('BA-27 set validity: hookRealistic has 72 cases with the documented kind mix', () => {
  const cases = JSON.parse(readFileSync(join(EVAL, 'dev', 'hook-realistic-cases.json'), 'utf8'));
  const count = (k) => cases.filter((c) => (c.kind ?? 'knowledge') === k).length;
  assert.deepEqual(['knowledge', 'operational', 'followup', 'long-brief', 'pasted-error'].map(count), [24, 22, 10, 8, 8]);
  assert.ok(cases.filter((c) => c.kind === 'operational').every((c) => c.abstain === true));
});

// ---------- parity with main (skips once main carries BA-27) ----------

const OLD_KEYS = ['cases', 'xling', 'identifier', 'currentState', 'multihop', 'nearNegative'];
const mainRoot = (() => {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return dirname(resolve(ROOT, common));
  } catch { return null; }
})();
const mainSuiteFile = mainRoot ? join(mainRoot, 'eval', 'ba-suite.mjs') : null;
const mainSource = mainSuiteFile && existsSync(mainSuiteFile) ? readFileSync(mainSuiteFile, 'utf8') : null;
const mainHasBa27 = mainSource ? mainSource.includes('hookRealistic') : true;

test('BA-27 parity: the six unchanged BM25 sets equal main (times excluded); natural and hook differ only by the label hygiene, proven both ways', async (t) => {
  if (!mainSource) return t.skip('main checkout or its ba-suite not found');
  if (mainHasBa27) return t.skip('main already carries BA-27 keys; compare against the pre-BA-27 snapshot instead');
  const { runBaSuite: runMain } = await import(pathToFileURL(mainSuiteFile).href);
  const cand = strip(await runBaSuite());
  const main = strip(await runMain());
  for (const key of OLD_KEYS) assert.deepEqual(cand[key], main[key], `${key} differs from main`);

  const mainHookKeys = Object.keys(main.hook);
  // Proof A: the candidate evaluator with main's natural labels equals main on natural and on the old hook keys.
  const copyA = join(tempDir('proofA'), 'root');
  cpSync(EVAL, join(copyA, 'eval'), { recursive: true, filter: skipHolder });
  cpSync(join(ROOT, 'packages'), join(copyA, 'packages'), { recursive: true });
  cpSync(join(ROOT, 'modules'), join(copyA, 'modules'), { recursive: true });
  cpSync(join(ROOT, 'docs'), join(copyA, 'docs'), { recursive: true });
  cpSync(join(mainRoot, 'eval', 'dev', 'natural-cases.json'), join(copyA, 'eval', 'dev', 'natural-cases.json'));
  const candOld = strip(await runBaSuite({ sourceRoot: join(copyA, 'eval') }));
  assert.deepEqual(candOld.natural, main.natural, 'proof A natural');
  assert.deepEqual(pick(candOld.hook, mainHookKeys), main.hook, 'proof A hook (old keys)');

  // Proof B: main's evaluator with the candidate's natural labels equals the candidate on natural and old hook keys.
  const copyB = join(tempDir('proofB'), 'eval');
  cpSync(join(mainRoot, 'eval'), copyB, { recursive: true, filter: (src) => !src.startsWith(join(mainRoot, 'eval', 'holdout')) });
  cpSync(join(EVAL, 'dev', 'natural-cases.json'), join(copyB, 'dev', 'natural-cases.json'));
  const mainNew = strip(await runMain({ sourceRoot: copyB }));
  assert.deepEqual(mainNew.natural, cand.natural, 'proof B natural');
  assert.deepEqual(pick(cand.hook, mainHookKeys), mainNew.hook, 'proof B hook (old keys)');
});

test('BA-27 label hygiene: exactly the 11 documented natural cases changed; each old label is superseded and points to its replacement', () => {
  const now = JSON.parse(readFileSync(join(EVAL, 'dev', 'natural-cases.json'), 'utf8'));
  const changed = now.filter((c) => c.relevantLegacy);
  assert.equal(changed.length, 11);
  for (const c of changed) {
    assert.equal(c.relevantLegacy.length, 1);
    const legacy = readFileSync(join(EVAL, 'corpus-natural', c.relevantLegacy[0]), 'utf8');
    assert.match(legacy, /^status: "superseded"$/mu, `${c.id} legacy page is superseded`);
    assert.match(legacy, new RegExp(`^superseded_by: "${c.relevant[0]}"$`, 'mu'), `${c.id} superseded_by points at relevant`);
  }
});
