// SPDX-License-Identifier: MIT
// BM25 side of the fair comparison with the grep baseline. Definitions match eval/run-eval.mjs (recall and MRR over
// answerable cases, abstainAccuracy over unanswerable cases) and eval/grep-baseline.mjs (unansweredReturnedRate).
// answerableRecallAt5 equals recallAt5 by definition; both are listed side by side with the grep numbers.
// unansweredReturnedRate: share of unanswerable cases where the search returns at least one page. abstainAccuracy is 0
// when a set has no unanswerable case (kept as runEval defines it); abstainN gives the denominator.
import { readFileSync } from 'node:fs';
import { buildIndex, loadPages, search } from '../../packages/core/src/retrieval/index.mjs';
import { reciprocalRank } from './metrics.mjs';

/**
 * @param {{corpusDir:string,casesFile:string,now:Date,abstainThreshold:number}} options
 */
export function bm25Fair({corpusDir, casesFile, now, abstainThreshold}) {
  const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('Invalid cases');
  const index = buildIndex(loadPages(corpusDir), {now});
  let answerable = 0, recall = 0, reciprocal = 0, abstainN = 0, abstained = 0, returned = 0;
  for (const item of cases) {
    const relevant = Array.isArray(item?.relevant) ? item.relevant : [];
    const abstain = Boolean(item?.abstain || !relevant.length);
    let result = null;
    try { result = search(index, item.query, {limit: 10, asOf: now, abstainThreshold}); } catch { result = null; }
    const results = result?.results || [];
    if (abstain) {
      abstainN++;
      if (result?.abstained) abstained++;
      if (results.length) returned++;
      continue;
    }
    answerable++;
    recall += results.slice(0, 5).filter((entry) => relevant.includes(entry.path)).length / relevant.length;
    reciprocal += reciprocalRank(results, relevant, 10);
  }
  const recallAt5 = answerable ? recall / answerable : 0;
  return {
    recallAt5,
    answerableRecallAt5: recallAt5,
    mrrAt10: answerable ? reciprocal / answerable : 0,
    abstainAccuracy: abstainN ? abstained / abstainN : 0,
    unansweredReturnedRate: abstainN ? returned / abstainN : 0,
    abstainN,
  };
}
