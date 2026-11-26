// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createSearcher, loadPages, search, tokens } from '../../../packages/core/src/retrieval/index.mjs';

const ASOF = new Date('2026-02-01T00:00:00Z');
const OPTS = { limit: 5, asOf: ASOF };
const WORDS = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf'];
const QUERIES = ['alpha', 'delta'];
const PROTO_OWN_NAMES = Object.getOwnPropertyNames(Object.prototype).sort();
const PROTO_OF_OBJECT = Object.getPrototypeOf({});
const canon = (x) => JSON.stringify(x);

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba46-proto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function assertNoPollution(label) {
  assert.equal({}.polluted, undefined, `${label}: ({ }).polluted must stay undefined`);
  assert.equal({}.marker, undefined, `${label}: ({ }).marker must stay undefined (forged __proto__ payload)`);
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.prototype).sort(),
    PROTO_OWN_NAMES,
    `${label}: Object.prototype gained own properties`
  );
  assert.equal(Object.getPrototypeOf({}), PROTO_OF_OBJECT, `${label}: the prototype of a plain object changed`);
}
function wikiFixture(t) {
  const home = tmpdir(t);
  const wiki = path.join(home, 'wiki'),
    stateDir = path.join(home, 'state');
  fs.mkdirSync(wiki, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { home, wiki, stateDir, cache: path.join(stateDir, 'retrieval-index.json') };
}

function textFixture(t) {
  const f = wikiFixture(t);
  const pages = {
    'proto.md':
      '---\ntitle: __proto__ Key Page\n__proto__: ba46-proto-value\n---\n# __proto__ Chain\n__proto__ appears in this body.\n',
    'constructor.md':
      '---\ntitle: Constructor Key Page\nconstructor: ba46-constructor-value\n---\n# Constructor Chain\nconstructor appears in this body.\n',
    'prototype.md':
      '---\ntitle: Prototype Key Page\nprototype: ba46-prototype-value\n---\n# Prototype Chain\nprototype appears in this body.\n',
    'hasown.md':
      '---\ntitle: hasOwnProperty Key Page\nhasOwnProperty: ba46-hasown-value\n---\n# hasOwnProperty Chain\nhasOwnProperty appears in this body.\n',
    'tostring.md':
      '---\ntitle: toString Key Page\ntoString: ba46-tostring-value\n---\n# toString Chain\ntoString appears in this body.\n',
    'valueof.md':
      '---\ntitle: valueOf Key Page\nvalueOf: ba46-valueof-value\n---\n# valueOf Chain\nvalueOf appears in this body.\n',
    'clean.md': '---\ntitle: Clean Page\n---\n# Clean\nalpha bravo charlie, nothing suspicious in this text.\n',
  };
  for (const [name, text] of Object.entries(pages)) fs.writeFileSync(path.join(f.wiki, name), text);
  return f;
}
function pagesContaining(wiki, word) {
  return fs
    .readdirSync(wiki)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => fs.readFileSync(path.join(wiki, name), 'utf8').toLowerCase().includes(word.toLowerCase()))
    .sort();
}
function resultPaths(result) {
  return result.results.map((entry) => entry.path).sort();
}

test('page text with __proto__/constructor/prototype/hasOwnProperty/toString/valueOf builds and searches without pollution', (t) => {
  const f = textFixture(t);
  const pages = loadPages(f.wiki);
  let index;
  assert.doesNotThrow(() => {
    index = buildIndex(pages, { now: ASOF });
  }, 'buildIndex must not throw on prototype-chain words in page text');
  assertNoPollution('after buildIndex');
  assert.equal(Object.getPrototypeOf(index.postings), null, 'the built postings map must stay null-prototype');
  assert.ok(
    Object.hasOwn(index.postings, 'constructor'),
    'constructor.md stores "constructor" as an ordinary own term'
  );
  assert.deepEqual(
    index.postings.constructor.map(([id]) => index.docs[id].page.path),
    ['constructor.md']
  );
  for (const word of WORDS) {
    let result;
    assert.doesNotThrow(() => {
      result = search(index, word, OPTS);
    }, `search("${word}") must not throw`);
    assert.equal(result.abstained, false, `search("${word}") must answer: the fixture contains the word`);
    assertNoPollution(`after search("${word}")`);
  }
  const searcher = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  assertNoPollution('after createSearcher over pages with prototype-chain words');
  const loaded = searcher.snapshot().index;
  assert.equal(Object.getPrototypeOf(loaded.postings), null, 'the decoded postings map must stay null-prototype');
  assert.ok(
    Object.hasOwn(loaded.postings, 'constructor'),
    'the constructor page survives the cache round-trip as an own term'
  );
  for (const word of WORDS) {
    assert.doesNotThrow(() => searcher.search(word, OPTS), `cached search("${word}") must not throw`);
    assertNoPollution(`after cached search("${word}")`);
  }
});

