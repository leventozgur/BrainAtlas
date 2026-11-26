// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, pageSections, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-20T00:00:00Z');
const record = { date: '2026-01-12', evidence: 'review', scope: 'backup', source: 'wiki/sources/a.md' };
const OPEN = '<!-- brainatlas:current-state -->';
const CLOSE = '<!-- /brainatlas:current-state -->';
const verified = { status: 'confirmed', verified: [record] };
const page = (file, frontmatter, body, title = 'Backup policy') => ({
  path: file,
  title,
  aliases: [],
  keywords: [],
  headings: [],
  body,
  frontmatter,
});
const block = (sentence) => `## Current state (proposed 2026-11-18)\n${OPEN}\n- ${sentence}\n${CLOSE}\n`;
const bodyWith = (sentence) =>
  `# Backup policy\n\n## 2026-01-05 rotation\n\nThe rotation schedule runs nightly at 03:00.\n\n${block(sentence)}`;
const withoutMarkers = (body) =>
  body
    .split('\n')
    .filter((line) => line !== OPEN && line !== CLOSE)
    .join('\n');
const QUERY = 'zephyrite quorum';

function answer(pages, query = QUERY, options = {}) {
  return search(buildIndex(pages, { now }), query, { limit: 10, ...options });
}

test('BA-57: an accepted block on a confirmed, verified page is synthesized and carries no trust', () => {
  const result = answer([
    page('backup.md', verified, bodyWith('The zephyrite quorum disk is replicated.')),
    page('other.md', {}, 'garden notes'),
  ]).results.find((row) => row.path === 'backup.md');
  assert.ok(result, 'the page should be returned');
  assert.equal(result.heading, 'Current state (proposed 2026-11-18)');
  assert.equal(result.synthesized, true);
  assert.equal(Object.hasOwn(result, 'trust'), false, 'a synthesized section is not verified evidence');
  assert.match(result.snippet, /zephyrite quorum disk/u);
});

test('BA-57: the same page without the marker line keeps its verified trust and gains no synthesized key', () => {
  const result = answer([
    page('backup.md', verified, withoutMarkers(bodyWith('The zephyrite quorum disk is replicated.'))),
    page('other.md', {}, 'garden notes'),
  ]).results.find((row) => row.path === 'backup.md');
  assert.ok(result, 'the page should be returned');
  assert.equal(result.heading, 'Current state (proposed 2026-11-18)');
  assert.equal(result.trust, 'verified');
  assert.equal(Object.hasOwn(result, 'synthesized'), false);
});

test('BA-57: a proposed page with an accepted block is both weak and synthesized', () => {
  const result = answer([
    page('backup.md', { status: 'proposed' }, bodyWith('The zephyrite quorum disk is replicated.')),
    page('other.md', {}, 'garden notes'),
  ]).results.find((row) => row.path === 'backup.md');
  assert.ok(result, 'the page should be returned');
  assert.equal(result.trust, 'weak');
  assert.equal(result.synthesized, true);
});

test('BA-57: a marker inside a fenced code block does not make a section synthesized', () => {
  const body = `# Backup policy\n\n## 2026-02-02 fenced example\n\n\`\`\`md\n${OPEN}\n\`\`\`\n\nA zephyrite quorum example.\n`;
  const result = answer([page('backup.md', verified, body), page('other.md', {}, 'garden notes')]).results.find(
    (row) => row.path === 'backup.md'
  );
  assert.ok(result, 'the page should be returned');
  assert.equal(result.heading, '2026-02-02 fenced example');
  assert.equal(Object.hasOwn(result, 'synthesized'), false);
  assert.equal(result.trust, 'verified');
});

test('BA-57: a page without a block deep-equals the previous result shape', () => {
  const plain = answer([page('backup.md', verified, 'The zephyrite quorum disk is replicated.')]).results[0];
  assert.ok(plain, 'the page should be returned');
  assert.deepEqual(plain, {
    path: 'backup.md',
    title: 'Backup policy',
    score: 0.9486832980505138,
    snippet: 'The zephyrite quorum disk is replicated.',
    stale: false,
    status: 'confirmed',
    heading: null,
    anchor: null,
    headingPath: null,
    trust: 'verified',
  });
  assert.equal(Object.hasOwn(plain, 'synthesized'), false);
});

test('BA-57: a proposed page without a block stays weak and gains no synthesized key', () => {
  const plain = answer([page('backup.md', { status: 'proposed' }, 'The zephyrite quorum disk is replicated.')])
    .results[0];
  assert.ok(plain, 'the page should be returned');
  assert.deepEqual(plain, {
    path: 'backup.md',
    title: 'Backup policy',
    score: 0.5692099788303083,
    snippet: 'The zephyrite quorum disk is replicated.',
    stale: false,
    status: 'proposed',
    heading: null,
    anchor: null,
    headingPath: null,
    trust: 'weak',
  });
  assert.equal(Object.hasOwn(plain, 'synthesized'), false);
});

test('BA-57: a synthesized result gains the key and keeps every other field in place', () => {
  const result = answer([page('backup.md', verified, bodyWith('The zephyrite quorum disk is replicated.'))]).results[0];
  assert.ok(result, 'the page should be returned');
  assert.deepEqual(Object.keys(result), [
    'path',
    'title',
    'score',
    'snippet',
    'stale',
    'status',
    'heading',
    'anchor',
    'headingPath',
    'synthesized',
  ]);
});

test('BA-57: ranking is unchanged; only the marker line is different', () => {
  const text = 'unrelated garden notes about tomatoes and basil.';
  const marked = [
    page('a.md', verified, `${text}\n${block('quorum sentence')}`, 'Zephyr handbook'),
    page('b.md', {}, text, 'Zephyr notes'),
  ];
  const plain = [
    page('a.md', verified, `${text}\n\n## Current state (proposed 2026-11-18)\n- quorum sentence\n`, 'Zephyr handbook'),
    page('b.md', {}, text, 'Zephyr notes'),
  ];
  const pairs = (pages) => answer(pages, 'zephyr').results.map((row) => [row.path, row.score]);
  assert.deepEqual(pairs(marked), pairs(plain));
});

test('BA-57: pageSections flags only the marked section', () => {
  const sections = pageSections(bodyWith('The zephyrite quorum disk is replicated.'));
  assert.deepEqual(
    sections.map((section) => section.synthesized === true),
    [false, false, true]
  );
  assert.deepEqual(Object.keys(sections[0]), ['heading', 'anchor', 'headingPath', 'text']);
  assert.deepEqual(Object.keys(sections[2]), ['heading', 'anchor', 'headingPath', 'text', 'synthesized']);
});
