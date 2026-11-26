// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPages } from '../../../packages/core/src/retrieval/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const SETS = {
  cases: ['eval/corpus', 'eval/dev/cases.json'],
  natural: ['eval/corpus-natural', 'eval/dev/natural-cases.json'],
  xling: ['eval/corpus-natural', 'eval/dev/xling-cases.json'],
  identifier: ['eval/corpus-ba', 'eval/dev/identifier-cases.json'],
  currentState: ['eval/corpus-ba', 'eval/dev/current-state-cases.json'],
  multihop: ['eval/corpus-ba', 'eval/dev/multihop-cases.json'],
  nearNegative: ['eval/corpus-ba', 'eval/dev/near-negative-cases.json'],
};
const dump = spawnSync(process.execPath, [path.join(here, 'tools/dump-ranking.mjs'), root], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const candidate = dump.status === 0 ? JSON.parse(dump.stdout) : null;

test('no result is a superseded page, and any supersedes field is a non-empty sorted list of superseded paths', () => {
  for (const [key, [corpus]] of Object.entries(SETS)) {
    const superseded = new Set(
      pagesOf2(corpus)
        .filter(
          (p) =>
            String(p.frontmatter.status || '').toLowerCase() === 'superseded' ||
            Object.hasOwn(p.frontmatter, 'superseded_by')
        )
        .map((p) => p.path)
    );
    for (const cq of candidate.sets[key]) {
      for (const r of cq.runs['0'].results) {
        assert.ok(!superseded.has(r.path), `${key}/${cq.id} returned superseded ${r.path}`);
        if (r.supersedes !== null && r.supersedes !== undefined) {
          assert.ok(Array.isArray(r.supersedes) && r.supersedes.length > 0, `${key}/${cq.id} empty supersedes`);
          assert.deepEqual(r.supersedes, [...r.supersedes].sort(), `${key}/${cq.id} unsorted supersedes`);
          for (const s of r.supersedes)
            assert.ok(superseded.has(s), `${key}/${cq.id} supersedes names non-superseded ${s}`);
        }
      }
    }
  }
});

function pagesOf2(corpus) {
  return loadPages(path.join(root, corpus));
}
