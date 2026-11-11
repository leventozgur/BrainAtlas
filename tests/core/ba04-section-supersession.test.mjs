// SPDX-License-Identifier: MIT
// BA-04: date-aware section choice for snippets, and superseded routing (`supersedes`) with its cache validation.
// Hermetic: in-memory pages and temporary directories only; no network, no HOME access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createSearcher, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
const page = (file, body, frontmatter = {}, title = 'Topic') => ({ path: file, title, aliases: [], keywords: [], headings: [], body, frontmatter });
const top = (index, query, options = {}) => search(index, query, { limit: 5, asOf: now, ...options }).results[0];

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba04-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- Section choice -------------------------------------------------------------------------------------------------

test('among equally matching dated sections, the newest ISO date wins', () => {
  const body = '# Topic\n## Update 2025-01-10 — ttl alpha\nalpha evidence old\n## Update 2026-02-02 — ttl beta\nalpha evidence new\n## Update 2025-06-02 — ttl gamma\nalpha evidence middle';
  const result = top(buildIndex([page('a.md', body)], { now }), 'alpha');
  assert.equal(result.heading, 'Update 2026-02-02 — ttl beta');
  assert.equal(result.snippet, '## Update 2026-02-02 — ttl beta\nalpha evidence new');
});

test('the newest date is compared across formats: DD.MM.YYYY, ISO with time, and ISO date only', () => {
  const body = '# Topic\n## Update 2026-03-03 — iso day\nalpha one\n## Update 04.03.2026 — dotted\nalpha two\n## Update 2026-03-04T09:00Z — early\nalpha three\n## Update 2026-03-04T17:30Z — late\nalpha four';
  assert.equal(top(buildIndex([page('a.md', body)], { now }), 'alpha').heading, 'Update 2026-03-04T17:30Z — late');
  const dotted = '# Topic\n## Update 2026-03-03 — iso day\nalpha one\n## Update 04.03.2026 — dotted\nalpha two';
  assert.equal(top(buildIndex([page('b.md', dotted)], { now }), 'alpha').heading, 'Update 04.03.2026 — dotted');
});

test('a "Current state" heading is preferred over newer dated updates; "Güncel durum" is the same marker', () => {
  const body = '# Topic\n## Current state (2026-06) — default 45\nalpha value\n## Update 2026-08-01 — other\nalpha value again';
  assert.equal(top(buildIndex([page('a.md', body)], { now }), 'alpha').heading, 'Current state (2026-06) — default 45');
  const turkish = '# Konu\n## Update 2026-01-01 — eski\nalpha değer\n## Güncel durum\nalpha değer güncel';
  assert.equal(top(buildIndex([page('tr.md', turkish)], { now }), 'alpha').heading, 'Güncel durum');
});

test('a page without dated or current headings keeps the best-scoring section, first one on ties', () => {
  const body = '# Topic\n## First\nalpha beta\n## Second\nalpha\n## Third\nalpha';
  assert.equal(top(buildIndex([page('plain.md', body)], { now }), 'alpha beta').heading, 'First');
  const tie = '# Topic\n## Alpha one\nalpha\n## Alpha two\nalpha';
  assert.equal(top(buildIndex([page('tie.md', tie)], { now }), 'alpha').heading, 'Alpha one');
});

test('equal dates prefer the higher term score, then the earlier section', () => {
  const body = '# Topic\n## Update 2026-01-01 — weak\nalpha\n## Update 2026-01-01 — strong\nalpha beta gamma';
  assert.equal(top(buildIndex([page('a.md', body)], { now }), 'alpha beta gamma').heading, 'Update 2026-01-01 — strong');
  const same = '# Topic\n## Update 2026-01-01 — first\nalpha\n## Update 2026-01-01 — second\nalpha';
  assert.equal(top(buildIndex([page('b.md', same)], { now }), 'alpha').heading, 'Update 2026-01-01 — first');
});

