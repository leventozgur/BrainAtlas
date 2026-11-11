// SPDX-License-Identifier: MIT
// BA-03 probe: which suffix chains of a deep path are indexed, by leaf name shape. Read-only diagnostic.
import { buildIndex, search } from '../../../../packages/core/src/retrieval/index.mjs';
const now = new Date('2026-11-11T00:00:00Z');
for (const n of [13, 20, 40]) for (const leaf of ['handler.mjs', 'handler-x.mjs', 'retry_policy.ts', 'handler-x-y.mjs']) {
  const comps = Array.from({ length: n - 1 }, (_, i) => `dir${String(i).padStart(2, '0')}`);
  const full = [...comps, leaf].join('/');
  const idx = buildIndex([{ path: 'deep/p.md', title: 'P', aliases: [], keywords: [], headings: [], body: `At ${full}.`, frontmatter: {} }], { now });
  const hits = [];
  for (let k = 1; k <= 4; k++) {
    const q = [...comps, leaf].slice(-k).join('/');
    const r = search(idx, q, { limit: 5, abstainThreshold: 0, asOf: now });
    hits.push(`${k}comp:${r.reason === 'identifier-not-found' ? 'NOTFOUND' : r.results[0]?.path ? 'ok' : r.reason}`);
  }
  console.log(`n=${n} leaf=${leaf} ${hits.join(' ')}`);
}
