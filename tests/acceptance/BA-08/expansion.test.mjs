// SPDX-License-Identifier: MIT
// BA-08 blind acceptance: query-time graph expansion. The expected result is derived from the documented rule
// (docs/contracts/retrieval.md, "Expansion at query time") applied to main's lexical ranking, and main's live code
// (commit 6cac7a7, loaded at test time) provides that ranking. No stored golden file is used.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMainRetrieval, dispose, loadWorktreeRetrieval, repoRoot } from './helpers/main-core.mjs';
import { isolateHome, makeVault, neighbourPaths } from './helpers/vault.mjs';

const now = new Date('2026-11-10T00:00:00Z');
const LIMIT_ALL = 1000;
let main, wt, mainDir, restoreHome;
// PM update (2026-11-11): these checks use main 6cac7a7's lexical ranking as the oracle. They prove BA-08's rule on its own
// branch; later tracks intentionally change lexical ranking and CI clones may not contain the commit, so they run only on
// track/BA-08 (same rule as BA-00/BA-04).
import { spawnSync as __spawn } from 'node:child_process';
const ON_TRACK = (__spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout ?? '').trim() === 'track/BA-08';
const ONLY_ON_TRACK = { skip: !ON_TRACK };
before(async () => {
  if (!ON_TRACK) return;
  restoreHome = isolateHome('ba08-expansion');
  wt = await loadWorktreeRetrieval();
  const loaded = await loadMainRetrieval();
  main = loaded.retrieval; mainDir = loaded.dir;
});
after(() => { if (mainDir) dispose(mainDir); if (restoreHome) restoreHome(); });

const body = (text) => `${text}\n`;
const buildWith = (mod, vault) => mod.buildIndex(mod.loadPages(vault), { now });

// A linked vault with overlapping vocabulary, an identifier page, a superseded replacement chain, a dated section page,
// a page that links to the page itself and an orphan. Used for property checks against main.
const LINKED = {
  'ops/intake.md': body('Courier intake rules for the kestrel depot. Handoff requires two signatures. See [[shifts]] and [the ledger](../finance/ledger.md). Section [[ops/intake#Handoff]].\n\n## Handoff\nTwo signatures at the gate.'),
  'ops/shifts.md': body('Shift rotation for the kestrel depot. Night shift covers handoff gaps. Back to [[intake]].'),
  'finance/ledger.md': body('Ledger entries for courier payouts. Countersign each payout. Links [[intake|intake rules]] and [[ops/shifts#night]].'),
  'finance/payouts.md': body('Payout timing is forty minutes after countersign.'),
  'notes/zircon.md': body('Zircon polishing grit schedule. Felt wheel finish. Related: [[payouts]].'),
  'notes/zircon-alt.md': body('Alternate zircon polishing grit with cerium.'),
  'notes/orphan.md': body('Unrelated content about gardening and soil.'),
  'archive/old-intake.md': '---\nstatus: superseded\nsuperseded_by: ops/intake.md\n---\nkestrel depot courier intake old rules [[shifts]]\n',
  'docs/retry.md': body('Use `src/lib/retry.mjs` and E_WIDGET_TIMEOUT with --drain-timeout set. Read [[ops/intake]] first.'),
  'ops/rotation.md': body('# Rotation\n\n## 2026-09-01 Rotation\nNight shift was the old pattern.\n\n## 2026-10-15 Current state\nNight shift now covers handoff gaps for the kestrel depot.\n'),
};
const LINKED_QUERIES = [
  'kestrel depot courier handoff', 'courier intake rules', 'countersign payout timing', 'forty minutes countersign',
  'zircon polishing grit', 'night shift handoff gaps', 'payout', 'ledger', 'intake', 'courier', 'kestrel', 'handoff rules',
  'night shift current state', 'old rules', 'E_WIDGET_TIMEOUT', 'src/lib/retry.mjs', '--drain-timeout', 'gardening soil',
  'zebra quasar', 'forty countersign zebra', 'E_WIDGET_TIMEOUT retry', 'what is the zircon grit schedule',
];
const THRESHOLDS = [0, 0.35];

/**
 * Oracle: the expected result map (path -> {score, via}) for a query, from main's lexical ranking. The top three lexical
 * results contribute 0.5 x their score to each direct neighbour in the worktree graph; a page keeps the larger value.
 */
