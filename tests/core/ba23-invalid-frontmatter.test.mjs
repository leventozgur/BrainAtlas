// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearcher, loadPages, loadPagesDetailed } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
const QUERIES = ['zephyr', 'zephyr broken', 'healthy page', 'quokka'];

const healthy = (title, body) =>
  `---\ntitle: "${title}"\nstatus: confirmed\nverified: []\n---\n\n# ${title}\n\n${body}\n`;
const HEALTHY = {
  'wiki/a.md': healthy('Alpha', 'zephyr healthy page one.'),
  'wiki/sub/b.md': healthy('Beta', 'zephyr healthy page two with more text about quokka.'),
  'wiki/c.md': '# Plain\n\nzephyr plain page without frontmatter.\n',
};
const BROKEN_BODY = '\n\n# Broken\n\nzephyr broken zephyr broken body text.\n';
const THROWING = {
  'invalid-yaml': '---\ntitle: [unclosed\n---' + BROKEN_BODY,
  'duplicate-key': '---\ntitle: A\ntitle: B\n---' + BROKEN_BODY,
  'bom-invalid-yaml': '﻿---\ntitle: [unclosed\n---' + BROKEN_BODY,
};
const ACCEPTED = {
  unclosed: '---\ntitle: Broken\nstatus: confirmed\n' + BROKEN_BODY,
  'list-root': '---\n- one\n- two\n---' + BROKEN_BODY,
  'scalar-root': '---\njust a string\n---' + BROKEN_BODY,
  'bom-unclosed': '﻿---\ntitle: Broken\n' + BROKEN_BODY,
};

function vault(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ba23-fm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const wikiOf = (root) => path.join(root, 'wiki');
const wikiFiles = (map) => Object.fromEntries(Object.entries(map).map(([name, text]) => [`wiki/${name}.md`, text]));
const stateOf = (root) => path.join(root, 'state');
const runQueries = (searcher) => QUERIES.map((q) => searcher.search(q, { limit: 10, abstainThreshold: 0 }));

for (const [name, broken] of Object.entries(THROWING)) {
  test(`skipped page (${name}): createSearcher does not throw and healthy results equal the vault without the page`, (t) => {
    const withBroken = vault(t, { ...HEALTHY, 'wiki/broken.md': broken });
    const without = vault(t, HEALTHY);
    let searcher;
    assert.doesNotThrow(() => {
      searcher = createSearcher({ vaultDir: wikiOf(withBroken), stateDir: stateOf(withBroken), now });
    });
    const reference = createSearcher({ vaultDir: wikiOf(without), stateDir: stateOf(without), now });
    assert.deepEqual(runQueries(searcher), runQueries(reference));
    assert.ok(
      runQueries(searcher).some((r) => r.results.length > 0),
      'healthy pages must still be found'
    );
    for (const r of runQueries(searcher)) assert.ok(r.results.every((item) => item.path !== 'broken.md'));
  });
}

test('loadPages keeps its contract: it still throws E_INVALID_INPUT for an unparseable page, without the message text', (t) => {
  const root = vault(t, { ...HEALTHY, 'wiki/broken.md': THROWING['invalid-yaml'] });
  assert.throws(
    () => loadPages(wikiOf(root)),
    (error) => error.code === 'E_INVALID_INPUT' && !error.message.includes('unclosed')
  );
  const clean = vault(t, HEALTHY);
  const pages = loadPages(wikiOf(clean));
  assert.ok(Array.isArray(pages));
  assert.deepEqual(
    pages.map((p) => p.path),
    ['a.md', 'c.md', 'sub/b.md']
  );
  assert.deepEqual(Object.keys(pages[0]).sort(), [
    'aliases',
    'body',
    'frontmatter',
    'headings',
    'keywords',
    'path',
    'title',
  ]);
});

test('loadPagesDetailed.pages equals loadPages on the vault without the skipped pages, in a mixed vault', (t) => {
  const root = vault(t, { ...HEALTHY, ...wikiFiles(THROWING), ...wikiFiles(ACCEPTED) });
  const { pages, skipped } = loadPagesDetailed(wikiOf(root));
  assert.deepEqual(skipped, ['bom-invalid-yaml.md', 'duplicate-key.md', 'invalid-yaml.md']);
  const reference = loadPages(wikiOf(vault(t, { ...HEALTHY, ...wikiFiles(ACCEPTED) })));
  assert.deepEqual(pages, reference);
});

test('loadPagesDetailed reports exactly the throwing pages as skipped, by relative path and without content', (t) => {
  const root = vault(t, {
    ...HEALTHY,
    'wiki/broken.md': THROWING['invalid-yaml'],
    'wiki/sub/bad.md': THROWING['duplicate-key'],
  });
  const { pages, skipped } = loadPagesDetailed(wikiOf(root));
  assert.deepEqual(skipped, ['broken.md', 'sub/bad.md']);
  assert.deepEqual(
    pages.map((p) => p.path),
    ['a.md', 'c.md', 'sub/b.md']
  );
  assert.equal(JSON.stringify(skipped).includes('zephyr'), false);
});

test("pages that loadPages accepts are not skipped and keep main's shape: empty frontmatter, title from the heading", (t) => {
  const root = vault(t, wikiFiles(ACCEPTED));
  const { pages, skipped } = loadPagesDetailed(wikiOf(root));
  assert.deepEqual(skipped, []);
  const byPath = Object.fromEntries(pages.map((p) => [p.path, p]));
  for (const name of ['unclosed.md', 'list-root.md', 'scalar-root.md']) {
    assert.deepEqual(byPath[name].frontmatter, {}, name);
    assert.equal(byPath[name].title, 'Broken', name);
  }
  assert.equal(byPath['unclosed.md'].body, ACCEPTED.unclosed, 'an unclosed block keeps the whole text as body');
  assert.equal(byPath['list-root.md'].body, '# Broken\n\nzephyr broken zephyr broken body text.\n');
});

test('an unclosed opening block is indexed and searchable, as before', (t) => {
  const root = vault(t, { ...HEALTHY, 'wiki/unclosed.md': ACCEPTED.unclosed });
  const searcher = createSearcher({ vaultDir: wikiOf(root), stateDir: stateOf(root), now });
  assert.equal(searcher.search('zephyr broken', { abstainThreshold: 0 }).results[0].path, 'unclosed.md');
});

test('a loadPagesDetailed on a vault without broken pages skips nothing', (t) => {
  const root = vault(t, HEALTHY);
  assert.deepEqual(loadPagesDetailed(wikiOf(root)).skipped, []);
  assert.deepEqual(loadPagesDetailed(wikiOf(root)).pages, loadPages(wikiOf(root)));
});

test('a page with an empty frontmatter block is still indexed', (t) => {
  const root = vault(t, { 'wiki/empty.md': '---\n---\n\n# Empty\n\nzephyr empty page.\n' });
  const { pages, skipped } = loadPagesDetailed(wikiOf(root));
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    pages.map((p) => p.path),
    ['empty.md']
  );
});

