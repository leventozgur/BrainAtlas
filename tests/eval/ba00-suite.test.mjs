// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBaSuite } from '../../eval/ba-suite.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = new Date('2026-11-10T00:00:00Z');
const TOP_KEYS = [
  'cases',
  'natural',
  'xling',
  'identifier',
  'currentState',
  'multihop',
  'nearNegative',
  'hook',
  'hookRealistic',
  'longpage',
  'temporal',
  'poison',
  'realDocs',
  'grepBaseline',
  'scale',
  'meta',
];

function writePages(dir, pages) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(pages)) fs.writeFileSync(path.join(dir, name), text);
}

function sourceFixture(t, { holdout = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba00-suite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pages = { 'alpha.md': '# Alpha\nzebra quartz ember text\n', 'beta.md': '# Beta\nmarble lantern orbit text\n' };
  writePages(path.join(dir, 'corpus'), pages);
  writePages(path.join(dir, 'corpus-natural'), pages);
  writePages(path.join(dir, 'corpus-ba'), pages);
  const dev = path.join(dir, 'dev');
  fs.mkdirSync(dev);
  const cases = {
    'cases.json': [{ id: 'k1', query: 'zebra quartz', relevant: ['alpha.md'] }],
    'natural-cases.json': [{ id: 'n1', query: 'marble lantern', relevant: ['beta.md'] }],
    'xling-cases.json': [{ id: 'x1', query: 'nothing here', relevant: [], abstain: true }],
    'identifier-cases.json': [
      { id: 'i1', category: 'identifier', query: 'zebra', relevant: ['alpha.md'] },
      { id: 'i2', category: 'identifier', query: 'unknownterm', relevant: [], abstain: true },
    ],
    'current-state-cases.json': [
      { id: 'c1', category: 'current-state', query: 'marble', relevant: ['beta.md'], expectedHeading: 'Beta' },
    ],
    'multihop-cases.json': [
      { id: 'm1', category: 'multihop', query: 'zebra marble', relevant: ['alpha.md', 'beta.md'], requireAll: true },
    ],
    'near-negative-cases.json': [
      { id: 'v1', category: 'near-negative', query: 'cedar river', relevant: [], abstain: true },
    ],
  };
  for (const [name, value] of Object.entries(cases)) fs.writeFileSync(path.join(dev, name), JSON.stringify(value));
  // BA-27 sets: one tiny corpus and case file each (realDocs reads the fixture's docs directory).
  for (const name of ['corpus-hook-realistic', 'corpus-longpage', 'corpus-temporal', 'corpus-poison'])
    writePages(path.join(dir, name), pages);
  writePages(path.join(dir, 'docs'), pages);
  fs.writeFileSync(
    path.join(dev, 'hook-realistic-cases.json'),
    JSON.stringify([
      { id: 'hr1', kind: 'operational', query: 'devam et', relevant: [], abstain: true },
      { id: 'hr2', query: 'zebra quartz', relevant: ['alpha.md'], cwd: '/srv/work/alpha' },
    ])
  );
  fs.writeFileSync(
    path.join(dev, 'longpage-cases.json'),
    JSON.stringify([{ id: 'lp1', query: 'marble lantern', relevant: ['beta.md'], expectedHeading: 'Beta' }])
  );
  fs.writeFileSync(
    path.join(dev, 'temporal-cases.json'),
    JSON.stringify([{ id: 't1', query: 'zebra', relevant: ['alpha.md'] }])
  );
  fs.writeFileSync(
    path.join(dev, 'poison-cases.json'),
    JSON.stringify([{ id: 'po1', query: 'ember', relevant: ['alpha.md'] }])
  );
  fs.writeFileSync(
    path.join(dev, 'realdocs-cases.json'),
    JSON.stringify([
      { id: 'rd1', query: 'zebra', relevant: ['alpha.md'] },
      { id: 'rd2', query: 'cedar river', relevant: [], abstain: true },
    ])
  );
  const holdoutDir = path.join(dir, 'holdout');
  if (holdout) {
    writePages(path.join(holdoutDir, 'corpus'), { 'gamma.md': '# Gamma\nquill ledger harbor text\n' });
    fs.writeFileSync(
      path.join(holdoutDir, 'identifier-cases.json'),
      JSON.stringify([{ id: 'h1', category: 'identifier', query: 'quill', relevant: ['gamma.md'] }])
    );
    fs.writeFileSync(path.join(holdoutDir, 'current-state-cases.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(holdoutDir, 'multihop-cases.json'), JSON.stringify([]));
    fs.writeFileSync(
      path.join(holdoutDir, 'near-negative-cases.json'),
      JSON.stringify([{ id: 'h2', category: 'near-negative', query: 'ledger', relevant: [], abstain: true }])
    );
  }
  return { sourceRoot: dir, holdoutDir, docsDir: path.join(dir, 'docs') };
}

const stripTiming = (value) => {
  if (Array.isArray(value)) return value.map(stripTiming);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['latencyMs', 'indexBuildMs', 'durationMs', 'scale'].includes(key))
        .map(([key, item]) => [key, stripTiming(item)])
    );
  }
  return value;
};

