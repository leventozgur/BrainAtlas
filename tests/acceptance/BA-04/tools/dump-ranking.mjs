// SPDX-License-Identifier: MIT
// BA-04 tester-owned golden generator. Usage: node dump-ranking.mjs <repoRoot> > fixture.json
// Runs buildIndex/search over every eval/dev set (same corpora, query ids and options as the BA-03 parity set) and records,
// per query, the ranking (path, score), abstain state and reason, and the section fields. Snippets are stored as SHA-256
// digests only, so the fixture holds no page text. Deterministic: no timestamps, no absolute paths.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(process.argv[2] || '.');
const retrieval = await import(pathToFileURL(path.join(repo, 'packages/core/src/retrieval/index.mjs')).href);
const now = new Date('2026-11-11T00:00:00Z');
const SETS = [
  ['cases', 'eval/corpus', 'eval/dev/cases.json'],
  ['natural', 'eval/corpus-natural', 'eval/dev/natural-cases.json'],
  ['xling', 'eval/corpus-natural', 'eval/dev/xling-cases.json'],
  ['identifier', 'eval/corpus-ba', 'eval/dev/identifier-cases.json'],
  ['currentState', 'eval/corpus-ba', 'eval/dev/current-state-cases.json'],
  ['multihop', 'eval/corpus-ba', 'eval/dev/multihop-cases.json'],
  ['nearNegative', 'eval/corpus-ba', 'eval/dev/near-negative-cases.json'],
];
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const indexes = new Map();
const indexFor = (corpus) => { if (!indexes.has(corpus)) indexes.set(corpus, retrieval.buildIndex(retrieval.loadPages(path.join(repo, corpus)), { now })); return indexes.get(corpus); };
const out = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), asOf: now.toISOString(), sets: {} };
for (const [key, corpus, casesFile] of SETS) {
  const cases = JSON.parse(fs.readFileSync(path.join(repo, casesFile), 'utf8'));
  const index = indexFor(corpus);
  out.sets[key] = cases.map(c => {
    const runs = {};
    for (const threshold of [0, 0.35]) {
      const r = retrieval.search(index, c.query, { limit: 10, abstainThreshold: threshold, asOf: now });
      runs[String(threshold)] = {
        abstained: r.abstained, reason: r.reason, truncated: r.truncated,
        results: r.results.map(x => ({ path: x.path, score: x.score, heading: x.heading, anchor: x.anchor, headingPath: x.headingPath, snippetSha: sha(x.snippet), supersedes: x.supersedes ?? null })),
      };
    }
    return { id: c.id, query: c.query, runs };
  });
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
