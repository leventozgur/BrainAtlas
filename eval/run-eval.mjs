// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, loadPages, search } from '../packages/core/src/retrieval/index.mjs';

export function runEval({corpusDir, casesFile, now = new Date()}) {
  const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('Invalid cases');
  const index = buildIndex(loadPages(corpusDir), {now});
  let recall = 0, precision = 0, answerable = 0, abstainRight = 0, abstainCount = 0, trRecall = 0, trCount = 0;
  for (const item of cases) {
    const relevant = item.relevant || []; const result = search(index,item.query,{limit:5,asOf:now});
    const hits = result.results.filter(r => relevant.includes(r.path)).length;
    if (item.abstain || !relevant.length) { abstainCount++; if (result.abstained) abstainRight++; }
    else { answerable++; recall += hits / relevant.length; precision += hits / 5; if (item.trToEn) { trCount++; trRecall += hits / relevant.length; } }
  }
  return {recallAt5: answerable ? recall / answerable : 0, precisionAt5: answerable ? precision / answerable : 0, abstainAccuracy: abstainCount ? abstainRight / abstainCount : 0, trToEnRecallAt5: trCount ? trRecall / trCount : 0, n:cases.length};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const arg = name => { const i=args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
  const base = fileURLToPath(new URL('.', import.meta.url));
  const result = runEval({corpusDir:arg('--corpus') || resolve(base,'corpus'), casesFile:arg('--cases') || resolve(base,'dev/cases.json'), now:arg('--now') ? new Date(arg('--now')) : new Date()});
  console.log(JSON.stringify(result,null,2));
}
