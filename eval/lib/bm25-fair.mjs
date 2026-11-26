// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { buildIndex, loadPages, search } from '../../packages/core/src/retrieval/index.mjs';
import { reciprocalRank } from './metrics.mjs';

export function bm25Fair({ corpusDir, casesFile, now, abstainThreshold }) {
  const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('Invalid cases');
  const index = buildIndex(loadPages(corpusDir), { now });
  let answerable = 0,
    recall = 0,
    reciprocal = 0,
    abstainN = 0,
    abstained = 0,
    returned = 0;
  for (const item of cases) {
    const relevant = Array.isArray(item?.relevant) ? item.relevant : [];
    const abstain = Boolean(item?.abstain || !relevant.length);
    let result;
    try {
      result = search(index, item.query, { limit: 10, asOf: now, abstainThreshold });
    } catch {
      result = null;
    }
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
