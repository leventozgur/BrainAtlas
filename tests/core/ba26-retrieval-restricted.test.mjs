// SPDX-License-Identifier: MIT
// BA-26: a page with `sensitivity: personal` or `inject: never` is still returned by search; its result carries the optional
// `inject: 'never'` field, and only that page has the field (legacy parity). The field is stored per document and a cache
// that disagrees with the frontmatter is rejected and rebuilt. Hermetic: temporary vault and state directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, search, createSearcher } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2025-01-01T00:00:00Z');
const page = (name, body, frontmatter = {}) => ({ path: name, title: name.replace(/\.md$/, ''), aliases: [], keywords: [], headings: [], body, frontmatter });

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba26-retrieval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('personal and never-inject pages are still searchable and carry the optional inject field', () => {
  const index = buildIndex([
    page('plain.md', 'zebrafish plain note'),
    page('personal.md', 'zebrafish personal note', { sensitivity: 'personal' }),
    page('never.md', 'zebrafish never note', { inject: 'never' }),
  ], { now });
  const results = search(index, 'zebrafish', { limit: 10, abstainThreshold: 0 }).results;
  const byPath = Object.fromEntries(results.map(r => [r.path, r]));
  assert.equal(byPath['personal.md'].inject, 'never');
  assert.equal(byPath['never.md'].inject, 'never');
  assert.ok(!Object.hasOwn(byPath['plain.md'], 'inject'), 'pages without the restriction keep the previous result shape');
});

test('a restriction is recognised in any letter case and ignores other sensitivity values', () => {
  const index = buildIndex([
    page('upper.md', 'zebrafish upper', { sensitivity: 'Personal' }),
    page('other.md', 'zebrafish other', { sensitivity: 'internal', inject: 'auto' }),
  ], { now });
  const byPath = Object.fromEntries(search(index, 'zebrafish', { limit: 10, abstainThreshold: 0 }).results.map(r => [r.path, r]));
  assert.equal(byPath['upper.md'].inject, 'never');
  assert.ok(!Object.hasOwn(byPath['other.md'], 'inject'));
});

test('the restricted flag survives the on-disk cache and a cache that disagrees with the frontmatter is rebuilt', t => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault); fs.mkdirSync(state);
  fs.writeFileSync(path.join(vault, 'plain.md'), '# Plain\nzebrafish plain');
  fs.writeFileSync(path.join(vault, 'personal.md'), '---\nsensitivity: personal\n---\n# Personal\nzebrafish personal');
  const cache = path.join(state, 'retrieval-index.json');
  createSearcher({ vaultDir: vault, stateDir: state, now }).search('zebrafish');
  const fresh = createSearcher({ vaultDir: vault, stateDir: state, now }).search('zebrafish', { limit: 10, abstainThreshold: 0 }).results;
  assert.equal(fresh.find(r => r.path === 'personal.md').inject, 'never');

  // Forge the cache: drop the restriction from the personal document. The structural check must reject it and rebuild.
  const data = JSON.parse(fs.readFileSync(cache, 'utf8'));
  const personalDoc = data.index.docs.find(doc => doc.page.path === 'personal.md');
  assert.equal(personalDoc.restricted, true, 'the restriction is stored per document');
  delete personalDoc.restricted;
  fs.writeFileSync(cache, JSON.stringify(data));
  const rebuilt = createSearcher({ vaultDir: vault, stateDir: state, now }).search('zebrafish', { limit: 10, abstainThreshold: 0 }).results;
  assert.equal(rebuilt.find(r => r.path === 'personal.md').inject, 'never');

  // Forge the other way: mark a plain page restricted. It must be rejected too.
  const again = JSON.parse(fs.readFileSync(cache, 'utf8'));
  again.index.docs.find(doc => doc.page.path === 'plain.md').restricted = true;
  fs.writeFileSync(cache, JSON.stringify(again));
  const plainAfter = createSearcher({ vaultDir: vault, stateDir: state, now }).search('zebrafish', { limit: 10, abstainThreshold: 0 }).results;
  assert.ok(!Object.hasOwn(plainAfter.find(r => r.path === 'plain.md'), 'inject'));
});
