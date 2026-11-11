// SPDX-License-Identifier: MIT
// BA-08 blind acceptance: link graph extraction and name resolution, checked against docs/contracts/retrieval.md
// ("Page links and graph expansion"). Vaults are real temporary files read by loadPages, as in production.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorktreeRetrieval } from './helpers/main-core.mjs';
import { isolateHome, makeVault, neighbourPaths } from './helpers/vault.mjs';

const now = new Date('2026-11-10T00:00:00Z');
let rt, restoreHome;
before(async () => { restoreHome = isolateHome('ba08-links'); rt = await loadWorktreeRetrieval(); });
after(() => restoreHome());

const build = (vault) => rt.buildIndex(rt.loadPages(vault), { now });
const body = (text) => `${text}\n`;

test('wikilink forms plain, label, section and path-style all create edges in both directions', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('See [[b]], [[c|the label]], [[d#part]] and [[sub/e]].'),
    'b.md': body('b'), 'c.md': body('c'), 'd.md': body('d'), 'sub/e.md': body('e'),
  });
  const index = build(vault);
  assert.deepEqual(neighbourPaths(index, 'a.md'), ['b.md', 'c.md', 'd.md', 'sub/e.md']);
  assert.deepEqual(neighbourPaths(index, 'sub/e.md'), ['a.md']);
});

test('names resolve through alias, title, file name and path, folding case and Turkish diacritics', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('Use [[firing profile]], [[Çağrı Merkezi]], [[ışık]], [[e]] and [[SUB/E]].'),
    'clay.md': '---\naliases:\n  - firing profile\n---\nclay\n',
    'cagri.md': '---\ntitle: Cagri Merkezi\n---\ncagri\n',
    'isik.md': '---\ntitle: Işık\n---\nisik\n',
    'sub/e.md': body('e'),
  });
  const index = build(vault);
  assert.deepEqual(neighbourPaths(index, 'a.md'), ['cagri.md', 'clay.md', 'isik.md', 'sub/e.md']);
});

test('an ambiguous name or an unknown name links nothing', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('Ambiguous [[shared]] and unknown [[nowhere]].'),
    'x/shared.md': body('x'), 'y/shared.md': body('y'),
  });
  const index = build(vault);
  assert.deepEqual(neighbourPaths(index, 'a.md'), []);
  assert.deepEqual(index.links, {});
});

test('relative Markdown links resolve from the page directory and drop anchors, queries and percent-encoding is decoded', (t) => {
  const { vault } = makeVault(t, {
    'ops/a.md': body('Read [the sensor](sensor.md#readings), [up](../top.md?x=1), [dot](./sensor.md) and [enc](sensor%20file.md).'),
    'ops/sensor.md': body('sensor'), 'ops/sensor file.md': body('spaced'), 'top.md': body('top'),
  });
  const index = build(vault);
  assert.deepEqual(neighbourPaths(index, 'ops/a.md'), ['ops/sensor file.md', 'ops/sensor.md', 'top.md']);
});

test('paths leaving the vault, absolute paths, external URLs, scheme links, anchors and non-Markdown targets are not edges', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('[w](https://example.com/b.md) [m](mailto:x@y.md) [pic](pic.png) [abs](/abs.md) [out](../../out.md) [up](../b.md) [top](#top) [back](\\b.md)'),
    'b.md': body('b'), 'abs.md': body('abs'), 'pic.png.md': body('pic'),
  });
  const index = build(vault);
  assert.deepEqual(index.links, {});
});

test('embeds, wikilink and Markdown image embeds are not edges', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('An image ![[b]] and ![pic](b.md) stay out.'),
    'b.md': body('b'),
  });
  assert.deepEqual(build(vault).links, {});
});

test('inline code, backtick and tilde fences are ignored, and links after a closed fence still count', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('Inline `[[b]]` is code.\n\n```\n[[c]]\n[d](d.md)\n```\n\n~~~\n[[e]]\n~~~\n\n````\n```\n[[g]]\n````\n\nAfter [[f]].'),
    'b.md': body('b'), 'c.md': body('c'), 'd.md': body('d'), 'e.md': body('e'), 'f.md': body('f'), 'g.md': body('g'),
  });
  const index = build(vault);
  assert.deepEqual(neighbourPaths(index, 'a.md'), ['f.md']);
});

test('self links, section links to the page itself, duplicates and cycles add no self or duplicate edges', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('Self [[a]], own section [[a#intro]], twice [[b]] and [[b]], and [x](b.md).'),
    'b.md': body('Back to [[a]].'),
  });
  const index = build(vault);
  assert.deepEqual(neighbourPaths(index, 'a.md'), ['b.md']);
  assert.deepEqual(neighbourPaths(index, 'b.md'), ['a.md']);
  for (const [key, list] of Object.entries(index.links)) {
    assert.equal(new Set(list).size, list.length, `duplicates in ${key}`);
    assert.ok(!list.includes(Number(key)), `self edge in ${key}`);
    assert.deepEqual([...list].sort((x, y) => x - y), list, `unsorted ${key}`);
    for (const n of list) assert.ok(index.links[n].includes(Number(key)), `asymmetric ${key}-${n}`);
  }
});

test('superseded pages are not indexed, so links to them and from them create no edge', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('Current [[old]] and [old note](old.md).'),
    'old.md': '---\nstatus: superseded\nsuperseded_by: a.md\n---\nOld text that links [[a]].\n',
    'new-only.md': '---\nsuperseded_by: a.md\n---\nAnother old text [[a]].\n',
  });
  const index = build(vault);
  assert.deepEqual(index.docs.map(d => d.page.path), ['a.md']);
  assert.deepEqual(index.links, {});
});

test('a link to a missing file or a missing name adds no edge', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('Gone [[nowhere]] and [gone](missing.md).'),
  });
  assert.deepEqual(build(vault).links, {});
});

test('the graph is a plain object of string document ids, and a page without links has no entry', (t) => {
  const { vault } = makeVault(t, {
    'a.md': body('[[b]]'), 'b.md': body('plain'), 'c.md': body('plain, no links'),
  });
  const index = build(vault);
  assert.equal(Object.getPrototypeOf(index.links), Object.prototype);
  assert.deepEqual(Object.keys(index.links).sort(), ['0', '1']);
  assert.equal(index.links[2], undefined);
});
