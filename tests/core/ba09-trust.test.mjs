// SPDX-License-Identifier: MIT
// BA-09: provenance trust in ranking. Hermetic: in-memory pages and temporary directories only; no network, no HOME access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createSearcher, loadPages, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
const record = { date: '2026-01-12', evidence: 'review', scope: 'backup', source: 'wiki/sources/a.md' };
const BODY = 'backup rotation schedule';
const page = (file, frontmatter = {}, body = BODY) => ({ path: file, title: 'Backup policy', aliases: [], keywords: [], headings: [], body, frontmatter });
const QUERY = 'backup rotation';
const one = (frontmatter) => search(buildIndex([page('p.md', frontmatter)], { now }), QUERY).results[0];
// `verified` for verified pages, `weak` for weak pages, `neutral` when the result carries no trust field.
const classOf = (frontmatter) => { const r = one(frontmatter); assert.ok(r, 'page should be returned'); return r.trust ?? 'neutral'; };

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba09-trust-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- Classification ---------------------------------------------------------------------------------------------------

test('confirmed with one valid verified record is verified', () => {
  assert.equal(classOf({ status: 'confirmed', verified: [record] }), 'verified');
});

test('confirmed without a valid record is neutral', () => {
  assert.equal(classOf({ status: 'confirmed' }), 'neutral');
  assert.equal(classOf({ status: 'confirmed', verified: [] }), 'neutral');
  assert.equal(classOf({ status: 'confirmed', verified: record }), 'neutral');
  assert.equal(classOf({ status: 'confirmed', verified: ['2026-01-12'] }), 'neutral');
  assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, date: '2026-02-30' }] }), 'neutral');
  assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, date: 'yesterday' }] }), 'neutral');
  assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, date: new Date('not a date') }] }), 'neutral');
  for (const key of ['evidence', 'scope', 'source']) {
    assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, [key]: '   ' }] }), 'neutral', `blank ${key}`);
    assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, [key]: 7 }] }), 'neutral', `non-string ${key}`);
    const { [key]: _omitted, ...rest } = record;
    assert.equal(classOf({ status: 'confirmed', verified: [rest] }), 'neutral', `missing ${key}`);
  }
});

test('one valid record among invalid ones is enough for verified', () => {
  const verified = [{ date: '2026-02-30', evidence: 'x', scope: 'y', source: 'z' }, 'not a record', record];
  assert.equal(classOf({ status: 'confirmed', verified }), 'verified');
});

test('dates: quoted, timestamp, Date object and unquoted YAML dates are accepted when valid', () => {
  assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, date: '2026-01-12T10:30:00Z' }] }), 'verified');
  assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, date: new Date('2026-01-12T00:00:00Z') }] }), 'verified');
  assert.equal(classOf({ status: 'confirmed', verified: [{ ...record, date: '2026-01-12T10:30' }] }), 'neutral');
});

test('proposed and disputed pages are weak, with or without valid records', () => {
  for (const status of ['proposed', 'disputed']) {
    assert.equal(classOf({ status }), 'weak', status);
    assert.equal(classOf({ status, verified: [record] }), 'weak', `${status} with a record`);
  }
});

test('other statuses, no status and superseded-looking statuses outside the three are neutral', () => {
  for (const frontmatter of [{}, { status: 'draft' }, { status: 'active' }, { status: 'Confirmed', verified: [record] }, { status: 'verified', verified: [record] }, { status: null }]) {
    assert.equal(classOf(frontmatter), 'neutral', JSON.stringify(frontmatter));
  }
});

test('file-level dates: quoted and unquoted valid dates verify; an impossible quoted date does not', async t => {
  const dir = temp(t);
  const body = (date) => `---\ntitle: "Backup policy"\nstatus: confirmed\ngenerated: "2026-01-10"\nverified:\n  - date: ${date}\n    evidence: "review"\n    scope: "backup"\n    source: "wiki/sources/a.md"\n---\n# Backup policy\n\n${BODY}\n`;
  fs.writeFileSync(path.join(dir, 'quoted.md'), body('"2026-01-12"'));
  fs.writeFileSync(path.join(dir, 'unquoted.md'), body('2026-01-12'));
  fs.writeFileSync(path.join(dir, 'impossible.md'), body('"2026-02-30"'));
  const index = buildIndex(loadPages(dir), { now });
  const trust = Object.fromEntries(search(index, QUERY, { limit: 10 }).results.map(r => [r.path, r.trust ?? 'neutral']));
  assert.deepEqual(trust, { 'quoted.md': 'verified', 'unquoted.md': 'verified', 'impossible.md': 'neutral' });
});

test('result shape: trust appears only for verified and weak pages', () => {
  const index = buildIndex([page('a-weak.md', { status: 'proposed' }), page('b-verified.md', { status: 'confirmed', verified: [record] }), page('c-neutral.md', { status: 'draft' })], { now });
  const byPath = Object.fromEntries(search(index, QUERY, { limit: 10 }).results.map(r => [r.path, r]));
  assert.equal(byPath['a-weak.md'].trust, 'weak');
  assert.equal(byPath['b-verified.md'].trust, 'verified');
  assert.equal(Object.hasOwn(byPath['c-neutral.md'], 'trust'), false);
});

