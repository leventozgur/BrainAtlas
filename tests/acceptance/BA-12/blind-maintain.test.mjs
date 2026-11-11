// SPDX-License-Identifier: MIT
// BA-12 blind acceptance: independent seeded-defect measurement of `brainatlas maintain`.
// Writes only under the OS temp dir (per test) and runs the CLI with an isolated HOME and a network-deny preload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AMBIGUOUS, CLEAN_PATHS, COMPANIONS, KINDS, MARKER, SEEDS,
  buildLargeVault, buildSeededVault, contentPageCount, score,
} from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'brainatlas.mjs');
const PRELOAD = pathToFileURL(join(HERE, 'no-network.mjs')).href;

const created = [];
function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `ba12-blind-${label}-`));
  created.push(dir);
  return dir;
}
process.on('exit', () => { for (const dir of created) rmSync(dir, { recursive: true, force: true }); });

function cli(args, home, cwd = home) {
  const result = spawnSync(process.execPath, ['--import', PRELOAD, CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8' },
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

const maintain = (args, home, cwd) => cli(['maintain', ...args], home, cwd);

function snapshot(dir) {
  const out = {};
  const walk = (path, rel) => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(path)}`;
    else if (st.isDirectory()) {
      out[rel] = `dir:${st.mode}`;
      for (const entry of readdirSync(path).sort()) walk(join(path, entry), rel === '' ? entry : `${rel}/${entry}`);
    } else if (st.isFile()) {
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      out[rel] = `file:${st.mode}:${st.size}:${st.mtimeMs}:${hash}`;
    } else out[rel] = 'other';
  };
  walk(dir, '');
  return out;
}

function parseOnlyJson(stdout) {
  return JSON.parse(stdout); // throws if stdout holds more than one JSON value or any extra text
}

const FM = (type, { status = 'proposed', generated = '"2026-10-01"', stale = '"2999-12-31"', superseded } = {}) => [
  '---', `type: ${type}`, `generated: ${generated}`, `status: ${status}`, 'sources:', '  - raw/synthetic-source.md',
  'verified: []', `stale_after: ${stale}`, 'aliases: []', 'keywords: []',
  ...(superseded === undefined ? [] : [`superseded_by: ${superseded}`]), '---', '',
].join('\n');

// Seeded defect vault: the scored measurement.
const seedRoot = tempDir('seed');
const seedHome = tempDir('seed-home');
buildSeededVault(seedRoot);
const seedRun = maintain(['--json', '--vault', seedRoot], seedHome);
const seedOut = seedRun.status === 0 ? parseOnlyJson(seedRun.stdout) : null;
const seedScore = seedOut ? score(seedOut.findings) : null;
const detection = seedScore ? seedScore.detected / seedScore.seeds : 0;
const falsePositiveRate = seedScore && seedOut.findings.length ? seedScore.falsePositives.length / seedOut.findings.length : 1;
const strictFalsePositiveRate = seedScore && seedOut.findings.length
  ? seedScore.strictFp / seedOut.findings.length : 1;

test('BA-12 fixture: at least 3 seeds per defect kind and a balanced seed list', () => {
  for (const kind of KINDS) {
    const n = SEEDS.filter((s) => s.kind === kind).length;
    assert.ok(n >= 3, `kind ${kind} has ${n} seeds`);
  }
  assert.equal(new Set(SEEDS.map((s) => s.id)).size, SEEDS.length, 'seed ids are unique');
});

test('BA-12 seeded vault: CLI exits 0 with one JSON object and nothing on stderr', () => {
  assert.equal(seedRun.status, 0, seedRun.stderr);
  assert.equal(seedRun.stderr, '');
  assert.ok(seedOut && seedOut.ok === true);
  assert.deepEqual(Object.keys(seedOut).sort(), ['counts', 'durationMs', 'findings', 'ok', 'pages']);
  for (const kind of KINDS) {
    assert.equal(seedOut.counts[kind], seedOut.findings.filter((f) => f.kind === kind).length, `counts match findings for ${kind}`);
  }
  assert.deepEqual(Object.keys(seedOut.counts).sort(), [...KINDS].sort());
  assert.equal(seedOut.pages, contentPageCount(), 'pages counts content pages only (index and log excluded)');
});

test('BA-12 pre-registered gate: detection >= 0.90 and false-positive rate <= 0.10 on the seeded vault', (t) => {
  const rows = KINDS.map((kind) => {
    const k = seedScore.perKind[kind];
    return `| ${kind} | ${k.seeds} | ${k.detected} | ${k.falsePositives} |`;
  });
  const lines = [
    `seeds ${seedScore.seeds}, found ${seedScore.detected}, detection ${detection.toFixed(3)}`,
    `findings ${seedOut.findings.length}, false positives ${seedScore.falsePositives.length}, FP rate ${falsePositiveRate.toFixed(3)}`,
    `strict FP rate (companions counted as FP) ${strictFalsePositiveRate.toFixed(3)}`,
    `companion findings (orphan implies index-missing) ${seedScore.companionsSeen.length}`,
    `ambiguous hard case reported as index-missing ${seedScore.ambiguousSeen.length}`,
    `missed seeds: ${seedScore.missed.join(', ') || 'none'}`,
    '| kind | seeds | found | false positives |', '| --- | --- | --- | --- |', ...rows,
  ];
  for (const line of lines) t.diagnostic(line);
  assert.ok(detection >= 0.9, `detection ${detection}`);
  assert.ok(falsePositiveRate <= 0.1, `false-positive rate ${falsePositiveRate}`);
});

test('BA-12 seeded vault: every kind is detected at least once', () => {
  for (const kind of KINDS) assert.ok(seedScore.perKind[kind].detected >= 1, `no ${kind} detected`);
});

test('BA-12 hard negatives: clean pages and code, URL, anchor and alias cases produce no findings', () => {
  for (const path of CLEAN_PATHS) {
    assert.equal(seedOut.findings.filter((f) => f.path === path).length, 0, `unexpected finding on ${path}`);
  }
  const hubNegatives = ['no-fence-target', 'no-inline-target', 'gone-in-fence', 'example.com', 'raw/file.pdf', 'outside-vault'];
  for (const f of seedOut.findings) {
    for (const word of hubNegatives) assert.ok(!JSON.stringify(f).includes(word), `hard negative leaked into ${JSON.stringify(f)}`);
  }
  const indexStale = seedOut.findings.filter((f) => f.kind === 'index-stale');
  assert.equal(indexStale.length, 3, 'only the three seeded stale index entries');
  for (const f of indexStale) assert.ok(/zz-(removed|old-name|gone)/.test(f.detail), `unexpected index-stale ${f.detail}`);
});

test('BA-12 hard negative: a page linked from another page but missing from the index is not an orphan', () => {
  const orphanPaths = seedOut.findings.filter((f) => f.kind === 'orphan').map((f) => f.path);
  assert.ok(!orphanPaths.includes('wiki/summaries/hn-linked-unindexed.md'));
});

test('BA-12 ambiguous case reported for transparency: linked-but-unindexed page is index-missing per contract', (t) => {
  t.diagnostic(`contract-ambiguous findings: ${JSON.stringify(seedScore.ambiguousSeen.map((f) => f.path))}`);
  assert.ok(AMBIGUOUS.length === 1);
});

test('BA-12 clean vault: no defects gives zero findings', () => {
  const root = tempDir('clean');
  const home = tempDir('clean-home');
  mkdirSync(join(root, 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(root, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(root, 'wiki', 'index.md'), '# Wiki index\n\n- [A](concepts/a.md)\n- [B](entities/b.md)\n');
  writeFileSync(join(root, 'wiki', 'concepts', 'a.md'), `${FM('concept')}# A\n\nLinks [[b]] and [b](../entities/b.md).\n`);
  writeFileSync(join(root, 'wiki', 'entities', 'b.md'), `${FM('entity')}# B\n\nBack to [[a]].\n`);
  const run = maintain(['--json', '--vault', root], home);
  assert.equal(run.status, 0, run.stderr);
  const out = parseOnlyJson(run.stdout);
  assert.deepEqual(out.findings, []);
  assert.ok(Object.values(out.counts).every((n) => n === 0));
  assert.equal(out.pages, 2);
});

test('BA-12 JSON error: missing vault gives {ok:false,error:{code,message}}, non-zero exit, no local path', () => {
  const root = tempDir('err');
  const home = tempDir('err-home');
  const missing = join(root, 'does-not-exist');
  const run = maintain(['--json', '--vault', missing], home);
  assert.notEqual(run.status, 0);
  const out = parseOnlyJson(run.stdout);
  assert.equal(out.ok, false);
  assert.equal(typeof out.error.code, 'string');
  assert.equal(typeof out.error.message, 'string');
  assert.ok(!run.stdout.includes(root) && !run.stderr.includes(root), 'error output names a local path');
});

test('BA-12 determinism: two runs on the seeded vault give identical findings and counts', () => {
  const again = parseOnlyJson(maintain(['--json', '--vault', seedRoot], seedHome).stdout);
  assert.deepEqual(again.findings, seedOut.findings);
  assert.deepEqual(again.counts, seedOut.counts);
  assert.equal(again.pages, seedOut.pages);
});

test('BA-12 read-only: vault and HOME are byte-identical after human, JSON and error runs', () => {
  const root = tempDir('ro');
  const home = tempDir('ro-home');
  buildSeededVault(root);
  writeFileSync(join(home, 'sentinel.txt'), 'untouched');
  const before = { vault: snapshot(root), home: snapshot(home) };
  assert.equal(maintain(['--vault', root], home).status, 0);
  assert.equal(maintain(['--json', '--vault', root], home).status, 0);
  maintain(['--json', '--vault', join(root, 'missing')], home);
  const after = { vault: snapshot(root), home: snapshot(home) };
  assert.deepEqual(after.vault, before.vault, 'vault changed');
  assert.deepEqual(after.home, before.home, 'HOME changed');
});

test('BA-12 Lite --queue on the configured vault writes nothing and says so', () => {
  const home = tempDir('lite-home');
  const vault = join(tempDir('lite-vault'), 'vault');
  const init = cli(['init', '--yes', '--profile', 'lite', '--vault', vault, '--agents', 'claude-code', '--json'], home);
  assert.equal(init.status, 0, init.stderr);
  buildSeededVault(vault);
  const before = { vault: snapshot(vault), home: snapshot(home) };
  const jsonRun = maintain(['--queue', '--json'], home);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const out = parseOnlyJson(jsonRun.stdout);
  assert.equal(out.queue?.queued, false);
  assert.ok(out.queue?.reason, 'queue reason is reported');
  const humanRun = maintain(['--queue'], home);
  assert.equal(humanRun.status, 0, humanRun.stderr);
  assert.match(humanRun.stdout, /Nothing queued/);
  const after = { vault: snapshot(vault), home: snapshot(home) };
  assert.deepEqual(after, before, 'Lite --queue wrote to the vault or HOME');
});

test('BA-12 --queue with an explicit --vault is refused (only the configured vault can be queued)', () => {
  const home = tempDir('queue-arg-home');
  const run = maintain(['--queue', '--json', '--vault', seedRoot], home);
  assert.notEqual(run.status, 0);
  assert.equal(parseOnlyJson(run.stdout).ok, false);
});

test('BA-12 symlinked page and directory under wiki/ are not followed', () => {
  const root = tempDir('sym');
  const home = tempDir('sym-home');
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'leak'), { recursive: true });
  writeFileSync(join(outside, 'secret.md'), `${FM('concept')}# Secret\n\n[[zz-leak-target]] SYMLINKMARK\n`);
  writeFileSync(join(outside, 'leak', 'leak.md'), `${FM('concept')}# Leak\n\nNothing links here.\n`);
  const wiki = join(root, 'wiki');
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, 'real.md'), `${FM('concept')}# Real\n\nPlain page.\n`);
  writeFileSync(join(wiki, 'index.md'), '# Wiki index\n\n- [Real](real.md)\n');
  symlinkSync(join(outside, 'secret.md'), join(wiki, 'link.md'));
  symlinkSync(outside, join(wiki, 'linkdir'));
  const run = maintain(['--json', '--vault', root], home);
  assert.equal(run.status, 0, run.stderr);
  const out = parseOnlyJson(run.stdout);
  assert.equal(out.pages, 1, 'only the real page is scanned');
  assert.deepEqual(out.findings, []);
  for (const word of ['zz-leak-target', 'SYMLINKMARK', 'link.md', 'linkdir', 'leak.md']) {
    assert.ok(!run.stdout.includes(word), `symlink content or name leaked: ${word}`);
  }
});

