// SPDX-License-Identifier: MIT
// BA-03 independent acceptance tests: identifier extraction, negatives, abstention, vault-variant coverage.
// Written from the brief and docs/contracts/retrieval.md only. Hermetic: in-memory pages, temp dirs, no network.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, search } from '../../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
const page = (p, body, extra = {}) => ({
  path: p, title: extra.title ?? 'Page', aliases: extra.aliases ?? [], keywords: extra.keywords ?? [],
  headings: extra.headings ?? [], body, frontmatter: extra.frontmatter ?? {},
});
const run = (index, query, options = {}) => search(index, query, { limit: 10, abstainThreshold: 0, asOf: now, ...options });
const topPath = (index, query) => { const r = run(index, query); return r.abstained ? null : (r.results[0]?.path ?? null); };

let savedHome;
let tempHome;
before(() => {
  savedHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ba03-identifiers-home-'));
  process.env.HOME = tempHome;
});
after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// One document that carries every identifier kind listed in the contract, plus an unrelated page.
const IDENTIFIERS = [
  'E_WIDGET_TIMEOUT', 'a1b2c3d', 'ADR-009', 'rc.12', '2.4.0-rc.12', 'src/lib/retry.mjs', '--drain-timeout',
  'RouteSnapshotCache', 'URLSessionConfiguration.timeoutIntervalForRequest', 'ERR-BASIL', 'widget.mjs',
  'settings.json', '1.2.3', 'idempotency_key', 'LarkspurClient.flushBatch', 'Node.js',
];
const kindIndex = buildIndex([
  page('types/widget.md', `Notes: ${IDENTIFIERS.join(' ; ')} end.`, { title: 'Types' }),
  page('other/garden.md', 'Plain prose about gardens, rivers and bread.', { title: 'Garden' }),
], { now });

test('every identifier kind from the contract is found exactly, bare and inside a question', () => {
  for (const id of IDENTIFIERS) {
    assert.equal(topPath(kindIndex, id), 'types/widget.md', `bare: ${id}`);
    assert.equal(topPath(kindIndex, `${id} ne zaman döner?`), 'types/widget.md', `turkish: ${id}`);
    assert.equal(topPath(kindIndex, `When is ${id} used?`), 'types/widget.md', `english: ${id}`);
  }
});

test('identifier boundaries: trailing and surrounding punctuation is not part of the identifier', () => {
  const id = 'E_WIDGET_TIMEOUT';
  for (const q of [`${id}.`, `${id}?`, `${id},`, `${id}:`, `${id}!`, `(${id})`, `"${id}"`, `'${id}'`, `${id}…`, `${id}'un değeri`]) {
    assert.equal(topPath(kindIndex, q), 'types/widget.md', q);
  }
});

test('identifiers are matched case-insensitively and across dotless-i / dotted-I folding', () => {
  const idx = buildIndex([page('a.md', 'Ayar IŞIK_SÜRESİ değeri 30 saniye.', { title: 'Ayar' }), page('b.md', 'Unrelated text.', { title: 'B' })], { now });
  assert.equal(topPath(idx, 'ışık_süresi nedir'), 'a.md');
  assert.equal(topPath(idx, 'isik_suresi'), 'a.md');
  assert.equal(topPath(buildIndex([page('c.md', 'widget E_WIDGET_TIMEOUT here', { title: 'C' })], { now }), 'e_widget_timeout'), 'c.md');
});

test('negative words are not identifiers: 2026, v2, mp3, ISO dates, follow-up, and/or, 1.0 and iOS never trigger identifier abstention', () => {
  const negatives = ['2026', 'v2', 'mp3', '2026-11-11', 'follow-up', 'and/or', '1.0', 'iOS'];
  const vault = buildIndex([page('garden.md', 'Plain prose about gardens, rivers and bread.', { title: 'Garden' })], { now });
  for (const word of negatives) {
    const r = run(vault, word);
    assert.notEqual(r.reason, 'identifier-not-found', `${word} must not be an identifier`);
    assert.equal(r.abstained, true, `${word} has no evidence here, so it should abstain for a normal reason`);
  }
  const mixed = run(vault, '2026 v2 mp3 follow-up and/or 1.0 iOS sorusu');
  assert.notEqual(mixed.reason, 'identifier-not-found');
});

