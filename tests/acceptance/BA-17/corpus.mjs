// SPDX-License-Identifier: MIT
// Deterministic ASCII corpus and query matrix for the parity tests. The golden file is generated from the main
// checkout (gen-golden.mjs with BA17_ROOT=main) and compared against the worktree in parity.test.mjs.
import { page } from './support.mjs';

const filler = (n, seed = 'retention') => Array.from({ length: n }, (_, i) => `${seed} note ${i} keeps the archive stable and the review honest.`).join(' ');

// Paths whose segment count (split on / . -) is at most twelve, and deeper ones, as strings for bodies.
export const shortPaths = [
  'notes/retry.mjs', 'src/lib/retry.mjs', 'build-2.1/report.v2.json', 'a_b.c-d.mjs', 'x/y/z/handler-x-13.mjs',
  'd1/d2/d3/d4/d5/d6/d7/handler-x-13.mjs', 'd1/d2/d3/d4/d5/d6/d7/d8/x-1.mjs', 'd1/d2/d3/d4/d5/d6/d7/d8/d9/x-1.md',
  'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/x.md', 'p1/p2/p3/build-2.1/report.v2.json', 'q1/q2/a_b.c-d.mjs',
];
export const deepPaths = [
  'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/handler-x-13.mjs', 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/d13/d14/d15/handler-x-13.mjs',
  'e1/e2/e3/e4/e5/e6/e7/e8/e9/e10/e11/e12/e13/e14/e15/e16/build-2.1/report.v2.json',
  'f1/f2/f3/f4/f5/f6/f7/f8/f9/f10/f11/f12/f13/f14/f15/f16/f17/f18/f19/f20/a_b.c-d.mjs',
];

export function corpusPages() {
  return [
    page('notes/widgets.md', [
      '# Widgets',
      'The widget pipeline uses E_WIDGET_TIMEOUT for retries. See URLSessionConfiguration.timeoutIntervalForRequest for the client.',
      '## Retry',
      'Retry uses src/lib/retry.mjs and the flag --drain-timeout in the pipeline.',
      '```js',
      'const x = 1; // E_CODE_FENCE_ONLY',
      '```',
      '## Versions',
      'Release rc.12 and 2.4.0-rc.12 shipped on 11.11.2025 and 2026.11.11 (2025-11-11).',
    ].join('\n'), { title: 'Widgets', headings: ['Widgets', 'Retry', 'Versions'] }),
    page('notes/cache.md', `The route cache is RouteSnapshotCache, keyed by a1b2c3d. ADR-009 covers it, and ERR-BASIL is the old name. We cut it i.e. for speed, e.g. on warm starts, a.k.a. the snapshot path. ${filler(12, 'cache')}`, { title: 'Cache' }),
    page('notes/long.md', filler(40), { title: 'Long prose' }),
    page('notes/files.md', [
      'Files touched by the rollout:',
      ...shortPaths.map(p => `- ${p}`),
      'Deep layouts:',
      ...deepPaths.map(p => `- ${p}`),
    ].join('\n'), { title: 'Files' }),
    page('notes/versions.md', `Pinned 10.20.30 and 1.2.3 in the lockfile. Meeting held on 31.12.2025 and 2025.12.31, plus 12/31/2025. ${filler(3, 'version')}`, { title: 'Versions' }),
    page('notes/superseded.md', 'SUPERSEDED_TOKEN_ZZ was the old rule.', { title: 'Old rule', frontmatter: { status: 'superseded', superseded_by: 'notes/new.md' } }),
    page('notes/fresh.md', 'FRESH_TOKEN_QQ is still valid for the review cycle.', { title: 'Fresh', frontmatter: { status: 'confirmed', generated: '2026-11-01', stale_after: 'P1D' } }),
    page('notes/garden.md', 'Plain prose about gardens, rivers and bread.', { title: 'Garden' }),
  ];
}

export const budgets = [undefined, 1, 2, 13, 60, 200, 400];
export const thresholds = [0, 0.35];

