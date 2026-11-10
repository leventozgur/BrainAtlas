// SPDX-License-Identifier: MIT
// BA-00 blind acceptance: format, label and corpus-contract audit of the new dev sets and eval/corpus-ba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CORPUS_BA, DEV } from './helpers.mjs';
import { buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const pages = walk(CORPUS_BA).filter((f) => f.endsWith('.md'));
const pageRel = (abs) => relative(CORPUS_BA, abs).split('\\').join('/');
const pageText = new Map(pages.map((f) => [pageRel(f), readFileSync(f, 'utf8')]));
const corpusAll = [...pageText.values()].join('\n');
const loadSet = (name) => JSON.parse(readFileSync(join(DEV, name), 'utf8'));

const SETS = {
  identifier: { file: 'identifier-cases.json', category: 'identifier' },
  currentState: { file: 'current-state-cases.json', category: 'current-state' },
  multihop: { file: 'multihop-cases.json', category: 'multihop' },
  nearNegative: { file: 'near-negative-cases.json', category: 'near-negative' },
};
const ALLOWED_KEYS = new Set(['id', 'category', 'query', 'relevant', 'abstain', 'excluded', 'expectedHeading', 'requireAll', 'trToEn']);

test('corpus: every page has frontmatter with title, status and a quoted date-only generated value', () => {
  assert.equal(pages.length, 43);
  for (const [rel, text] of pageText) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, `${rel}: missing frontmatter`);
    assert.match(m[1], /^title: .+$/m, `${rel}: title`);
    assert.match(m[1], /^status: \S+$/m, `${rel}: status`);
    assert.match(m[1], /^generated: "\d{4}-\d{2}-\d{2}"$/m, `${rel}: generated must be quoted date`);
  }
});

test('corpus: body length is 150-600 words per page', () => {
  for (const [rel, text] of pageText) {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const words = body.split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 150 && words <= 600, `${rel}: ${words} words`);
  }
});

test('corpus: superseded pages declare an existing superseded_by replacement', () => {
  for (const [rel, text] of pageText) {
    if (!/^status: superseded$/m.test(text)) continue;
    const by = text.match(/^superseded_by: (\S+)$/m);
    assert.ok(by, `${rel}: superseded without superseded_by`);
    assert.ok(pageText.has(by[1]), `${rel}: superseded_by ${by[1]} missing`);
  }
});