test('a dated section after the as-of date is not preferred over the one in force', () => {
  const body = '# Topic\n## Update 2025-01-01 — in force\nalpha value\n## Update 2099-01-01 — planned\nalpha value planned';
  const index = buildIndex([page('a.md', body)], { now });
  assert.equal(top(index, 'alpha').heading, 'Update 2025-01-01 — in force');
  assert.equal(top(index, 'alpha', { asOf: new Date('2100-01-01T00:00:00Z') }).heading, 'Update 2099-01-01 — planned');
});

test('a newer section on another topic is not selected when it does not match the query well', () => {
  const body = '# Topic\n## Update 2025-01-01 — retry limit\nretry limit consumer message failed\n## Update 2026-07-01 — renamed topic\ndead letter renamed';
  const result = top(buildIndex([page('a.md', body)], { now }), 'retry limit consumer message failed');
  assert.equal(result.heading, 'Update 2025-01-01 — retry limit');
});

test('headings inside code fences do not count as dated sections', () => {
  const body = '# Topic\n## Update 2025-01-01 — real\nalpha evidence\n```md\n## Update 2030-01-01 — fake\nalpha fake\n```';
  const result = top(buildIndex([page('a.md', body)], { now }), 'alpha');
  assert.equal(result.heading, 'Update 2025-01-01 — real');
});

test('invalid calendar dates are ignored, so the valid older date still counts', () => {
  const body = '# Topic\n## Update 2025-01-01 — valid\nalpha value\n## Update 2026-02-30 — invalid\nalpha value';
  assert.equal(top(buildIndex([page('a.md', body)], { now }), 'alpha').heading, 'Update 2025-01-01 — valid');
});

test('snippet budget and truncation still apply to a date-selected section', () => {
  const body = '# Topic\n## Update 2025-01-01 — old\nalpha old\n## Update 2026-01-01 — new\nalpha new evidence';
  const result = search(buildIndex([page('a.md', body)], { now }), 'alpha', { limit: 1, budgetChars: 12 }).results[0];
  assert.equal(result.heading, 'Update 2026-01-01 — new');
  assert.equal(result.snippet.length, 12);
  assert.ok(result.snippet.endsWith('…'));
});

test('ordinary results carry no supersedes field', () => {
  const result = top(buildIndex([page('plain.md', '# Topic\nalpha')], { now }), 'alpha');
  assert.equal(Object.hasOwn(result, 'supersedes'), false);
});

// --- Superseded routing --------------------------------------------------------------------------------------------

test('a replacement page lists the superseded page it replaces; the old page stays out of the index', () => {
  const index = buildIndex([
    page('new.md', 'replacement alpha guide', {}, 'New guide'),
    page('old.md', 'retired alpha guide', { status: 'superseded', superseded_by: 'new.md' }, 'Old guide'),
  ], { now });
  const result = search(index, 'alpha guide', { limit: 5 });
  assert.deepEqual(result.results.map(r => r.path), ['new.md']);
  assert.deepEqual(result.results[0].supersedes, ['old.md']);
  assert.deepEqual(index.supersedes['new.md'], ['old.md']);
});

test('a chain A -> B -> C routes both A and B to C, and B is not indexed', () => {
  const index = buildIndex([
    page('a.md', 'first version', { superseded_by: 'b.md' }),
    page('b.md', 'second version', { status: 'superseded', superseded_by: 'c.md' }),
    page('c.md', 'current version'),
  ], { now });
  assert.deepEqual(index.supersedes['c.md'], ['a.md', 'b.md']);
  assert.equal(index.supersedes['b.md'], undefined);
  assert.equal(index.docs.length, 1);
  assert.deepEqual(search(index, 'version', { limit: 5 }).results.map(r => r.path), ['c.md']);
  assert.deepEqual(search(index, 'version', { limit: 5 }).results[0].supersedes, ['a.md', 'b.md']);
});