function expectedFromRule(mainResult, wIdx) {
  const own = new Map(mainResult.results.map(r => [r.path, r.score]));
  const boosted = new Map();
  for (const source of mainResult.results.slice(0, 3)) {
    for (const neighbour of neighbourPaths(wIdx, source.path) ?? []) {
      const value = 0.5 * source.score;
      if (value > (boosted.get(neighbour) ?? -Infinity)) boosted.set(neighbour, value);
    }
  }
  const expected = new Map();
  for (const [p, s] of own) expected.set(p, { score: s, via: undefined });
  for (const [p, value] of boosted) {
    const current = own.get(p);
    if (current === undefined || value > current) expected.set(p, { score: value, via: 'link' });
  }
  return expected;
}

function assertRule(mainMod, wtMod, mIdx, wIdx, query, threshold, label) {
  const opts = { limit: LIMIT_ALL, abstainThreshold: threshold, asOf: now };
  const m = mainMod.search(mIdx, query, opts);
  const w = wtMod.search(wIdx, query, opts);
  assert.equal(w.abstained, m.abstained, `${label}: abstain decision changed`);
  assert.equal(w.reason, m.reason, `${label}: abstain reason changed`);
  if (m.abstained) { assert.deepEqual(w.results, [], `${label}: an unanswered query gained results`); return; }
  // Expansion never changes the first result.
  assert.equal(w.results[0]?.path, m.results[0]?.path, `${label}: first path changed`);
  assert.equal(w.results[0]?.score, m.results[0]?.score, `${label}: first score changed`);
  // Expected set and scores from the documented rule.
  const expected = expectedFromRule(m, wIdx);
  const got = new Map(w.results.map(r => [r.path, r]));
  assert.deepEqual([...got.keys()].sort(), [...expected.keys()].sort(), `${label}: result set differs from the rule`);
  for (const r of w.results) {
    const e = expected.get(r.path);
    assert.equal(r.score, e.score, `${label}: score of ${r.path} differs from the rule`);
    assert.equal(r.via, e.via, `${label}: via of ${r.path} differs from the rule`);
    if (r.via === undefined) {
      // A lexical result is otherwise identical to main: same snippet, heading, status and supersedes.
      const { related, ...rest } = r;
      assert.deepEqual(rest, m.results.find(x => x.path === r.path), `${label}: ${r.path} differs from main`);
    }
  }
  // Ordering: score descending, then path ascending.
  for (let i = 1; i < w.results.length; i++) {
    const a = w.results[i - 1], b = w.results[i];
    assert.ok(a.score > b.score || (a.score === b.score && a.path < b.path), `${label}: ordering broken at ${b.path}`);
  }
}

test('linked synthetic vault: first result, abstention and expansion follow the documented rule against main', ONLY_ON_TRACK, async (t) => {
  const { vault } = makeVault(t, LINKED, 'ba08-linked');
  const mIdx = buildWith(main, vault), wIdx = buildWith(wt, vault);
  assert.ok(Object.keys(wIdx.links).length >= 6, 'the synthetic vault has a real link graph');
  for (const threshold of THRESHOLDS) for (const q of LINKED_QUERIES) assertRule(main, wt, mIdx, wIdx, q, threshold, `linked q="${q}" th=${threshold}`);
});

test('a neighbour that no query term matches joins with via link and exactly half of its source score', ONLY_ON_TRACK, (t) => {
  const { vault } = makeVault(t, {
    'seed.md': body('kestrel courier handoff rules [[timing]]'),
    'timing.md': body('forty minutes countersign'),
    'other.md': body('unrelated garden text'),
  }, 'ba08-half');
  const wIdx = buildWith(wt, vault), mIdx = buildWith(main, vault);
  const result = wt.search(wIdx, 'kestrel courier handoff', { abstainThreshold: 0 });
  const seed = result.results.find(r => r.path === 'seed.md');
  const timing = result.results.find(r => r.path === 'timing.md');
  assert.ok(seed && timing, 'both pages are returned');
  assert.equal(timing.via, 'link');
  assert.equal(timing.score, 0.5 * seed.score);
  assert.equal(seed.via, undefined);
  assert.deepEqual(seed.related, ['timing.md']);
  assert.ok(!main.search(mIdx, 'kestrel courier handoff', { abstainThreshold: 0 }).results.some(r => r.path === 'timing.md'), 'main has no timing result');
});