test('corpus: synthetic content only (no e-mail, URL, IP, absolute home path or secret-like string)', () => {
  for (const [rel, text] of pageText) {
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, `${rel}: e-mail-like`);
    assert.doesNotMatch(text, /https?:\/\//, `${rel}: URL`);
    assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${rel}: IP`);
    assert.doesNotMatch(text, /\/Users\/|\/home\//, `${rel}: absolute path`);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|ghp_|-----BEGIN|password\s*[:=]/i, `${rel}: secret-like`);
  }
});

test('format: ids unique and valid, allowed keys only, categories match their set, relevant paths exist', () => {
  for (const [name, { file, category }] of Object.entries(SETS)) {
    const cases = loadSet(file);
    assert.ok(Array.isArray(cases), `${name}: array`);
    const ids = new Set();
    for (const item of cases) {
      assert.match(item.id, /^[\w-]{1,64}$/, `${name}: bad id ${item.id}`);
      assert.ok(!ids.has(item.id), `${name}: duplicate id ${item.id}`);
      ids.add(item.id);
      for (const key of Object.keys(item)) assert.ok(ALLOWED_KEYS.has(key), `${item.id}: unexpected key ${key}`);
      assert.equal(item.category, category, `${item.id}: category`);
      assert.equal(typeof item.query, 'string');
      assert.ok(Array.isArray(item.relevant), `${item.id}: relevant array`);
      assert.equal(typeof item.abstain, 'boolean', `${item.id}: abstain boolean`);
      for (const p of item.relevant) assert.ok(pageText.has(p), `${item.id}: relevant ${p} not in corpus`);
      if (item.relevant.length === 0) assert.equal(item.abstain, true, `${item.id}: empty relevant must abstain`);
      else assert.equal(item.abstain, false, `${item.id}: answerable must not abstain`);
    }
  }
});

test('format: TR and EN queries are mixed (each language 30-70% of new-set queries)', () => {
  const all = Object.values(SETS).flatMap(({ file }) => loadSet(file).map((c) => c.query));
  const tr = all.filter((q) => /[çğıöşüÇĞİÖŞÜ]|\b(nedir|hangi|nasıl|kaç|neden|ne zaman|hatası|nöbet|ve|ile|için|mı|mi|mu|mü|ne|nerede|çalışan|sürüm|sonra)\b/iu.test(q)).length;
  const ratio = tr / all.length;
  assert.ok(ratio >= 0.3 && ratio <= 0.7, `TR ratio ${ratio.toFixed(2)} over ${all.length} queries`);
});

test('identifier: 12 positive (token appears in query and relevant page) and 12 abstain (token absent from corpus)', () => {
  const cases = loadSet('identifier-cases.json');
  const positives = cases.filter((c) => !c.abstain);
  const abstains = cases.filter((c) => c.abstain);
  assert.equal(positives.length, 12);
  assert.equal(abstains.length, 12);
  // Positive identifiers and their expected token, taken from the query text.
  const positiveTokens = {
    'ident-01': 'E_WIDGET_TIMEOUT', 'ident-02': 'E_QUEUE_LOCKED', 'ident-03': 'E_ORCHARD_AUTH_EXPIRED', 'ident-04': 'a1b2c3d',
    'ident-05': 'rc.11', 'ident-06': 'src/lib/widget.mjs', 'ident-07': 'LarkspurClient.flushBatch', 'ident-08': '--drain-timeout',
    'ident-09': 'TIDEWATER_STALE_GRACE', 'ident-10': 'OrchardClient.resumeStream', 'ident-11': 'ERR_BASIL_LOCK_STALE', 'ident-12': 'ADR-009',
  };
  for (const c of positives) {
    const token = positiveTokens[c.id];
    assert.ok(token, `${c.id}: no expected token mapped`);
    assert.ok(c.query.includes(token), `${c.id}: query lacks ${token}`);
    assert.ok(pageText.get(c.relevant[0]).includes(token), `${c.id}: ${token} not in ${c.relevant[0]}`);
  }
  const abstainTokens = {
    'ident-13': 'E_WIDGET_QUOTA_FULL', 'ident-14': 'E_QUEUE_REPLAY_OVERFLOW', 'ident-15': 'E_ORCHARD_AUTH_REVOKED', 'ident-16': 'f9e8d7c',
    'ident-17': 'rc.12', 'ident-18': 'src/lib/gizmo.mjs', 'ident-19': 'OrchardClient.rotateCursor', 'ident-20': '--drain-retries',
    'ident-21': 'TIDEWATER_MAX_STALE_AGE_HOURS', 'ident-22': 'LarkspurClient.purgeTopic', 'ident-23': 'E_BASIL_CONFIG_CYCLE', 'ident-24': 'ERR_TIDEWATER_QUORUM_LOST',
  };
  for (const c of abstains) {
    const token = abstainTokens[c.id];
    assert.ok(token, `${c.id}: no expected token mapped`);
    assert.ok(c.query.includes(token), `${c.id}: query lacks ${token}`);
    assert.ok(!corpusAll.includes(token), `${c.id}: ${token} actually occurs in the corpus`);
  }
});

test('current-state: expectedHeading is an exact heading line in the relevant page', () => {
  for (const c of loadSet('current-state-cases.json')) {
    if (c.expectedHeading === undefined) continue;
    const text = pageText.get(c.relevant[0]);
    const headings = text.split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#{1,6} /, ''));
    assert.ok(headings.includes(c.expectedHeading), `${c.id}: "${c.expectedHeading}" not a heading in ${c.relevant[0]}`);
  }
});

test('current-state: a superseded page is never a relevant answer; its replacement is', () => {
  const superseded = [...pageText].filter(([, t]) => /^status: superseded$/m.test(t)).map(([rel]) => rel);
  assert.deepEqual(superseded.sort(), ['decisions/adr-002-cache-invalidation.md', 'decisions/adr-004-queue-ordering.md', 'decisions/adr-007-search-backend.md']);
  for (const set of ['current-state-cases.json', 'multihop-cases.json']) {
    for (const c of loadSet(set)) {
      for (const p of c.relevant) assert.ok(!superseded.includes(p), `${c.id}: superseded page ${p} listed as relevant`);
    }
  }
});

test('multihop: 2-3 relevant pages, requireAll true, and the relevant pages are linked to each other', () => {
  const linksOf = (rel) => {
    const text = pageText.get(rel);
    const out = new Set();
    for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) out.add(`${m[1]}.md`);
    for (const m of text.matchAll(/\]\(([^)\s]+\.md)\)/g)) out.add(m[1]);
    return out;
  };
  for (const c of loadSet('multihop-cases.json')) {
    assert.ok(c.relevant.length >= 2 && c.relevant.length <= 3, `${c.id}: ${c.relevant.length} pages`);
    assert.equal(c.requireAll, true, `${c.id}: requireAll`);
    assert.equal(new Set(c.relevant).size, c.relevant.length, `${c.id}: duplicate relevant`);
    // Connectivity over the induced link graph of the relevant pages.
    const nodes = c.relevant;
    const seen = new Set([nodes[0]]);
    const queue = [nodes[0]];
    while (queue.length) {
      const cur = queue.shift();
      for (const other of nodes) {
        if (seen.has(other)) continue;
        if (linksOf(cur).has(other) || linksOf(other).has(cur)) { seen.add(other); queue.push(other); }
      }
    }
    assert.equal(seen.size, nodes.length, `${c.id}: relevant pages not link-connected`);
  }
});

test('near-negative: every query is abstain with empty relevant (answer absence is checked by hand, see report)', () => {
  for (const c of loadSet('near-negative-cases.json')) {
    assert.equal(c.abstain, true, `${c.id}`);
    assert.deepEqual(c.relevant, [], `${c.id}`);
  }
});

test('retrieval: superseded pages never appear in results for any new-set query or ADR probe', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  const index = buildIndex(loadPages(CORPUS_BA), { now });
  const superseded = new Set(['decisions/adr-002-cache-invalidation.md', 'decisions/adr-004-queue-ordering.md', 'decisions/adr-007-search-backend.md']);
  const queries = [
    ...['identifier-cases.json', 'current-state-cases.json', 'multihop-cases.json', 'near-negative-cases.json'].flatMap((f) => loadSet(f).map((c) => c.query)),
    'ADR-002 cache invalidation decision', 'ADR-004 queue ordering', 'ADR-007 search backend', 'cache invalidation', 'queue ordering',
  ];
  for (const q of queries) {
    const res = search(index, q, { limit: 10, asOf: now, abstainThreshold: 0 });
    for (const r of res.results ?? []) assert.ok(!superseded.has(r.path), `${q} returned superseded ${r.path}`);
  }
});