test('suite emits every top-level key and metadata; scale is null unless requested', async (t) => {
  const { sourceRoot } = sourceFixture(t);
  const suite = await runBaSuite({ sourceRoot, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  assert.deepEqual(Object.keys(suite), TOP_KEYS);
  assert.equal(suite.scale, null);
  assert.equal(suite.meta.holdout, false);
  assert.equal(suite.meta.date, '2026-11-10');
  assert.equal(typeof suite.meta.commit, 'string');
  assert.equal(suite.identifier.n, 2);
  assert.equal(suite.nearNegative.n, 1);
  assert.equal(suite.currentState.sectionCases, 1);
  assert.equal(suite.multihop.requireAllCases, 1);
  assert.equal(suite.hook.n, 6);
  assert.deepEqual(
    Object.keys(suite.hook.byCategory).sort(),
    ['current-state', 'identifier', 'multihop', 'near-negative', 'uncategorized'].sort()
  );
});

test('two runs on the same commit match except scale and timing fields', async (t) => {
  const { sourceRoot } = sourceFixture(t);
  const first = await runBaSuite({ sourceRoot, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  const second = await runBaSuite({ sourceRoot, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  assert.deepEqual(stripTiming(second), stripTiming(first));
});

test('holdout directory replaces only the four new sets and their corpus', async (t) => {
  const { sourceRoot, holdoutDir } = sourceFixture(t, { holdout: true });
  const suite = await runBaSuite({ sourceRoot, holdoutDir, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  assert.equal(suite.meta.holdout, true);
  assert.equal(suite.identifier.n, 1);
  assert.equal(suite.identifier.recallAt5, 1);
  assert.equal(suite.nearNegative.n, 1);
  assert.equal(suite.cases.n, 1);
  assert.equal(suite.natural.n, 1);
});

test('scale section is included when scale options are supplied', async (t) => {
  const { sourceRoot } = sourceFixture(t);
  const suite = await runBaSuite({
    sourceRoot,
    docsDir: path.join(sourceRoot, 'docs'),
    now: NOW,
    scale: true,
    scaleOptions: { sizes: [30] },
  });
  assert.equal(suite.scale.sizes.length, 1);
  assert.equal(suite.scale.sizes[0].n, 30);
});

test('missing case file and malformed CLI arguments fail safely', async (t) => {
  const { sourceRoot } = sourceFixture(t);
  fs.rmSync(path.join(sourceRoot, 'dev', 'multihop-cases.json'));
  await assert.rejects(
    () => runBaSuite({ sourceRoot, docsDir: path.join(sourceRoot, 'docs'), now: NOW }),
    /Missing case file/
  );
  const cli = spawnSync(process.execPath, [path.join(root, 'eval/ba-suite.mjs')], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr.trim(), 'BA suite failed');
});

test('BA-27 sets are read from the dev layout, and the grep baseline covers every set', async (t) => {
  const { sourceRoot } = sourceFixture(t);
  const suite = await runBaSuite({ sourceRoot, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  for (const key of ['hookRealistic', 'longpage', 'temporal', 'poison', 'realDocs']) {
    assert.equal(typeof suite[key].n, 'number', key);
    assert.deepEqual(Object.keys(suite[key]).sort(), ['bm25', 'hook', 'n']);
    assert.equal(typeof suite[key].hook.metaShareTop5, 'number', key);
  }
  assert.equal(suite.hookRealistic.n, 2);
  assert.equal(suite.hookRealistic.hook.byKind.operational.falseInjectionRate, 0);
  assert.deepEqual(
    Object.keys(suite.grepBaseline).sort(),
    [
      'cases',
      'currentState',
      'hookRealistic',
      'identifier',
      'longpage',
      'multihop',
      'natural',
      'nearNegative',
      'poison',
      'realDocs',
      'temporal',
      'xling',
    ].sort()
  );
  assert.equal(suite.grepBaseline.longpage.currentFirstRate, 1);
});

test('a holdout directory without a BA-27 set directory gives null for that set, and an existing one is read', async (t) => {
  const { sourceRoot, holdoutDir } = sourceFixture(t, { holdout: true });
  const suite = await runBaSuite({ sourceRoot, holdoutDir, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  for (const key of ['hookRealistic', 'longpage', 'temporal', 'poison', 'realDocs'])
    assert.equal(suite[key], null, key);
  assert.equal(suite.grepBaseline.longpage, null);
  fs.mkdirSync(path.join(holdoutDir, 'longpage', 'corpus'), { recursive: true });
  fs.writeFileSync(path.join(holdoutDir, 'longpage', 'corpus', 'gamma.md'), '# Gamma\nquill ledger harbor text\n');
  fs.writeFileSync(
    path.join(holdoutDir, 'longpage', 'cases.json'),
    JSON.stringify([{ id: 'hl1', query: 'quill ledger', relevant: ['gamma.md'], expectedHeading: 'Gamma' }])
  );
  const second = await runBaSuite({ sourceRoot, holdoutDir, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  assert.equal(second.longpage.n, 1);
  assert.equal(second.longpage.bm25.recallAt5, 1);
  assert.equal(second.hookRealistic, null);
  assert.equal(second.meta.holdout, true);
});

test('grepBaseline carries the fair comparison block: BM25 at 0.35 matches the set numbers, and both sides expose abstainN', async (t) => {
  const { sourceRoot } = sourceFixture(t);
  const suite = await runBaSuite({ sourceRoot, docsDir: path.join(sourceRoot, 'docs'), now: NOW });
  for (const key of [
    'cases',
    'natural',
    'xling',
    'identifier',
    'currentState',
    'multihop',
    'nearNegative',
    'hookRealistic',
    'longpage',
    'temporal',
    'poison',
    'realDocs',
  ]) {
    const entry = suite.grepBaseline[key];
    for (const field of ['answerableRecallAt5', 'abstainN', 'unansweredReturnedRate', 'abstainAccuracy'])
      assert.ok(field in entry, `${key}.${field}`);
    for (const mode of ['atThreshold', 'noAbstain']) {
      for (const field of [
        'recallAt5',
        'answerableRecallAt5',
        'mrrAt10',
        'abstainAccuracy',
        'unansweredReturnedRate',
        'abstainN',
      ])
        assert.ok(field in entry.bm25[mode], `${key}.bm25.${mode}.${field}`);
    }
  }
  assert.equal(suite.grepBaseline.cases.bm25.atThreshold.recallAt5, suite.cases.recallAt5);
  assert.equal(suite.grepBaseline.cases.bm25.atThreshold.mrrAt10, suite.cases.mrrAt10);
  assert.equal(suite.grepBaseline.cases.bm25.atThreshold.abstainAccuracy, suite.cases.abstainAccuracy);
  assert.equal(suite.grepBaseline.cases.bm25.noAbstain.abstainN, suite.grepBaseline.cases.bm25.atThreshold.abstainN);
  assert.equal('abstainN' in suite.cases, false, 'set objects keep their BA-00 shape');
});
