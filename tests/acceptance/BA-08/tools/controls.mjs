// SPDX-License-Identifier: MIT
// BA-08 holdout control check (brief step 3). Not part of npm test: it reads the PM holdout cases, which are not repository
// content. Usage: node tests/acceptance/BA-08/tools/controls.mjs <holdout/BA-v2 directory>
// For ctl-* cases and every trust case, the first result (path, score) and the abstain decision must equal main 6cac7a7.
import fs from 'node:fs';
import path from 'node:path';
import { loadMainRetrieval, dispose, loadWorktreeRetrieval, MAIN_COMMIT } from '../helpers/main-core.mjs';

const dir = process.argv[2];
if (!dir) { console.error('Usage: controls.mjs <holdout/BA-v2 directory>'); process.exit(2); }
const now = new Date('2026-11-10T00:00:00Z');
const opts = { limit: 10, abstainThreshold: 0.35, asOf: now };
const corpus = path.join(dir, 'corpus');
const cases = [
  ...JSON.parse(fs.readFileSync(path.join(dir, 'multihop-hard-cases.json'), 'utf8')).filter(c => c.id.startsWith('ctl-')).map(c => ({ ...c, set: 'multihop-hard' })),
  ...JSON.parse(fs.readFileSync(path.join(dir, 'trust-cases.json'), 'utf8')).map(c => ({ ...c, set: 'trust' })),
];

const main = await loadMainRetrieval();
try {
  const wt = await loadWorktreeRetrieval();
  const mIdx = main.retrieval.buildIndex(main.retrieval.loadPages(corpus), { now });
  const wIdx = wt.buildIndex(wt.loadPages(corpus), { now });
  let mismatches = 0;
  const rows = cases.map(c => {
    const m = main.retrieval.search(mIdx, c.query, opts);
    const w = wt.search(wIdx, c.query, opts);
    const firstMain = m.results[0] ? { path: m.results[0].path, score: m.results[0].score } : null;
    const firstWt = w.results[0] ? { path: w.results[0].path, score: w.results[0].score } : null;
    const same = m.abstained === w.abstained && m.reason === w.reason && JSON.stringify(firstMain) === JSON.stringify(firstWt);
    if (!same) mismatches++;
    const linkedRows = w.results.filter(r => r.via === 'link').length;
    return { id: c.id, set: c.set, same, abstainMain: m.abstained, abstainWt: w.abstained, firstMain, firstWt, linkedRowsInTop10: linkedRows };
  });
  const summary = {
    commit: MAIN_COMMIT,
    checked: rows.length,
    ctl: rows.filter(r => r.id.startsWith('ctl-')).length,
    trust: rows.filter(r => r.set === 'trust').length,
    firstResultMismatches: mismatches,
    trustRowsWithLinkedResults: rows.filter(r => r.set === 'trust' && r.linkedRowsInTop10 > 0).map(r => r.id),
    ctlRowsWithLinkedResults: rows.filter(r => r.id.startsWith('ctl-') && r.linkedRowsInTop10 > 0).map(r => r.id),
  };
  console.log(JSON.stringify({ summary, rows }, null, 2));
  process.exitCode = mismatches === 0 ? 0 : 1;
} finally {
  dispose(main.dir);
}