test('negative words in a document still rank that document normally', () => {
  const idx = buildIndex([
    page('release.md', 'Release 2026 added v2 of the mp3 importer; follow-up items listed; and/or rules apply; iOS 1.0 app.', { title: 'Release' }),
    page('garden.md', 'Plain prose about gardens.', { title: 'Garden' }),
  ], { now });
  assert.equal(topPath(idx, 'follow-up items'), 'release.md');
  assert.equal(topPath(idx, 'mp3 importer'), 'release.md');
  assert.equal(topPath(idx, 'iOS 1.0'), 'release.md');
});

test('a mixed query with a vault identifier and negative words ranks the identifier document first', () => {
  const idx = buildIndex([
    page('widget.md', 'E_WIDGET_TIMEOUT is returned when the queue stalls.', { title: 'Widget' }),
    page('year.md', '2026 release notes, v2 and mp3 importer, follow-up items.', { title: 'Year' }),
  ], { now });
  assert.equal(topPath(idx, 'E_WIDGET_TIMEOUT 2026 v2 ne zaman döner?'), 'widget.md');
});

test('an exact identifier match outranks a document that only repeats the identifier words', () => {
  const idx = buildIndex([
    page('words.md', 'widget timeout widget timeout widget timeout queue queue', { title: 'Words' }),
    page('exact.md', 'The code E_WIDGET_TIMEOUT is returned once.', { title: 'Exact' }),
  ], { now });
  assert.equal(topPath(idx, 'E_WIDGET_TIMEOUT'), 'exact.md');
});

test('a query with only an unknown identifier abstains with identifier-not-found', () => {
  const r = run(kindIndex, 'E_NOT_IN_THE_VAULT_CODE');
  assert.equal(r.abstained, true);
  assert.equal(r.reason, 'identifier-not-found');
  assert.deepEqual(r.results, []);
});

test('a long natural-language question that mentions one unknown identifier is still ranked, not abstained', () => {
  const idx = buildIndex([
    page('queue.md', 'The queue retry policy uses exponential backoff when the widget module stalls.', { title: 'Queue' }),
    page('garden.md', 'Plain prose about gardens.', { title: 'Garden' }),
  ], { now });
  const r = run(idx, 'How does the queue retry policy with exponential backoff behave when the widget module stalls, and what about FOO_BAR_BAZ?');
  assert.equal(r.abstained, false);
  assert.equal(r.results[0].path, 'queue.md');
});

test('an identifier that is in the vault never abstains with identifier-not-found, in any vault field', () => {
  const idx = buildIndex([
    page('title.md', 'body text only', { title: 'TITLE_CODE_ONE' }),
    page('alias.md', 'body text only', { aliases: ['ALIAS_CODE_TWO'] }),
    page('keyword.md', 'body text only', { keywords: ['KEYWORD_CODE_THREE'] }),
    page('heading.md', 'body text only', { headings: ['ERR-HEAD-FOUR'] }),
    page('body.md', 'the body mentions BODY_CODE_FIVE explicitly', {}),
  ], { now });
  const expected = {
    TITLE_CODE_ONE: 'title.md', ALIAS_CODE_TWO: 'alias.md', KEYWORD_CODE_THREE: 'keyword.md', 'ERR-HEAD-FOUR': 'heading.md', BODY_CODE_FIVE: 'body.md',
  };
  for (const [id, file] of Object.entries(expected)) {
    const r = run(idx, id);
    assert.notEqual(r.reason, 'identifier-not-found', id);
    assert.equal(r.results[0]?.path, file, id);
  }
});

test('vault identifier path and basename variants never abstain with identifier-not-found', () => {
  const idx = buildIndex([
    page('services/dispatch.md', 'Dispatch uses src/lib/dispatch/retry.mjs and the RouteSnapshotCache for routes.', { title: 'Dispatch' }),
    page('garden.md', 'Plain prose about gardens.', { title: 'Garden' }),
  ], { now });
  const variants = [
    'src/lib/dispatch/retry.mjs', 'lib/dispatch/retry.mjs', 'dispatch/retry.mjs', 'retry.mjs',
    'SRC/LIB/DISPATCH/RETRY.MJS', 'Retry.MJS', 'retry.mjs?', '(dispatch/retry.mjs)', 'retry.mjs\'in ne yaptığı',
  ];
  for (const q of variants) {
    const r = run(idx, q);
    assert.notEqual(r.reason, 'identifier-not-found', q);
    assert.equal(r.results[0]?.path, 'services/dispatch.md', q);
  }
});

