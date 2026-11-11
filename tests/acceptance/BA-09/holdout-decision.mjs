// SPDX-License-Identifier: MIT
// BA-09 holdout decision measurements (not a node:test file, so `npm test` does not run it). Prints JSON only; writes nothing.
// Usage: node tests/acceptance/BA-09/holdout-decision.mjs <pm-dir> <main-repo-dir>
// Items: 1 primary (rival trust cases, first result relevant, threshold 0.35), 2 neutral controls (first result same as main),
// 4 multihop-hard requireAll rate. Items 3 (ba-suite + gate) and 5 (scale-bench) are run from the command line, see the report.
import fs from 'node:fs';
import path from 'node:path';
import { loadCandidate, loadMain, repoRoot, NOW } from './helpers.mjs';

const [PM, MAIN_ROOT] = process.argv.slice(2);
if (!PM || !MAIN_ROOT) { console.error('Usage: holdout-decision.mjs <pm-dir> <main-repo-dir>'); process.exit(2); }
const BA_V2 = path.join(PM, 'holdout/BA-v2');
const cases = JSON.parse(fs.readFileSync(path.join(BA_V2, 'trust-cases.json'), 'utf8'));
const cand = await loadCandidate();
const main = await loadMain();

function primaryFor(lib) {
  const index = lib.buildIndex(lib.loadPages(path.join(BA_V2, 'corpus')), { now: NOW });
  const rows = cases.filter((c) => Array.isArray(c.excluded) && c.excluded.length);
  const controls = cases.filter((c) => !c.excluded || c.excluded.length === 0);
  const top1 = rows.filter((c) => {
    const r = lib.search(index, c.query, { limit: 10, abstainThreshold: 0.35, asOf: NOW });
    return r.results[0] && c.relevant.includes(r.results[0].path);
  }).length;
  const controlTop = Object.fromEntries(controls.map((c) => {
    const r = lib.search(index, c.query, { limit: 10, abstainThreshold: 0.35, asOf: NOW });
    return [c.id, { path: r.results[0]?.path ?? null, score: r.results[0]?.score ?? null, trust: r.results[0]?.trust ?? null }];
  }));
  const rivalTop = Object.fromEntries(rows.map((c) => {
    const r = lib.search(index, c.query, { limit: 10, abstainThreshold: 0.35, asOf: NOW });
    return [c.id, { path: r.results[0]?.path ?? null, trust: r.results[0]?.trust ?? null }];
  }));
  return { rivalCases: rows.length, top1Relevant: top1, controlTop, rivalTop };
}

const out = { primary: { main: primaryFor(main.retrieval), candidate: primaryFor(cand) } };
const controlsSame = Object.keys(out.primary.main.controlTop).every((id) => {
  const a = out.primary.main.controlTop[id], b = out.primary.candidate.controlTop[id];
  return a.path === b.path && a.score === b.score;
});
out.controlsIdenticalFirstResult = controlsSame;

// Item 4 uses the repository's eval runner; main is imported from the main repository and the candidate from this worktree.
for (const [name, root] of [['main', MAIN_ROOT], ['candidate', repoRoot]]) {
  const { runEval } = await import(path.join(root, 'eval/run-eval.mjs'));
  const r = await runEval({ corpusDir: path.join(BA_V2, 'corpus'), casesFile: path.join(BA_V2, 'multihop-hard-cases.json'), now: NOW, repeat: 1, abstainThreshold: 0.35, extended: true });
  out[`multihopHard_${name}`] = { requireAllRate: r.requireAllRate, recallAt5: r.recallAt5, mrrAt10: r.mrrAt10 };
}
main.dispose();
console.log(JSON.stringify(out, null, 2));
