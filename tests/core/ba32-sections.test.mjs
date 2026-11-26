// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestSection, buildIndex, pageSections, tokens } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-10T00:00:00Z');
const page = (body) => ({
  path: 'topic.md',
  title: 'Topic',
  aliases: [],
  keywords: [],
  headings: [],
  body,
  frontmatter: {},
});

test('pageSections lists the H1–H3 sections in document order with anchors and heading paths', () => {
  const body =
    'Intro paragraph.\n# Topic\ntopic line\n## Alpha\nalpha text\n### Detail\ndetail text\n## Alpha\nsecond alpha\n';
  assert.deepEqual(pageSections(body), [
    { heading: 'Topic', anchor: 'topic', headingPath: 'Topic', text: '# Topic\ntopic line' },
    { heading: 'Alpha', anchor: 'alpha', headingPath: 'Topic > Alpha', text: '## Alpha\nalpha text' },
    { heading: 'Detail', anchor: 'detail', headingPath: 'Topic > Alpha > Detail', text: '### Detail\ndetail text' },
    { heading: 'Alpha', anchor: 'alpha-1', headingPath: 'Topic > Alpha', text: '## Alpha\nsecond alpha' },
  ]);
});

test('pageSections ignores headings inside fenced code blocks and text before the first heading', () => {
  const body = 'before\n```md\n# Fake\n```\n# Real\nreal text\n';
  assert.deepEqual(pageSections(body), [
    { heading: 'Real', anchor: 'real', headingPath: 'Real', text: '# Real\nreal text' },
  ]);
  const fenced = '# Topic\n```\n## Fake\n```\n';
  assert.deepEqual(pageSections(fenced), [
    { heading: 'Topic', anchor: 'topic', headingPath: 'Topic', text: '# Topic\n```\n## Fake\n```' },
  ]);
});

test('pageSections trims each section so every heading belongs to exactly one section', () => {
  const sections = pageSections('# One\n\n\n# Two\n\nbody two\n\n');
  assert.deepEqual(
    sections.map((section) => section.text),
    ['# One', '# Two\n\nbody two']
  );
});

test('bestSection keeps its signature and returns the text pageSections gives for the chosen anchor', () => {
  const body = '# Topic\nalpha topic\n## Detail\nalpha detail more\n';
  const index = buildIndex([page(body)], { now });
  const chosen = bestSection(body, [...new Set(tokens('alpha detail', true))], index, now);
  assert.equal(chosen.anchor, 'detail');
  assert.equal(chosen.heading, 'Detail');
  assert.equal(chosen.text, pageSections(body).find((section) => section.anchor === chosen.anchor).text);
});