test('basename of a deeply nested vault path (more than 12 segments) still finds the document', () => {
  // The contract says a document identifier yields its contiguous sub-chains, so the basename of any
  // path that is in the vault must be findable. This is a deliberately deep path.
  const deep = `${Array.from({ length: 14 }, (_, i) => `d${i}`).join('/')}/deep_retry.mjs`;
  const idx = buildIndex([
    page('deep.md', `Deep module file ${deep} handles backoff.`, { title: 'Deep' }),
    page('garden.md', 'Plain prose about gardens.', { title: 'Garden' }),
  ], { now });
  const r = run(idx, 'deep_retry.mjs');
  assert.notEqual(r.reason, 'identifier-not-found', 'basename of a vault path must not abstain');
  assert.equal(r.results[0]?.path, 'deep.md');
});

test('dotted day-month-year dates (Turkish DD.MM.YYYY) are not identifiers: unknown date does not cause identifier-not-found', () => {
  // The contract lists dates among non-identifiers. A dotted three-part date must not be treated as a version.
  const idx = buildIndex([page('queue.md', 'Queue retry policy and backoff details.', { title: 'Queue' })], { now });
  const r = run(idx, '11.11.2025 tarihinde ne oldu?');
  assert.notEqual(r.reason, 'identifier-not-found', 'dotted date treated as an identifier');
});

test('dotted ISO-like dates (YYYY.MM.DD) are not identifiers either', () => {
  const idx = buildIndex([page('queue.md', 'Queue retry policy and backoff details.', { title: 'Queue' })], { now });
  const r = run(idx, '2026.11.11 queue retry policy');
  assert.notEqual(r.reason, 'identifier-not-found', 'dotted ISO-like date treated as an identifier');
});

test('an identifier-free query on a plain page still ranks normally', () => {
  // Parity check on identifier-free text: a plain word query returns the same result as the legacy rules would.
  const idx = buildIndex([page('plain.md', 'Backup archive restore steps for the vault.', { title: 'Backup' })], { now });
  const r = run(idx, 'backup archive');
  assert.equal(r.abstained, false);
  assert.equal(r.results[0].path, 'plain.md');
});

test('a superseded page carrying an identifier does not make that identifier findable', () => {
  // Superseded pages are not indexed (contract), so their identifiers are not in the vault index.
  const idx = buildIndex([
    page('old.md', 'Old behaviour of OLD_ONLY_CODE_ZED.', { title: 'Old', frontmatter: { status: 'superseded' } }),
    page('garden.md', 'Plain prose about gardens.', { title: 'Garden' }),
  ], { now });
  const r = run(idx, 'OLD_ONLY_CODE_ZED');
  assert.equal(r.abstained, true);
  assert.notEqual(r.results[0]?.path, 'old.md');
});

test('observation: short Turkish suffix glued to an identifier without apostrophe (diagnostic only)', (t) => {
  const idx = buildIndex([page('widget.md', 'E_WIDGET_TIMEOUT is returned on stall.', { title: 'Widget' })], { now });
  const r = run(idx, 'E_WIDGET_TIMEOUTda ne olur?');
  t.diagnostic(`E_WIDGET_TIMEOUTda (no apostrophe) -> abstained=${r.abstained} reason=${r.reason}`);
  assert.ok(typeof r.abstained === 'boolean');
});

test('observation: abbreviations with internal dots in short prose (diagnostic only)', (t) => {
  const idx = buildIndex([page('retry.md', 'Retries use backoff with jitter.', { title: 'Retry' })], { now });
  const short = run(idx, 'i.e. retries');
  const long = run(idx, 'Explain the retry behaviour, i.e. how the backoff with jitter is applied');
  t.diagnostic(`"i.e. retries" -> abstained=${short.abstained} reason=${short.reason}; long sentence -> abstained=${long.abstained}`);
  assert.equal(long.abstained, false, 'a long sentence with an abbreviation should still rank');
});

test('observation: query path not present in vault but basename is (diagnostic only)', (t) => {
  const idx = buildIndex([page('dispatch.md', 'Module src/lib/dispatch/retry.mjs handles backoff.', { title: 'Dispatch' })], { now });
  const skipped = run(idx, 'src/dispatch/retry.mjs');
  t.diagnostic(`"src/dispatch/retry.mjs" (non-contiguous sub-path) -> abstained=${skipped.abstained} reason=${skipped.reason}`);
  assert.ok(typeof skipped.abstained === 'boolean');
});
