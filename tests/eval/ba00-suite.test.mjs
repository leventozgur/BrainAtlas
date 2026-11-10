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
const TOP_KEYS = ['cases', 'natural', 'xling', 'identifier', 'currentState', 'multihop', 'nearNegative', 'hook', 'scale', 'meta'];

function writePages(dir, pages) {
  fs.mkdirSync(dir, {recursive: true});
  for (const [name, text] of Object.entries(pages)) fs.writeFileSync(path.join(dir, name), text);
}

function sourceFixture(t, {holdout = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba00-suite-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const pages = {'alpha.md': '# Alpha\nzebra quartz ember text\n', 'beta.md': '# Beta\nmarble lantern orbit text\n'};
  writePages(path.join(dir, 'corpus'), pages);
  writePages(path.join(dir, 'corpus-natural'), pages);
  writePages(path.join(dir, 'corpus-ba'), pages);
  const dev = path.join(dir, 'dev');
  fs.mkdirSync(dev);
  const cases = {
    'cases.json': [{id: 'k1', query: 'zebra quartz', relevant: ['alpha.md']}],
    'natural-cases.json': [{id: 'n1', query: 'marble lantern', relevant: ['beta.md']}],
    'xling-cases.json': [{id: 'x1', query: 'nothing here', relevant: [], abstain: true}],
    'identifier-cases.json': [{id: 'i1', category: 'identifier', query: 'zebra', relevant: ['alpha.md']}, {id: 'i2', category: 'identifier', query: 'unknownterm', relevant: [], abstain: true}],
    'current-state-cases.json': [{id: 'c1', category: 'current-state', query: 'marble', relevant: ['beta.md'], expectedHeading: 'Beta'}],
    'multihop-cases.json': [{id: 'm1', category: 'multihop', query: 'zebra marble', relevant: ['alpha.md', 'beta.md'], requireAll: true}],
    'near-negative-cases.json': [{id: 'v1', category: 'near-negative', query: 'cedar river', relevant: [], abstain: true}],
  };
  for (const [name, value] of Object.entries(cases)) fs.writeFileSync(path.join(dev, name), JSON.stringify(value));
  const holdoutDir = path.join(dir, 'holdout');
  if (holdout) {
    writePages(path.join(holdoutDir, 'corpus'), {'gamma.md': '# Gamma\nquill ledger harbor text\n'});
    fs.writeFileSync(path.join(holdoutDir, 'identifier-cases.json'), JSON.stringify([{id: 'h1', category: 'identifier', query: 'quill', relevant: ['gamma.md']}]));
    fs.writeFileSync(path.join(holdoutDir, 'current-state-cases.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(holdoutDir, 'multihop-cases.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(holdoutDir, 'near-negative-cases.json'), JSON.stringify([{id: 'h2', category: 'near-negative', query: 'ledger', relevant: [], abstain: true}]));
  }
  return {sourceRoot: dir, holdoutDir};
}

const stripTiming = (value) => {
  if (Array.isArray(value)) return value.map(stripTiming);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['latencyMs', 'indexBuildMs', 'durationMs', 'scale'].includes(key))
      .map(([key, item]) => [key, stripTiming(item)]));
  }
  return value;
};

test('suite emits every top-level key and metadata; scale is null unless requested', async (t) => {
  const {sourceRoot} = sourceFixture(t);
  const suite = await runBaSuite({sourceRoot, now: NOW});
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
  assert.deepEqual(Object.keys(suite.hook.byCategory).sort(), ['current-state', 'identifier', 'multihop', 'near-negative', 'uncategorized'].sort());
});

test('two runs on the same commit match except scale and timing fields', async (t) => {
  const {sourceRoot} = sourceFixture(t);
  const first = await runBaSuite({sourceRoot, now: NOW});
  const second = await runBaSuite({sourceRoot, now: NOW});
  assert.deepEqual(stripTiming(second), stripTiming(first));
});

test('holdout directory replaces only the four new sets and their corpus', async (t) => {
  const {sourceRoot, holdoutDir} = sourceFixture(t, {holdout: true});
  const suite = await runBaSuite({sourceRoot, holdoutDir, now: NOW});
  assert.equal(suite.meta.holdout, true);
  assert.equal(suite.identifier.n, 1);
  assert.equal(suite.identifier.recallAt5, 1);
  assert.equal(suite.nearNegative.n, 1);
  assert.equal(suite.cases.n, 1);
  assert.equal(suite.natural.n, 1);
});

test('scale section is included when scale options are supplied', async (t) => {
  const {sourceRoot} = sourceFixture(t);
  const suite = await runBaSuite({sourceRoot, now: NOW, scale: true, scaleOptions: {sizes: [30]}});
  assert.equal(suite.scale.sizes.length, 1);
  assert.equal(suite.scale.sizes[0].n, 30);
});

test('missing case file and malformed CLI arguments fail safely', async (t) => {
  const {sourceRoot} = sourceFixture(t);
  fs.rmSync(path.join(sourceRoot, 'dev', 'multihop-cases.json'));
  await assert.rejects(() => runBaSuite({sourceRoot, now: NOW}), /Missing case file/);
  const cli = spawnSync(process.execPath, [path.join(root, 'eval/ba-suite.mjs')], {encoding: 'utf8'});
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr.trim(), 'BA suite failed');
});