test('only the three best lexical results expand: a neighbour of the fourth result is not added', ONLY_ON_TRACK, (t) => {
  const bodies = {
    's1.md': 'zephyr zephyr zephyr quartz quartz quartz plain text',
    's2.md': 'zephyr zephyr quartz quartz plain text here',
    's3.md': 'zephyr quartz quartz plain text here now',
    's4.md': 'zephyr quartz plain text here now later [[orphan]]',
    'orphan.md': 'gardening and soil notes',
  };
  const { vault } = makeVault(t, Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, body(v)])), 'ba08-top3');
  const mIdx = buildWith(main, vault), wIdx = buildWith(wt, vault);
  const mainOrder = main.search(mIdx, 'zephyr quartz', { abstainThreshold: 0 }).results.map(r => r.path);
  assert.deepEqual(mainOrder.slice(0, 4), ['s1.md', 's2.md', 's3.md', 's4.md'], 'premise: s4 is the fourth lexical result');
  const result = wt.search(wIdx, 'zephyr quartz', { abstainThreshold: 0 });
  assert.ok(!result.results.some(r => r.path === 'orphan.md'), 'the fourth result does not expand');
  assert.deepEqual(result.results.find(r => r.path === 's4.md').related, ['orphan.md'], 'the fourth result still reports its neighbour');
});

test('the top three expand: the same orphan is added when the first result links to it', ONLY_ON_TRACK, (t) => {
  const { vault } = makeVault(t, {
    's1.md': body('zephyr zephyr zephyr quartz quartz quartz plain text [[orphan]]'),
    's2.md': body('zephyr zephyr quartz quartz plain text here'),
    's3.md': body('zephyr quartz quartz plain text here now'),
    's4.md': body('zephyr quartz plain text here now later'),
    'orphan.md': body('gardening and soil notes'),
  }, 'ba08-top3pos');
  const wIdx = buildWith(wt, vault);
  const orphan = wt.search(wIdx, 'zephyr quartz', { abstainThreshold: 0 }).results.find(r => r.path === 'orphan.md');
  assert.equal(orphan?.via, 'link');
});

test('a ranked neighbour keeps its own score when that is higher, and takes the link value when that is higher', ONLY_ON_TRACK, (t) => {
  const { vault } = makeVault(t, {
    'strong.md': body('alpha alpha alpha beta beta gamma gamma'),
    'weak.md': body('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau [[strong]]'),
  }, 'ba08-max');
  const mIdx = buildWith(main, vault), wIdx = buildWith(wt, vault);
  assertRule(main, wt, mIdx, wIdx, 'alpha beta gamma', 0, 'max-rule');
  const w = wt.search(wIdx, 'alpha beta gamma', { abstainThreshold: 0 }).results;
  const strong = w.find(r => r.path === 'strong.md'), weak = w.find(r => r.path === 'weak.md');
  assert.ok(strong && weak);
  // weak.md is a neighbour of the top result, so its link value is half of strong.md's score. Whichever is larger wins.
  const own = main.search(mIdx, 'alpha beta gamma', { abstainThreshold: 0 }).results.find(r => r.path === 'weak.md').score;
  assert.equal(weak.score, Math.max(own, 0.5 * strong.score));
  assert.equal(weak.via === 'link', 0.5 * strong.score > own);
});

test('related lists at most five direct neighbours, sorted, and reports links in both directions', ONLY_ON_TRACK, (t) => {
  const spokes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  const { vault } = makeVault(t, {
    'hub.md': body(`hub text ${spokes.map(n => `[[${n}]]`).join(' ')}`),
    ...Object.fromEntries(spokes.map(n => [`${n}.md`, body(`spoke ${n}`)])),
    'back.md': body('points at [[n3]]'),
  }, 'ba08-related');
  const wIdx = buildWith(wt, vault);
  const hub = wt.search(wIdx, 'hub text', { abstainThreshold: 0 }).results.find(r => r.path === 'hub.md');
  assert.deepEqual(hub.related, ['n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md']);
  assert.deepEqual(neighbourPaths(wIdx, 'n3.md'), ['back.md', 'hub.md']);
  assert.deepEqual(neighbourPaths(wIdx, 'n6.md'), ['hub.md']);
});