test('an invalid verified date is still a neutral page, not a skipped one (BA-09 rule unchanged)', (t) => {
  const body =
    '---\nstatus: confirmed\nverified:\n  - date: 2026-02-30\n    evidence: review\n    scope: zephyr\n    source: wiki/s.md\n---\n\n# Dated\n\nzephyr dated page.\n';
  const root = vault(t, { 'wiki/dated.md': body });
  const { pages, skipped } = loadPagesDetailed(wikiOf(root));
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    pages.map((p) => p.path),
    ['dated.md']
  );
});

test('a page fixed after being skipped is indexed by the next refreshIfChanged, not remembered as skipped', (t) => {
  const root = vault(t, { ...HEALTHY, 'wiki/broken.md': THROWING['invalid-yaml'] });
  const searcher = createSearcher({ vaultDir: wikiOf(root), stateDir: stateOf(root), now });
  assert.equal(
    searcher.search('zephyr broken', { abstainThreshold: 0 }).results.some((r) => r.path === 'broken.md'),
    false
  );

  const fixed =
    '---\ntitle: "Broken"\nstatus: confirmed\nverified: []\n---\n\n# Broken\n\nzephyr broken zephyr broken body text, now fixed.\n';
  fs.writeFileSync(path.join(wikiOf(root), 'broken.md'), fixed);
  assert.equal(searcher.refreshIfChanged(), true);
  assert.equal(searcher.search('zephyr broken', { abstainThreshold: 0 }).results[0].path, 'broken.md');

  const cache = JSON.parse(fs.readFileSync(path.join(stateOf(root), 'retrieval-index.json'), 'utf8'));
  assert.equal(cache.skipped.includes('broken.md'), false);
  assert.ok(cache.index.docs.some((doc) => doc.page.path === 'broken.md'));
});

test('breaking a healthy page makes the next refresh skip it, and a fresh searcher agrees', (t) => {
  const root = vault(t, HEALTHY);
  const searcher = createSearcher({ vaultDir: wikiOf(root), stateDir: stateOf(root), now });
  assert.ok(searcher.search('quokka', { abstainThreshold: 0 }).results.some((r) => r.path === 'sub/b.md'));
  fs.writeFileSync(path.join(wikiOf(root), 'sub/b.md'), THROWING['duplicate-key']);
  assert.equal(searcher.refreshIfChanged(), true);
  assert.equal(searcher.search('quokka', { abstainThreshold: 0 }).results.length, 0);
  const fresh = createSearcher({ vaultDir: wikiOf(root), stateDir: stateOf(root), now });
  assert.equal(fresh.search('quokka', { abstainThreshold: 0 }).results.length, 0);
});

test('a cache written with a skipped page is accepted on the next start and gives the same results', (t) => {
  const root = vault(t, { ...HEALTHY, 'wiki/broken.md': THROWING['invalid-yaml'] });
  const first = createSearcher({ vaultDir: wikiOf(root), stateDir: stateOf(root), now });
  const cache = JSON.parse(fs.readFileSync(path.join(stateOf(root), 'retrieval-index.json'), 'utf8'));
  assert.deepEqual(cache.skipped, ['broken.md']);
  const again = createSearcher({ vaultDir: wikiOf(root), stateDir: stateOf(root), now });
  assert.deepEqual(runQueries(again), runQueries(first));
  assert.equal(
    again.snapshot().pages.some((p) => p.path === 'broken.md'),
    false
  );
});