export const queries = [
  // Ordinary words (no identifier): results and scores must not change.
  'widget pipeline retries', 'cache', 'long prose retention', 'bread gardens rivers', 'the', 'ne oldu', 'files rollout',
  'review cycle valid', 'old rule', 'pinned lockfile', 'warm starts snapshot path', 'archive stable review',
  // Identifiers present in the corpus.
  'E_WIDGET_TIMEOUT', 'URLSessionConfiguration.timeoutIntervalForRequest', 'timeoutIntervalForRequest', 'rc.12',
  '2.4.0-rc.12', 'src/lib/retry.mjs', 'lib/retry.mjs', 'retry.mjs', '--drain-timeout', 'RouteSnapshotCache',
  'a1b2c3d', 'ADR-009', 'ERR-BASIL', '11.11.2025', '2026.11.11', '2025-11-11', '10.20.30', '1.2.3', 'i.e.', 'e.g.', 'a.k.a',
  'E_CODE_FENCE_ONLY',
  // Short paths (at most twelve segments): suffixes and gaps.
  'notes/retry.mjs', 'retry.mjs', 'build-2.1/report.v2.json', 'report.v2.json', '2.1/report.v2.json', 'a_b.c-d.mjs',
  'c-d.mjs', 'b.c-d.mjs', 'x/y/z/handler-x-13.mjs', 'y/z/handler-x-13.mjs', 'z/handler-x-13.mjs', 'handler-x-13.mjs',
  'x/z/handler-x-13.mjs', 'd1/d2/d3/d4/d5/d6/d7/handler-x-13.mjs', 'd6/d7/handler-x-13.mjs', 'd5/d7/handler-x-13.mjs',
  'd1/d2/d3/d4/d5/d6/d7/d8/x-1.mjs', 'd7/d8/x-1.mjs', 'x-1.mjs', 'd8/x-1.mjs', 'd1/d2/d3/d4/d5/d6/d7/d8/d9/x-1.md', 'd8/d9/x-1.md',
  'd9/x-1.md', 'x-1.md', 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/x.md', 'd9/d10/x.md', 'd10/x.md', 'p2/p3/build-2.1/report.v2.json',
  'q1/a_b.c-d.mjs', 'q2/a_b.c-d.mjs', 'q1/q2/a_b.c-d.mjs',
  // Prefixes of short paths (indexed in main, must stay so) and of deep paths (not suffixes: observed, not asserted).
  'notes/retry', 'd1/d2/d3', 'x/y/z', 'd1/d2/d3/d4/d5/d6/d7/d8', 'build-2.1/report', 'p1/p2/p3/build-2.1', 'q1/q2/a_b.c-d', 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/x',
  'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/handler-x-13', 'e1/e2/e3/e4/e5/e6/e7/e8/e9/e10/e11/e12/e13/e14/e15/e16/build-2.1',
  // Deep paths (more than twelve segments): suffixes, prefixes and gaps.
  'd10/d11/handler-x-13.mjs', 'd11/handler-x-13.mjs', 'd9/d10/d11/handler-x-13.mjs', 'd8/d9/d10/d11/handler-x-13.mjs',
  'd7/d8/d9/d10/d11/handler-x-13.mjs', 'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/handler-x-13.mjs', 'd3/d5/d11/handler-x-13.mjs',
  'd9/d11/handler-x-13.mjs', 'd14/d15/handler-x-13.mjs', 'd15/handler-x-13.mjs', 'd12/d13/d14/d15/handler-x-13.mjs',
  'd1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/d13/d14/d15/handler-x-13.mjs', 'e16/build-2.1/report.v2.json',
  'e15/e16/build-2.1/report.v2.json', 'e14/e15/e16/build-2.1/report.v2.json', 'e11/e16/build-2.1/report.v2.json',
  'f19/f20/a_b.c-d.mjs', 'f18/f19/f20/a_b.c-d.mjs', 'f17/f18/f19/f20/a_b.c-d.mjs', 'f15/f20/a_b.c-d.mjs',
  'f1/f2/f3/f4/f5/f6/f7/f8/f9/f10/f11/f12/f13/f14/f15/f16/f17/f18/f19/f20/a_b.c-d.mjs',
  // Mixed sentences with one identifier.
  'what about E_WIDGET_TIMEOUT in the widget pipeline?', 'Ne zaman 11.11.2025 oldu?', 'retry.mjs nasil calisiyor',
  'version 2.4.0-rc.12 and cache', 'd10/d11/handler-x-13.mjs in the widget notes?', 'handler-x-13.mjs what is it?',
];
