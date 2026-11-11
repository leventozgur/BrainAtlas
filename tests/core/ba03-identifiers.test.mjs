// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createSearcher, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2025-01-01T00:00:00Z');
const page = (name, body, frontmatter = {}) => ({ path: name, title: 'Notes', aliases: [], keywords: [], headings: [], body, frontmatter });
const NOT_FOUND = 'identifier-not-found';
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba03-identifiers-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

// One document per identifier type, plus a document with neutral text and common words only.
const corpus = [
  page('snake.md', 'The E_WIDGET_TIMEOUT error fires after a delay.'),
  page('hash.md', 'Release commit a1b2c3d includes the fix.'),
  page('version.md', 'Version 2.4.0-rc.12 shipped on Monday.'),
  page('path.md', 'The retry loop lives in src/lib/retry.mjs.'),
  page('flag.md', 'Set --drain-timeout to control the drain wait.'),
  page('camel.md', 'RouteSnapshotCache keeps routes warm.'),
  page('key.md', 'Send an idempotency_key with every write.'),
  page('adr.md', 'ADR-009 covers partition ordering.'),
  page('chain.md', 'Use URLSessionConfiguration.timeoutIntervalForRequest for limits.'),
  page('plain.md', 'Ordinary notes about backups and restores in 2026.'),
];
const index = buildIndex(corpus, { now });
const top = (query) => search(index, query, { limit: 5, asOf: now, abstainThreshold: 0.35 });

test('each identifier type is found exactly and ranks its own document first', () => {
  const cases = {
    'E_WIDGET_TIMEOUT': 'snake.md',
    'a1b2c3d': 'hash.md',
    'rc.12': 'version.md',
    '2.4.0-rc.12': 'version.md',
    'src/lib/retry.mjs': 'path.md',
    '--drain-timeout': 'flag.md',
    'RouteSnapshotCache': 'camel.md',
    'idempotency_key': 'key.md',
    'ADR-009': 'adr.md',
  };
  for (const [query, expected] of Object.entries(cases)) {
    const result = top(`what is ${query} about?`);
    assert.equal(result.abstained, false, query);
    assert.equal(result.results[0].path, expected, query);
  }
});

test('identifiers are matched whole: a dotted chain also answers to its first segment', () => {
  assert.equal(top('URLSessionConfiguration limits').results[0].path, 'chain.md');
  assert.equal(top('URLSessionConfiguration.timeoutIntervalForRequest').results[0].path, 'chain.md');
});

test('punctuation around an identifier is not part of it', () => {
  for (const wrapped of ['E_WIDGET_TIMEOUT.', 'E_WIDGET_TIMEOUT?', '(E_WIDGET_TIMEOUT)', '`E_WIDGET_TIMEOUT`', 'E_WIDGET_TIMEOUT,', 'E_WIDGET_TIMEOUT’ı']) {
    const result = top(`${wrapped} neden olur`);
    assert.equal(result.abstained, false, wrapped);
    assert.equal(result.results[0].path, 'snake.md', wrapped);
  }
});

test('unicode identifiers are indexed and matched after the same folding as text', () => {
  const idx = buildIndex([page('tr.md', 'Ayar şema_anahtarı yalnız yerelde tutulur.'), page('other.md', 'nothing here')], { now });
  const found = search(idx, 'ŞEMA_ANAHTARI nedir?', { abstainThreshold: 0.35 });
  assert.equal(found.abstained, false);
  assert.equal(found.results[0].path, 'tr.md');
});

test('an identifier missing from every document abstains with identifier-not-found', () => {
  for (const query of ['E_WIDGET_QUOTA_FULL hatası neden oluşur?', 'commit f9e8d7c neyi değiştirdi?', '--drain-retries flag default value?', 'ERR_TIDEWATER_QUORUM_LOST recovery steps']) {
    const result = top(query);
    assert.equal(result.abstained, true, query);
    assert.equal(result.reason, NOT_FOUND, query);
    assert.deepEqual(result.results, [], query);
  }
});

test('a missing identifier inside a long natural-language question does not abstain on its own', () => {
  const result = top('E_GHOST_CODE: how should the operator restore backups and verify snapshots after an outage?');
  assert.notEqual(result.reason, NOT_FOUND);
});

