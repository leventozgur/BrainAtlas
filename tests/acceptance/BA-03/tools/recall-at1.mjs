// SPDX-License-Identifier: MIT
// BA-03 independent measurement: identifier holdout recall@1 (answerable cases) for one code root.
// Usage: node recall-at1.mjs <repoRoot> <holdoutDir>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const [repoRoot, holdoutDir] = process.argv.slice(2);
if (!repoRoot || !holdoutDir) { console.error('usage: recall-at1.mjs <repoRoot> <holdoutDir>'); process.exit(2); }
const mod = await import(pathToFileURL(path.resolve(repoRoot, 'packages/core/src/retrieval/index.mjs')).href);
const { buildIndex, search, loadPages } = mod;
const corpus = path.resolve(holdoutDir, 'corpus');
const cases = JSON.parse(fs.readFileSync(path.resolve(holdoutDir, 'identifier-cases.json'), 'utf8'));
const index = buildIndex(loadPages(corpus), { now: new Date('2026-11-11T00:00:00Z') });
const now = new Date('2026-11-11T00:00:00Z');
let answerable = 0, hit1 = 0, abstainCases = 0, abstainOk = 0, hitAny10 = 0;
const misses = [];
for (const c of cases) {
  const r = search(index, c.query, { limit: 10, abstainThreshold: 0.35, asOf: now });
  if (c.abstain) {
    abstainCases++;
    if (r.abstained) abstainOk++; else misses.push({ id: c.id, kind: 'abstain-miss', got: r.results[0]?.path });
    continue;
  }
  if (!c.relevant || !c.relevant.length) continue;
  answerable++;
  const top = r.abstained ? null : r.results[0]?.path;
  if (top && c.relevant.includes(top)) hit1++; else misses.push({ id: c.id, kind: 'rank1', got: top, abstained: r.abstained, reason: r.reason });
  if (!r.abstained && r.results.some(x => c.relevant.includes(x.path))) hitAny10++;
}
console.log(JSON.stringify({ repoRoot, cases: cases.length, answerable, recallAt1: hit1 / answerable, hitAt10: hitAny10 / answerable, abstainCases, abstainCorrect: abstainOk, abstainAccuracy: abstainCases ? abstainOk / abstainCases : null, misses }, null, 2));