test('page text searches return only pages whose text contains the queried word', (t) => {
  const f = textFixture(t);
  const index = buildIndex(loadPages(f.wiki), { now: ASOF });
  for (const word of WORDS) {
    const expected = pagesContaining(f.wiki, word);
    assert.ok(expected.length > 0, `fixture error: no page contains "${word}"`);
    const returned = resultPaths(search(index, word, OPTS));
    assert.ok(returned.length > 0, `search("${word}") returned nothing although ${expected.join(', ')} contains it`);
    const foreign = returned.filter((p) => !expected.includes(p));
    assert.deepEqual(foreign, [], `search("${word}") returned pages without the word: ${foreign.join(', ')}`);
  }
});

function cacheFixture(t) {
  const f = wikiFixture(t);
  fs.writeFileSync(path.join(f.wiki, 'alpha.md'), '---\ntitle: Alpha\n---\n# Alpha\nalpha bravo charlie notes\n');
  fs.writeFileSync(path.join(f.wiki, 'delta.md'), '# Delta\ndelta echo foxtrot\n');
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const index = buildIndex(loadPages(f.wiki), { now: ASOF });
  const fresh = Object.fromEntries(QUERIES.map((q) => [q, canon(search(index, q, OPTS))]));
  return { ...f, valid: fs.readFileSync(f.cache, 'utf8'), fresh };
}
const VALID_FLAT_ALPHA = '[0,1,0,0,0]';
const FORGERIES = [
  {
    name: 'postings key "__proto__"',
    key: '__proto__',
    forge: (s) => s.replace('"postings":{', `"postings":{"__proto__":${VALID_FLAT_ALPHA},`),
    verify: (d) =>
      assert.ok(
        Object.hasOwn(d.index.postings, '__proto__'),
        'fixture error: __proto__ is not an own posting key after JSON.parse'
      ),
  },
  {
    name: 'postings key "constructor"',
    key: 'constructor',
    forge: (s) => s.replace('"postings":{', `"postings":{"constructor":${VALID_FLAT_ALPHA},`),
    verify: (d) =>
      assert.ok(
        Object.hasOwn(d.index.postings, 'constructor'),
        'fixture error: constructor is not an own posting key after JSON.parse'
      ),
  },
  {
    name: 'postings key "prototype"',
    key: 'prototype',
    forge: (s) => s.replace('"postings":{', `"postings":{"prototype":${VALID_FLAT_ALPHA},`),
    verify: (d) =>
      assert.ok(
        Object.hasOwn(d.index.postings, 'prototype'),
        'fixture error: prototype is not an own posting key after JSON.parse'
      ),
  },
  {
    name: 'document field "__proto__"',
    key: null,
    forge: (s) => s.replace('"docs":[{', '"docs":[{"__proto__":{"marker":"ba46"},'),
    verify: (d) =>
      assert.ok(
        Object.hasOwn(d.index.docs[0], '__proto__'),
        'fixture error: the document has no own __proto__ field after JSON.parse'
      ),
  },
  {
    name: 'page field "__proto__"',
    key: null,
    forge: (s) => s.replace('"page":{"path":"', '"page":{"__proto__":{"marker":"ba46"},"path":"'),
    verify: (d) =>
      assert.ok(
        Object.hasOwn(d.index.docs[0].page, '__proto__'),
        'fixture error: the page has no own __proto__ field after JSON.parse'
      ),
  },
];

