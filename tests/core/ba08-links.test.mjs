// SPDX-License-Identifier: MIT
// BA-08 link graph: extraction forms, resolution, graph expansion, optional result fields, and cache validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, createSearcher, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2025-01-01T00:00:00.000Z');
const page = (file, body = '', extra = {}) => ({
  path: file, title: extra.title ?? file.replace(/\.md$/u, ''), aliases: extra.aliases ?? [], keywords: [], headings: [], body,
  frontmatter: extra.frontmatter ?? {},
});
const neighbours = (index, file) => {
  const id = index.docs.findIndex(d => d.page.path === file);
  return (index.links[id] || []).map(n => index.docs[n].page.path);
};
const relatedOf = (result, file) => result.results.find(r => r.path === file)?.related;
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba08-links-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('wikilink forms: plain, label, section anchor and path-style names all link', () => {
  const index = buildIndex([
    page('a.md', 'See [[b]] and [[c|the label]] and [[d#part]] and [[sub/e]].'),
    page('b.md', ''), page('c.md', ''), page('d.md', ''), page('sub/e.md', ''),
  ], { now });
  assert.deepEqual(neighbours(index, 'a.md').sort(), ['b.md', 'c.md', 'd.md', 'sub/e.md']);
});

test('embeds and external wikilinks are not edges', () => {
  const index = buildIndex([page('a.md', 'An image ![[b]] stays out.'), page('b.md', '')], { now });
  assert.deepEqual(index.links, {});
});

test('markdown links resolve relative to the page directory, drop anchors and queries', () => {
  const index = buildIndex([
    page('ops/a.md', 'Read [the sensor](sensor.md#readings) and [up](../top.md?x=1).'),
    page('ops/sensor.md', ''), page('top.md', ''),
  ], { now });
  assert.deepEqual(neighbours(index, 'ops/a.md').sort(), ['ops/sensor.md', 'top.md']);
});

test('external URLs, non-Markdown files, absolute and escaping paths are not edges', () => {
  const index = buildIndex([
    page('a.md', '[w](https://example.com/b.md) [m](mailto:x@y.md) [i](pic.png) [r](/abs.md) [e](../../out.md) [anchor](#top) ![img](b.md)'),
    page('b.md', ''), page('abs.md', ''), page('pic.png.md', ''),
  ], { now });
  assert.deepEqual(index.links, {});
});

test('fenced and inline code are ignored', () => {
  const index = buildIndex([
    page('a.md', 'Inline `[[b]]` is code.\n\n```\n[[c]]\n```\n\n~~~\n[d](d.md)\n~~~\n'),
    page('b.md', ''), page('c.md', ''), page('d.md', ''),
  ], { now });
  assert.deepEqual(index.links, {});
});

test('self links, duplicate links and cycles add no self or duplicate edges, symmetric', () => {
  const index = buildIndex([
    page('a.md', 'Self [[a]] and twice [[b]] [[b]] [x](b.md).'),
    page('b.md', 'Back to [[a]].'),
  ], { now });
  assert.deepEqual(neighbours(index, 'a.md'), ['b.md']);
  assert.deepEqual(neighbours(index, 'b.md'), ['a.md']);
});

test('links to superseded or missing targets are skipped', () => {
  const index = buildIndex([
    page('a.md', 'Old [[old]] and gone [[nowhere]] and [file](missing.md).'),
    page('old.md', '', { frontmatter: { status: 'superseded', superseded_by: 'a.md' } }),
  ], { now });
  assert.deepEqual(index.links, {});
});

test('names resolve by alias, title and case or diacritics, and ambiguous names link nothing', () => {
  const index = buildIndex([
    page('a.md', 'Use the [[firing profile]], the [[Çağrı Merkezi]] and the [[shared]].'),
    page('clay.md', '', { aliases: ['firing profile'] }),
    page('cagri.md', '', { title: 'Cagri Merkezi' }),
    page('x/shared.md', ''), page('y/shared.md', ''),
  ], { now });
  assert.deepEqual(neighbours(index, 'a.md').sort(), ['cagri.md', 'clay.md']);
});