test('BA-12 symlinked wiki/ folder is skipped', () => {
  const root = tempDir('sym-wiki');
  const home = tempDir('sym-wiki-home');
  const outsideWiki = join(root, 'outside-wiki');
  mkdirSync(outsideWiki, { recursive: true });
  writeFileSync(join(outsideWiki, 'index.md'), '# Wiki index\n');
  writeFileSync(join(outsideWiki, 'page.md'), `${FM('concept')}# Page\n\n[[zz-x-target]]\n`);
  symlinkSync(outsideWiki, join(root, 'wiki'));
  const run = maintain(['--json', '--vault', root], home);
  assert.equal(run.status, 0, run.stderr);
  const out = parseOnlyJson(run.stdout);
  assert.equal(out.pages, 0);
  assert.ok(!run.stdout.includes('page.md') && !run.stdout.includes('zz-x-target'), 'content behind a symlinked wiki/ was scanned');
});

test('BA-12 no leakage: page body words and absolute local paths never appear in output', () => {
  const home = tempDir('leak-home');
  const out = [seedRun, maintain(['--vault', seedRoot], home), maintain(['--json', '--vault', seedRoot], home)];
  for (const run of out) {
    const text = `${run.stdout}\n${run.stderr}`;
    assert.ok(!text.includes(MARKER), 'body marker leaked into output');
    assert.ok(!text.includes(seedRoot), 'vault absolute path leaked into output');
    assert.ok(!text.includes(home), 'HOME absolute path leaked into output');
  }
});

test('BA-12 performance (report only, not a threshold): 2000-page synthetic vault', (t) => {
  const root = tempDir('perf');
  const home = tempDir('perf-home');
  const { pages, expectedBroken } = buildLargeVault(root, 2000);
  const started = performance.now();
  const run = maintain(['--json', '--vault', root], home);
  const wallMs = Math.round(performance.now() - started);
  assert.equal(run.status, 0, run.stderr);
  const out = parseOnlyJson(run.stdout);
  t.diagnostic(`2000 pages: durationMs ${out.durationMs}, wall ${wallMs} ms, findings ${out.findings.length}`);
  assert.equal(out.ok, true);
  assert.equal(out.pages, pages);
  assert.equal(out.counts['broken-link'], expectedBroken);
});

test('BA-12 network: CLI runs with the network-deny preload (no network use)', () => {
  const home = tempDir('net-home');
  const run = maintain(['--json', '--vault', seedRoot], home);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stderr.includes('network disabled'));
});

// Keep the sanity import used (companion list is part of the scoring contract).
test('BA-12 companion contract: orphan pages are also index-missing', () => {
  assert.equal(COMPANIONS.length, 3);
  for (const c of COMPANIONS) assert.equal(c.kind, 'index-missing');
});