for (const { name, key, forge, verify } of FORGERIES) {
  test(`forged cache with ${name}: loads and searches without pollution, unrelated queries unchanged`, (t) => {
    const f = cacheFixture(t);
    const forged = forge(f.valid);
    assert.notEqual(forged, f.valid, `fixture error: forgery did not change the cache text for ${name}`);
    verify(JSON.parse(forged));
    fs.writeFileSync(f.cache, forged);
    let searcher;
    assert.doesNotThrow(() => {
      searcher = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
    }, `${name}: createSearcher must not throw`);
    const after = fs.readFileSync(f.cache, 'utf8');
    const loaded = after === forged;
    if (loaded) assert.equal(after, forged, `${name}: the forged cache must be used as it is, not rewritten`);
    else {
      t.diagnostic(`rejected: ${name} — the decoder rebuilt the cache instead of loading it`);
      assert.notEqual(after, forged, `${name}: the cache was neither loaded nor rebuilt`);
    }
    assertNoPollution(`after loading the cache with ${name}`);
    let index;
    assert.doesNotThrow(() => {
      index = searcher.snapshot().index;
    }, `${name}: snapshot must not throw`);
    assertNoPollution(`after snapshot of the cache with ${name}`);
    assert.equal(
      Object.getPrototypeOf(index.postings),
      null,
      `${name}: the decoded postings map must stay null-prototype`
    );
    if (loaded && key) {
      assert.ok(Object.hasOwn(index.postings, key), `${name}: the forged posting key must survive the decode`);
      assert.deepEqual(
        index.postings[key],
        [[0, [1, 0, 0, 0]]],
        `${name}: the forged list must be readable by an own-key lookup`
      );
      assertNoPollution(`after an own-key read of postings["${key}"]`);
      const built = buildIndex(loadPages(f.wiki), { now: ASOF });
      const queryTerms = tokens(key, true);
      if (queryTerms.includes(key)) {
        assert.doesNotThrow(() => search(index, key, OPTS), `${name}: search must not throw`);
        assertNoPollution(`after search("${key}") on the forged cache`);
      } else {
        assert.ok(
          !queryTerms.includes(key),
          `fixture note: "${key}" is not a query term (tokens() drops '_' and stems)`
        );
        assert.equal(
          canon(search(index, key, OPTS)),
          canon(search(built, key, OPTS)),
          `${name}: the raw key must not be reachable as a query term`
        );
      }
    }
    for (const word of [...WORDS, ...QUERIES]) {
      assert.doesNotThrow(() => searcher.search(word, OPTS), `${name}: search("${word}") must not throw`);
      assertNoPollution(`after search("${word}") on the cache with ${name}`);
    }
    for (const query of QUERIES) {
      assert.equal(
        canon(searcher.search(query, OPTS)),
        f.fresh[query],
        `${name}: unrelated query "${query}" must match a fresh index`
      );
    }
  });
}

function nestedFixture(t) {
  const f = wikiFixture(t);
  fs.writeFileSync(
    path.join(f.wiki, 'nested.md'),
    [
      '---',
      'title: Nested Frontmatter',
      '__proto__:',
      '  polluted: yes',
      'constructor:',
      '  prototype:',
      '    polluted2: 1',
      '---',
      '# Nested',
      'constructor prototype alpha nested body',
      '',
    ].join('\n')
  );
  fs.writeFileSync(path.join(f.wiki, 'plain.md'), '---\ntitle: Plain\n---\n# Plain\nalpha only\n');
  return f;
}
test('nested frontmatter __proto__ and constructor.prototype build, search and cache round-trip without pollution', (t) => {
  const f = nestedFixture(t);
  const pages = loadPages(f.wiki);
  const nested = pages.find((page) => page.path === 'nested.md');
  assert.ok(
    Object.hasOwn(nested.frontmatter, '__proto__'),
    'the YAML parser keeps __proto__ as an own frontmatter key'
  );
  assert.equal(
    Object.getPrototypeOf(nested.frontmatter),
    Object.prototype,
    'the frontmatter prototype must stay Object.prototype'
  );
  let index;
  assert.doesNotThrow(() => {
    index = buildIndex(pages, { now: ASOF });
  }, 'buildIndex must not throw on nested prototype-chain frontmatter');
  assertNoPollution('after buildIndex over nested frontmatter');
  assert.equal({}.polluted2, undefined, '({ }).polluted2 must stay undefined after buildIndex');
  for (const q of ['alpha', 'constructor', 'prototype', 'nested']) {
    assert.doesNotThrow(() => search(index, q, OPTS), `search("${q}") must not throw`);
    assertNoPollution(`after search("${q}") over nested frontmatter`);
    assert.equal({}.polluted2, undefined, `after search("${q}")`);
  }
  const searcher = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  assertNoPollution('after createSearcher over nested frontmatter');
  assert.equal(
    Object.getPrototypeOf(searcher.snapshot().index.postings),
    null,
    'the decoded postings map must stay null-prototype'
  );
  for (const q of ['alpha', 'constructor', 'prototype', 'nested']) {
    assert.doesNotThrow(() => searcher.search(q, OPTS), `cached search("${q}") must not throw`);
    assertNoPollution(`after cached search("${q}")`);
    assert.equal({}.polluted2, undefined, `after cached search("${q}")`);
  }
});