// --- Multiplier and ordering ------------------------------------------------------------------------------------------

// Single-page indexes give the same lexical score for identical bodies, so the trust factor is the only difference.
const scoreWith = (frontmatter, query = `${QUERY} missingterm`) => search(buildIndex([page('p.md', frontmatter)], { now }), query).results[0].score;

test('verified scores are 1.5 times and weak scores 0.9 times the neutral score for the same text', () => {
  const neutral = scoreWith({});
  assert.ok(neutral > 0 && neutral < 1, 'the neutral score should be below 1 so the compression is in effect');
  assert.ok(Math.abs(scoreWith({ status: 'confirmed', verified: [record] }) - neutral * 1.5) < 1e-12);
  assert.ok(Math.abs(scoreWith({ status: 'proposed' }) - neutral * 0.9) < 1e-12);
  assert.equal(scoreWith({ status: 'draft' }), neutral);
});

test('at equal lexical score a verified page ranks above a weak page that sorts first by path', () => {
  const index = buildIndex([page('a-weak.md', { status: 'disputed', verified: [record] }), page('z-verified.md', { status: 'confirmed', verified: [record] })], { now });
  const results = search(index, QUERY, { limit: 10 }).results;
  assert.deepEqual(results.map(r => r.path), ['z-verified.md', 'a-weak.md']);
});

test('at equal lexical score a verified page moves above a neutral page that sorts first by path', () => {
  const index = buildIndex([page('a-neutral.md', {}), page('b-verified.md', { status: 'confirmed', verified: [record] })], { now });
  assert.deepEqual(search(index, QUERY, { limit: 10 }).results.map(r => r.path), ['b-verified.md', 'a-neutral.md']);
});

// --- Abstention is decided before trust --------------------------------------------------------------------------------

test('a verified page whose lexical score is below the threshold still abstains', () => {
  const neutral = scoreWith({});
  const index = buildIndex([page('p.md', { status: 'confirmed', verified: [record] })], { now });
  const result = search(index, `${QUERY} missingterm`, { abstainThreshold: neutral + 1e-6 });
  assert.equal(result.abstained, true);
  assert.equal(result.reason, 'below_threshold');
  assert.deepEqual(result.results, []);
});

test('a weak page whose lexical score clears the threshold is still answered, although its score is lower', () => {
  const neutral = scoreWith({});
  const index = buildIndex([page('p.md', { status: 'proposed' })], { now });
  const result = search(index, `${QUERY} missingterm`, { abstainThreshold: neutral - 1e-6 });
  assert.equal(result.abstained, false);
  assert.deepEqual(result.results.map(r => [r.path, r.trust]), [['p.md', 'weak']]);
  assert.ok(Math.abs(result.results[0].score - neutral * 0.9) < 1e-12);
});

// --- Cache -----------------------------------------------------------------------------------------------------------

test('trust survives the persisted cache and a cache with a wrong or missing trust field is rebuilt', async t => {
  const dir = temp(t);
  const vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault); fs.mkdirSync(state);
  fs.writeFileSync(path.join(vault, 'a-weak.md'), `---\ntitle: "Backup policy"\nstatus: proposed\n---\n# Backup policy\n\n${BODY}\n`);
  fs.writeFileSync(path.join(vault, 'b-verified.md'), `---\ntitle: "Backup policy"\nstatus: confirmed\nverified:\n  - date: "2026-01-12"\n    evidence: "review"\n    scope: "backup"\n    source: "wiki/sources/a.md"\n---\n# Backup policy\n\n${BODY}\n`);
  const cacheFile = path.join(state, 'retrieval-index.json');
  const trusts = (searcher) => Object.fromEntries(searcher.search(QUERY, { limit: 10, asOf: now }).results.map(r => [r.path, r.trust ?? 'neutral']));
  const expected = { 'a-weak.md': 'weak', 'b-verified.md': 'verified' };

  const first = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.deepEqual(trusts(first), expected);
  assert.deepEqual(trusts(createSearcher({ vaultDir: vault, stateDir: state, now })), expected, 'cache hit');

  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const weakDoc = cache.index.docs.find(d => d.page.path === 'a-weak.md');
  weakDoc.trust = 'verified';
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  assert.deepEqual(trusts(createSearcher({ vaultDir: vault, stateDir: state, now })), expected, 'forged trust is rejected');

  const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  for (const doc of stored.index.docs) delete doc.trust;
  fs.writeFileSync(cacheFile, JSON.stringify(stored));
  assert.deepEqual(trusts(createSearcher({ vaultDir: vault, stateDir: state, now })), expected, 'pre-BA-09 cache is rebuilt');
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).index.docs.every(d => typeof d.trust === 'string'), true);
});
