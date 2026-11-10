// SPDX-License-Identifier: MIT
// BA-00 blind acceptance: ba-suite shape, determinism across two runs, output leakage, sandboxing (HOME, TMPDIR, network).
// Two full child runs are shared by several tests so the file stays within the npm test time budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEV, ROOT, runNode, tempDir, removeDir, listDir } from './helpers.mjs';

const SUITE = join(ROOT, 'eval', 'ba-suite.mjs');
const TOP_KEYS = ['cases', 'natural', 'xling', 'identifier', 'currentState', 'multihop', 'nearNegative', 'hook', 'scale', 'meta'];
const TIMING_KEYS = new Set(['latencyMs', 'indexBuildMs', 'durationMs', 'scale']);
const strip = (value) => JSON.parse(JSON.stringify(value, (k, v) => (TIMING_KEYS.has(k) ? undefined : v)));
const count = (file) => JSON.parse(readFileSync(join(DEV, file), 'utf8')).length;
const EXTENDED = ['sectionHitRate', 'sectionCases', 'requireAllRate', 'requireAllCases'];

const sandbox = () => ({ home: tempDir('suite-home'), tmp: tempDir('suite-tmp'), work: tempDir('suite-work') });
const dirs = [];
function own(sb) { dirs.push(sb.home, sb.tmp, sb.work); return sb; }
process.on('exit', () => { for (const d of dirs) removeDir(d); });

function runSuite(sb, outName) {
  const out = join(sb.work, outName);
  const netLog = join(sb.work, 'net.log');
  const res = runNode([SUITE, '--out', out], {
    preload: true,
    env: { HOME: sb.home, TMPDIR: sb.tmp, BA00_NET_LOG: netLog },
  });
  return { res, out, netLog };
}

let runA;
let runB;
const getRunA = () => (runA ??= (() => { const sb = own(sandbox()); return { sb, ...runSuite(sb, 'a.json') }; })());
const getRunB = () => (runB ??= (() => { const sb = own(sandbox()); return { sb, ...runSuite(sb, 'b.json') }; })());

test('ba-suite: exit 0, prints only a fixed status line, writes the required top-level keys', () => {
  const { res, out, netLog } = getRunA();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'BA suite written');
  assert.equal(res.stderr, '');
  const suite = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(suite).sort(), [...TOP_KEYS].sort());
  assert.equal(suite.scale, null, 'scale is null without --scale');
  assert.equal(existsSync(netLog), false, 'no network attempt');
});

test('ba-suite: two runs at the same commit are identical except scale and timing fields', () => {
  const a = getRunA();
  const b = getRunB();
  assert.equal(b.res.status, 0, b.res.stderr);
  const ja = JSON.parse(readFileSync(a.out, 'utf8'));
  const jb = JSON.parse(readFileSync(b.out, 'utf8'));
  assert.deepEqual(strip(ja), strip(jb));
  // Timing fields exist (they are excluded from the comparison, not absent).
  assert.equal(typeof ja.identifier.latencyMs.p50, 'number');
  assert.equal(typeof ja.hook.durationMs.p50, 'number');
});

test('ba-suite: extended metrics always present on the four new sets and on the existing sets', () => {
  const { res, out } = getRunA();
  assert.equal(res.status, 0, res.stderr);
  const s = JSON.parse(readFileSync(out, 'utf8'));
  for (const key of ['cases', 'natural', 'xling', 'identifier', 'currentState', 'multihop', 'nearNegative']) {
    for (const field of EXTENDED) assert.ok(field in s[key], `${key}.${field} missing`);
  }
  assert.equal(s.identifier.n, count('identifier-cases.json'));
  assert.equal(s.currentState.n, count('current-state-cases.json'));
  assert.equal(s.multihop.n, count('multihop-cases.json'));
  assert.equal(s.nearNegative.n, count('near-negative-cases.json'));
  assert.equal(s.currentState.sectionCases, 11, 'cs cases with expectedHeading');
  assert.equal(s.multihop.requireAllCases, 14, 'multihop cases with requireAll');
  assert.equal(s.identifier.sectionCases, 0);
  assert.equal(s.hook.n, count('natural-cases.json') + 24 + 13 + 14 + 12, 'hook sees every set once');
  assert.equal(s.meta.holdout, false);
  assert.equal(s.meta.date, '2026-11-10');
  assert.equal(s.meta.node, process.version);
  assert.match(s.meta.commit, /^([0-9a-f]{4,40}|unknown)$/);
});

test('ba-suite: output and stderr never contain query text or corpus body text', () => {
  const { res, out } = getRunA();
  assert.equal(res.status, 0, res.stderr);
  const samples = [
    'Tokens are short-lived bearer credentials',
    'Tidewater cache TTL şu an kaç saniye?',
    'What triggers E_QUEUE_LOCKED on a partition?',
    'Mevcut deploy penceresi hangi saatler arasında?',
    'Which drain timeout applies when Orchard sync is paused',
    'Larkspur dead-letter kayıtları EU bölgesinde',
  ];
  const blob = readFileSync(out, 'utf8') + res.stdout + res.stderr;
  for (const s of samples) assert.ok(!blob.includes(s), `leaked: ${s}`);
});

test('ba-suite: sandbox - HOME untouched, TMPDIR left empty (hook state removed), no network attempt', () => {
  const { res, netLog, sb } = getRunA();
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(listDir(sb.home), [], 'HOME must stay empty');
  assert.deepEqual(listDir(sb.tmp), [], 'every temp dir must be removed');
  assert.equal(existsSync(netLog), false, 'no blocked network attempt was recorded');
});

test('ba-suite CLI: missing --out exits 1 with a generic message', () => {
  const res = runNode([SUITE]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /BA suite failed/);
  assert.equal(res.stdout, '');
});

test('ba-suite --scale wiring: scale block carries sizes and the required timing fields (in-process, N=40 to stay fast)', async () => {
  const { runBaSuite } = await import(pathToFileURL(SUITE).href);
  const tmp = tempDir('suite-scale');
  dirs.push(tmp);
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    const suite = await runBaSuite({ scale: true, scaleOptions: { sizes: [40] } });
    assert.ok(suite.scale && Array.isArray(suite.scale.sizes), 'scale.sizes');
    assert.deepEqual(suite.scale.sizes.map((x) => x.n), [40]);
    const row = suite.scale.sizes[0];
    for (const f of ['buildIndexMs', 'createSearcherColdMs', 'createSearcherWarmMs']) assert.equal(typeof row[f], 'number');
    for (const f of ['searchMs', 'hookMs', 'hybridOverheadMs']) {
      assert.ok(Number.isFinite(row[f].p50) && Number.isFinite(row[f].p95), f);
      assert.ok(row[f].count >= 20, `${f}.count`);
    }
    assert.deepEqual(listDir(tmp), [], 'scale temp dirs removed');
  } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
  }
});