test('abstention is decided lexically: a query answered only through a neighbour stays abstained', ONLY_ON_TRACK, (t) => {
  const { vault } = makeVault(t, {
    'seed.md': body('kestrel courier handoff rules [[timing]]'),
    'timing.md': body('forty minutes countersign'),
  }, 'ba08-abstain');
  const mIdx = buildWith(main, vault), wIdx = buildWith(wt, vault);
  const q = 'forty countersign zebra';
  for (const threshold of [0.35, 0.99]) {
    const w = wt.search(wIdx, q, { abstainThreshold: threshold });
    const m = main.search(mIdx, q, { abstainThreshold: threshold });
    assert.equal(w.abstained, m.abstained);
    assert.equal(w.reason, m.reason);
    if (m.abstained) assert.deepEqual(w.results, [], 'an abstained query returns no neighbour');
  }
  assert.equal(wt.search(wIdx, q, { abstainThreshold: 0.99 }).abstained, true);
  const none = wt.search(wIdx, 'zebra quasar', { abstainThreshold: 0 });
  assert.equal(none.abstained, true);
  assert.equal(none.reason, 'no_match');
  assert.deepEqual(none.results, []);
});

test('identifier-not-found abstention is unchanged and no expansion rescues it', ONLY_ON_TRACK, (t) => {
  const { vault } = makeVault(t, LINKED, 'ba08-identifier');
  const mIdx = buildWith(main, vault), wIdx = buildWith(wt, vault);
  // E_NOWHERE_ISSUE occurs nowhere in the vault (E_WIDGET_TIMEOUT, unlike this one, does occur in docs/retry.md).
  const w = wt.search(wIdx, 'E_NOWHERE_ISSUE retry', { abstainThreshold: 0 });
  const m = main.search(mIdx, 'E_NOWHERE_ISSUE retry', { abstainThreshold: 0 });
  assert.equal(m.reason, 'identifier-not-found', 'premise: main abstains on the unknown identifier');
  assert.equal(w.reason, 'identifier-not-found');
  assert.deepEqual(w.results, []);
});

test('the limit applies after expansion', ONLY_ON_TRACK, (t) => {
  const { vault } = makeVault(t, LINKED, 'ba08-limit');
  const wIdx = buildWith(wt, vault);
  for (const limit of [0, 1, 2, 3]) {
    const r = wt.search(wIdx, 'kestrel depot courier handoff', { limit, abstainThreshold: 0 });
    assert.ok(r.results.length <= limit, `limit ${limit}`);
  }
});

// Real corpora: the BA linked corpus (eval/corpus-ba) and the development query sets. Read-only inputs.
test('eval/corpus-ba: every dev query follows the documented rule against main', ONLY_ON_TRACK, () => {
  const corpus = path.join(repoRoot, 'eval/corpus-ba');
  const sets = ['current-state', 'multihop', 'identifier', 'near-negative'].map(s => path.join(repoRoot, `eval/dev/${s}-cases.json`));
  const mIdx = buildWith(main, corpus), wIdx = buildWith(wt, corpus);
  assert.ok(Object.keys(wIdx.links).length > 0, 'the BA corpus is linked');
  let checked = 0;
  for (const file of sets) {
    for (const item of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      assertRule(main, wt, mIdx, wIdx, item.query, 0.35, `${path.basename(file)} ${item.id}`);
      checked++;
    }
  }
  assert.ok(checked >= 40, `checked ${checked} queries`);
});

test('unlinked corpora: full results (scores, snippets, headings, supersedes) are identical to main', ONLY_ON_TRACK, () => {
  for (const [corpusRel, casesRel] of [['eval/corpus', 'eval/dev/cases.json'], ['eval/corpus-natural', 'eval/dev/natural-cases.json']]) {
    const corpus = path.join(repoRoot, corpusRel);
    const mIdx = buildWith(main, corpus), wIdx = buildWith(wt, corpus);
    assert.deepEqual(wIdx.links, {}, `${corpusRel} has no edges`);
    for (const item of JSON.parse(fs.readFileSync(path.join(repoRoot, casesRel), 'utf8'))) {
      for (const threshold of THRESHOLDS) {
        const opts = { limit: 10, abstainThreshold: threshold, asOf: now };
        assert.deepEqual(wt.search(wIdx, item.query, opts), main.search(mIdx, item.query, opts), `${corpusRel} ${item.id} th=${threshold}`);
      }
    }
  }
});