test('expansion adds a direct neighbour with via link and a related field; the abstain decision stays lexical', () => {
  const index = buildIndex([
    page('seed.md', 'kestrel courier handoff rules [[timing]]'),
    page('timing.md', 'forty minutes countersign'),
  ], { now });
  const result = search(index, 'kestrel courier handoff', { abstainThreshold: 0 });
  assert.equal(result.abstained, false);
  const linked = result.results.find(r => r.path === 'timing.md');
  assert.ok(linked, 'neighbour is added');
  assert.equal(linked.via, 'link');
  assert.deepEqual(result.results.find(r => r.path === 'seed.md').related, ['timing.md']);
  assert.equal(result.results.find(r => r.path === 'seed.md').via, undefined);
  // A query that matches only the neighbour's text must not be answered through the graph.
  const unanswered = search(index, 'forty countersign zebra', { abstainThreshold: 0.99 });
  assert.equal(unanswered.abstained, true);
  const noLexical = search(index, 'zebra quasar', { abstainThreshold: 0 });
  assert.equal(noLexical.abstained, true);
  assert.deepEqual(noLexical.results, []);
});

test('a single-page query keeps its first result and score exactly as without links', () => {
  const bodies = [['alpha.md', 'unique zircon polishing grit [[beta]]'], ['beta.md', 'felt wheel finish']];
  const linked = buildIndex(bodies.map(([f, b]) => page(f, b)), { now });
  // Same tokens and lengths, but no link syntax: scores can then be compared exactly.
  const plain = buildIndex(bodies.map(([f, b]) => page(f, b.replace(/\[\[beta\]\]/u, 'beta'))), { now });
  for (const threshold of [0, 0.35]) {
    const a = search(linked, 'zircon polishing grit', { abstainThreshold: threshold }).results;
    const b = search(plain, 'zircon polishing grit', { abstainThreshold: threshold }).results;
    assert.equal(a[0].path, b[0].path);
    assert.equal(a[0].score, b[0].score);
  }
});

test('without any link the result shape and scores are the previous ones', () => {
  const pages = [page('a.md', 'shared evidence alpha'), page('b.md', 'shared evidence beta')];
  const result = search(buildIndex(pages, { now }), 'shared evidence');
  for (const r of result.results) {
    assert.equal(r.related, undefined);
    assert.equal(r.via, undefined);
  }
});

test('related lists at most five direct neighbours, sorted, in both directions', () => {
  const hub = page('hub.md', 'hub text [[n1]] [[n2]] [[n3]] [[n4]] [[n5]] [[n6]]');
  const spokes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map(n => page(`${n}.md`, `spoke ${n}`));
  const index = buildIndex([hub, ...spokes], { now });
  const result = search(index, 'hub text');
  assert.deepEqual(relatedOf(result, 'hub.md'), ['n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md']);
  assert.deepEqual(neighbours(index, 'n6.md'), ['hub.md']);
});

test('cache: a cache without links is rejected and rebuilt, and a cache with asymmetric links is rejected', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state'), cache = path.join(state, 'retrieval-index.json');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'seed.md'), 'kestrel courier handoff [[timing]]\n');
  fs.writeFileSync(path.join(vault, 'timing.md'), 'forty minutes countersign\n');
  const first = createSearcher({ vaultDir: vault, stateDir: state, now });
  const warm = search(first.snapshot().index, 'kestrel courier handoff');
  assert.ok(warm.results.some(r => r.path === 'timing.md' && r.via === 'link'));

  const data = JSON.parse(fs.readFileSync(cache, 'utf8'));
  delete data.index.links;
  fs.writeFileSync(cache, JSON.stringify(data));
  const rebuilt = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.ok(search(rebuilt.snapshot().index, 'kestrel courier handoff').results.some(r => r.path === 'timing.md'));
  assert.ok(JSON.parse(fs.readFileSync(cache, 'utf8')).index.links, 'rebuilt cache carries links');

  const tampered = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const id = Object.keys(tampered.index.links)[0];
  tampered.index.links[id] = [];
  fs.writeFileSync(cache, JSON.stringify(tampered));
  const again = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.ok(search(again.snapshot().index, 'kestrel courier handoff').results.some(r => r.path === 'timing.md'));
});
