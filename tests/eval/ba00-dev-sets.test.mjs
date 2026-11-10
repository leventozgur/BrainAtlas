// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const corpusDir = path.join(root, 'eval/corpus-ba');
const devDir = path.join(root, 'eval/dev');
const CATEGORIES = new Set(['identifier', 'current-state', 'multihop', 'near-negative']);
const SETS = {
  'identifier-cases.json': 'identifier',
  'current-state-cases.json': 'current-state',
  'multihop-cases.json': 'multihop',
  'near-negative-cases.json': 'near-negative',
};

function walkMarkdown(dir, base = dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdown(full, base);
    return entry.name.endsWith('.md') ? [path.relative(base, full).split(path.sep).join('/')] : [];
  }).sort();
}

function parsePage(relPath) {
  const raw = fs.readFileSync(path.join(corpusDir, relPath), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  assert.ok(match, `frontmatter in ${relPath}`);
  const fields = Object.fromEntries(match[1].split('\n').map((line) => {
    const index = line.indexOf(':');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  return {fields, body: match[2], words: match[2].trim().split(/\s+/u).filter(Boolean).length};
}

const pages = walkMarkdown(corpusDir);
const parsed = Object.fromEntries(pages.map((relPath) => [relPath, parsePage(relPath)]));
const loadSet = (file) => JSON.parse(fs.readFileSync(path.join(devDir, file), 'utf8'));
const sets = Object.fromEntries(Object.keys(SETS).map((file) => [file, loadSet(file)]));

test('corpus-ba has 40 to 60 pages, each 150 to 600 words, with valid frontmatter', () => {
  assert.ok(pages.length >= 40 && pages.length <= 60, `page count ${pages.length}`);
  for (const relPath of pages) {
    const {fields, words} = parsed[relPath];
    assert.ok(words >= 150 && words <= 600, `${relPath} has ${words} words`);
    assert.ok(fields.title, `${relPath} title`);
    assert.match(fields.generated, /^"\d{4}-\d{2}-\d{2}"$/u, `${relPath} generated is quoted date-only`);
    assert.ok(['active', 'superseded'].includes(fields.status.replace(/"/gu, '')), `${relPath} status`);
    assert.doesNotMatch(parsed[relPath].body, /\/Users\/|\/home\/|https?:\/\/|@\w+\.\w+/u, `${relPath} has no real-looking identifiers`);
  }
});

test('superseded pages point to an existing replacement page', () => {
  const superseded = pages.filter((relPath) => parsed[relPath].fields.status === 'superseded');
  assert.ok(superseded.length >= 3);
  for (const relPath of superseded) {
    const target = parsed[relPath].fields.superseded_by;
    assert.ok(target && parsed[target], `${relPath} superseded_by`);
    assert.notEqual(parsed[target].fields.status, 'superseded');
  }
});

test('every case file uses unique ids, valid categories, existing relevant paths and consistent abstain flags', () => {
  const seen = new Set();
  for (const [file, category] of Object.entries(SETS)) {
    const cases = sets[file];
    assert.ok(Array.isArray(cases), file);
    for (const item of cases) {
      assert.match(item.id, /^[\w-]{1,64}$/u);
      assert.equal(seen.has(item.id), false, `duplicate id ${item.id}`);
      seen.add(item.id);
      assert.ok(CATEGORIES.has(item.category) && item.category === category, `${item.id} category`);
      assert.ok(typeof item.query === 'string' && item.query.trim().length > 0, `${item.id} query`);
      assert.ok(Array.isArray(item.relevant), `${item.id} relevant`);
      for (const relPath of item.relevant) assert.ok(parsed[relPath], `${item.id} relevant ${relPath} exists`);
      if (item.abstain === true || item.relevant.length === 0) {
        assert.equal(item.abstain === true && item.relevant.length === 0, true, `${item.id} abstain consistency`);
      } else {
        assert.equal(item.abstain, false, `${item.id} abstain flag`);
      }
      if (item.expectedHeading !== undefined) {
        assert.ok(item.relevant.length > 0 && !item.abstain, `${item.id} heading only on answerable cases`);
        const heading = item.expectedHeading;
        const pattern = new RegExp(`^#{1,3}[\\t ]+${heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu');
        assert.match(parsed[item.relevant[0]].body, pattern, `${item.id} heading present in relevant page`);
      }
      if (item.requireAll !== undefined) assert.equal(typeof item.requireAll, 'boolean');
    }
  }
});

test('identifier set has at least 20 cases, half of them abstaining', () => {
  const cases = sets['identifier-cases.json'];
  assert.ok(cases.length >= 20);
  assert.equal(cases.filter((item) => item.abstain === true).length, cases.length / 2);
});

test('current-state set has at least 12 cases and at least 3 superseded redirects', () => {
  const cases = sets['current-state-cases.json'];
  assert.ok(cases.length >= 12);
  const replacements = new Set(pages.filter((relPath) => parsed[relPath].fields.status === 'superseded').map((relPath) => parsed[relPath].fields.superseded_by));
  const redirects = cases.filter((item) => replacements.has(item.relevant[0]) && item.relevant.length === 1);
  assert.ok(redirects.length >= 3, `redirects ${redirects.length}`);
  for (const item of redirects) {
    const original = pages.find((relPath) => parsed[relPath].fields.superseded_by === item.relevant[0]);
    assert.ok(original, `${item.id} redirect has a superseded source`);
    assert.equal(item.relevant.includes(original), false);
  }
});

test('multihop set has at least 12 requireAll cases whose pages link to each other', () => {
  const cases = sets['multihop-cases.json'];
  assert.ok(cases.length >= 12);
  for (const item of cases) {
    assert.equal(item.requireAll, true, `${item.id} requireAll`);
    assert.ok(item.relevant.length >= 2, `${item.id} needs at least two pages`);
    for (const relPath of item.relevant) {
      const linked = item.relevant.some((other) => other !== relPath && (parsed[relPath].body.includes(`[[${other.replace(/\.md$/u, '')}]]`) || parsed[relPath].body.includes(`(${other})`)));
      assert.ok(linked, `${item.id}: ${relPath} links to another relevant page`);
    }
  }
});

test('near-negative set has at least 10 cases and every case abstains', () => {
  const cases = sets['near-negative-cases.json'];
  assert.ok(cases.length >= 10);
  for (const item of cases) {
    assert.equal(item.abstain, true, `${item.id} abstain`);
    assert.deepEqual(item.relevant, []);
  }
});

test('language mix is roughly even across the new sets', () => {
  const queries = Object.values(sets).flat().map((item) => item.query);
  const turkish = queries.filter((q) => /[çğıöşüÇĞİÖŞÜ]|\b(ne|nasıl|nedir|hangi|bir|ile|mi|mı|kim|nerede|kaç|neden)\b/u.test(q)).length;
  const ratio = turkish / queries.length;
  assert.ok(ratio > 0.25 && ratio < 0.75, `turkish ratio ${ratio.toFixed(2)}`);
});