test('common words are not identifiers: years, short version tags, dates and plain hyphenated words', () => {
  for (const query of ['2026 notes', 'v2 notes', 'mp3 notes', '2026-11-11 notes', 'follow-up notes', 'and/or notes', '1.0 notes']) {
    const result = top(query);
    assert.notEqual(result.reason, NOT_FOUND, query);
  }
  assert.equal(top('2026 backups').results[0].path, 'plain.md');
});

test('a query without identifiers is ranked exactly as before the exact index existed', () => {
  // Identical to BM25F on the same index: no exact boost and no identifier abstention.
  const result = top('backups and restores');
  assert.equal(result.reason, null);
  assert.equal(result.results[0].path, 'plain.md');
  assert.equal(top('the the and').reason, 'empty-query');
});

test('an identifier that appears only in a superseded page is not found', () => {
  const idx = buildIndex([page('old.md', 'Legacy E_OLD_CODE flow', { status: 'superseded' }), page('new.md', 'Plain text')], { now });
  const result = search(idx, 'E_OLD_CODE behaviour', { abstainThreshold: 0.35 });
  assert.equal(result.abstained, true);
  assert.equal(result.reason, NOT_FOUND);
});

test('an exact identifier match outranks a document that only shares its words', () => {
  const idx = buildIndex([page('words.md', 'widget timeout notes, widget timeout details'), page('exact.md', 'E_WIDGET_TIMEOUT is set here.')], { now });
  const result = search(idx, 'E_WIDGET_TIMEOUT widget timeout', { abstainThreshold: 0 });
  assert.equal(result.results[0].path, 'exact.md');
});

test('an identifier in a heading is indexed like any other field text', () => {
  const idx = buildIndex([{ path: 'h.md', title: 'Notes', aliases: [], keywords: [], headings: ['Config RouteSnapshotCache'], body: 'plain body', frontmatter: {} }], { now });
  const result = search(idx, 'RouteSnapshotCache', { abstainThreshold: 0.35 });
  assert.equal(result.results[0].path, 'h.md');
});

test('a hand-built index without exact postings is rejected as corrupt', () => {
  const { exact, ...rest } = index;
  assert.throws(() => search(rest, 'backups'), { code: 'E_INDEX_CORRUPT' });
});

test('a cached index with malformed exact postings is rebuilt from the vault', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'snake.md'), '# Notes\nThe E_WIDGET_TIMEOUT error fires after a delay.');
  const first = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.equal(first.search('E_WIDGET_TIMEOUT').results[0].path, 'snake.md');
  const cache = path.join(state, 'retrieval-index.json');
  const good = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const key = Object.keys(good.index.exact)[0];
  const tampered = [
    { ...good.index, exact: { ...good.index.exact, [key]: [5] } },
    { ...good.index, exact: { ...good.index.exact, [key]: [] } },
    { ...good.index, exact: [] },
    { ...good.index, exact: undefined },
  ];
  for (const index of tampered) {
    fs.writeFileSync(cache, JSON.stringify({ key: good.key, index, skipped: good.skipped }));
    const recovered = createSearcher({ vaultDir: vault, stateDir: state, now });
    assert.equal(recovered.search('E_WIDGET_TIMEOUT').results[0].path, 'snake.md');
    assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).index.exact[key].length, 1);
  }
});

test('a cache written under the previous schema tag is not reused', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault); fs.mkdirSync(state);
  fs.writeFileSync(path.join(vault, 'snake.md'), '# Notes\nThe E_WIDGET_TIMEOUT error fires after a delay.');
  const cache = path.join(state, 'retrieval-index.json');
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  const current = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const oldIndex = { ...current.index }; delete oldIndex.exact;
  fs.writeFileSync(cache, JSON.stringify({ key: current.key.replace(/./, c => (c === '0' ? '1' : '0')), index: oldIndex, skipped: current.skipped }));
  const rebuilt = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.equal(rebuilt.search('E_WIDGET_TIMEOUT').results[0].path, 'snake.md');
  assert.ok(JSON.parse(fs.readFileSync(cache, 'utf8')).index.exact);
  assert.ok(searcher);
});