test('a cycle routes nothing and both pages stay out of the index', () => {
  const index = buildIndex([
    page('x.md', 'cycle alpha', { superseded_by: 'y.md' }),
    page('y.md', 'cycle beta', { superseded_by: 'x.md' }),
    page('z.md', 'unrelated gamma'),
  ], { now });
  assert.equal(Object.keys(index.supersedes).length, 0);
  assert.equal(index.docs.length, 1);
  assert.deepEqual(search(index, 'cycle alpha beta', { limit: 5 }).results, []);
});

test('a self-reference and a missing target route nothing', () => {
  const index = buildIndex([
    page('self.md', 'self alpha', { superseded_by: 'self.md' }),
    page('gone.md', 'gone alpha', { superseded_by: 'ghost.md' }),
    page('live.md', 'live gamma'),
  ], { now });
  assert.equal(Object.keys(index.supersedes).length, 0);
  assert.equal(index.docs.length, 1);
});

test('a superseded page without a usable target is excluded and routes nothing', () => {
  const index = buildIndex([
    page('status.md', 'status only alpha', { status: 'superseded' }),
    page('null.md', 'null target alpha', { superseded_by: null }),
    page('number.md', 'numeric target alpha', { superseded_by: 5 }),
    page('live.md', 'live gamma'),
  ], { now });
  assert.equal(Object.keys(index.supersedes).length, 0);
  assert.equal(index.docs.length, 1);
});

test('several superseded pages for one replacement are listed together, sorted', () => {
  const index = buildIndex([
    page('replacement.md', 'replacement delta'),
    page('zeta-old.md', 'old zeta', { superseded_by: 'replacement.md' }),
    page('alpha-old.md', 'old alpha', { status: 'superseded', superseded_by: 'replacement.md' }),
  ], { now });
  assert.deepEqual(index.supersedes['replacement.md'], ['alpha-old.md', 'zeta-old.md']);
  assert.deepEqual(search(index, 'delta', { limit: 5 }).results[0].supersedes, ['alpha-old.md', 'zeta-old.md']);
});

test('a superseded page does not change the ranking of the replacement', () => {
  const plain = buildIndex([page('new.md', 'delta evidence', {}, 'Other')], { now });
  const routed = buildIndex([page('new.md', 'delta evidence', {}, 'Other'), page('old.md', 'retired words', { superseded_by: 'new.md' }, 'Retired')], { now });
  const strip = (r) => r.results.map(x => ({ path: x.path, score: x.score, snippet: x.snippet }));
  assert.deepEqual(strip(search(routed, 'delta', { limit: 5 })), strip(search(plain, 'delta', { limit: 5 })));
});

// --- Cache ---------------------------------------------------------------------------------------------------------

function writeVault(vault) {
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'new.md'), '---\ntitle: New\n---\n# New\nreplacement epsilon');
  fs.writeFileSync(path.join(vault, 'old.md'), '---\nstatus: superseded\nsuperseded_by: new.md\n---\n# Old\nretired epsilon');
}

test('the cache stores the routing, reloads it, and rebuilds when it is missing or inconsistent', async t => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  writeVault(vault);
  const cacheFile = path.join(state, 'retrieval-index.json');
  createSearcher({ vaultDir: vault, stateDir: state, now });
  const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(written.index.supersedes, { 'new.md': ['old.md'] });

  const reloaded = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.deepEqual(reloaded.search('epsilon', { limit: 5 }).results[0].supersedes, ['old.md']);

  for (const tamper of [
    (d) => { delete d.index.supersedes; },
    (d) => { d.index.supersedes = { 'old.md': ['old.md'] }; },
    (d) => { d.index.supersedes = { 'new.md': ['new.md'] }; },
    (d) => { d.index.supersedes = { 'new.md': [] }; },
    (d) => { d.index.supersedes = []; },
  ]) {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    tamper(data);
    fs.writeFileSync(cacheFile, JSON.stringify(data));
    const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
    assert.deepEqual(searcher.search('epsilon', { limit: 5 }).results[0].supersedes, ['old.md']);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).index.supersedes, { 'new.md': ['old.md'] });
  }
});
