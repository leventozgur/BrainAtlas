// SPDX-License-Identifier: MIT
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runEval } from '../../../eval/run-eval.mjs';
import { loadPages } from '../../../packages/core/src/retrieval/index.mjs';
import { markdownChunks } from './chunking.mjs';
import { buildSemanticIndex } from './index-store.mjs';
import { searchHybrid } from './hybrid.mjs';

/** Compare lexical and hybrid dev metrics; this result alone never enables the module. */
export async function semanticGate({ devCases, corpusDir, provider }) {
  if (!Array.isArray(devCases) || typeof corpusDir !== 'string' || !provider) throw new TypeError('Invalid semantic evaluation input.');
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'brainatlas-semantic-eval-'));
  try {
    const casesFile = path.join(temporaryDir, 'cases.json');
    await writeFile(casesFile, JSON.stringify(devCases), { mode: 0o600 });
    const lexical = runEval({ corpusDir, casesFile });
    const pages = loadPages(corpusDir);
    const index = await buildSemanticIndex({ corpusDir, stateDir: path.join(temporaryDir, 'state'), provider, chunkMarkdown: markdownChunks });
    let trHits = 0, trTotal = 0, hits = 0, answerable = 0;
    for (const item of devCases) {
      const relevant = Array.isArray(item?.relevant) ? item.relevant : [];
      if (!relevant.length || item?.abstain) continue;
      const results = await searchHybrid({ query: item.query, pages, entries: index.entries, provider, limit: 5 });
      const found = results.filter((result) => relevant.includes(result.path)).length;
      hits += found / 5;
      answerable++;
      if (item.trToEn) { trHits += found / relevant.length; trTotal++; }
    }
    const hybridPrecision = answerable ? hits / answerable : 0;
    const hybridTrRecall = trTotal ? trHits / trTotal : 0;
    const trToEnDelta = hybridTrRecall - lexical.trToEnRecallAt5;
    const precisionDelta = hybridPrecision - lexical.precisionAt5;
    return { enable: trToEnDelta >= 0.10 && precisionDelta >= -0.05, trToEnDelta, precisionDelta };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}
