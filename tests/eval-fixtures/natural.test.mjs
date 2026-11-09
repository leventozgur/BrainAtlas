// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const corpusDir = resolve(root, 'eval/corpus-natural');
const casesPath = resolve(root, 'eval/dev/natural-cases.json');
const files = readdirSync(corpusDir).filter(name => name.endsWith('.md')).sort();
const pages = new Map(files.map(name => [name, readFileSync(resolve(corpusDir, name), 'utf8')]));
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const categoryTargets = new Map([
  ['tr', 20], ['en', 20], ['mixed', 12], ['synonym', 10],
  ['technical-exact', 12], ['typo', 8], ['near-miss', 8],
  ['stale-superseded', 5], ['no-answer', 5],
]);

function frontmatter(markdown, name) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `${name} has YAML frontmatter`);
  const value = parse(match[1]);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${name} frontmatter is a mapping`);
  return value;
}

function words(text) {
  return (text.toLocaleLowerCase('tr-TR').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}_]+/gu) || []);
}

function containsPrivatePattern(text) {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /(?:^|[\s"'`])\/(?:Users|home)\/[^\s"'`]+/m.test(text)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text);
}

test('natural corpus has valid, substantial synthetic Markdown pages', () => {
  assert.equal(files.length, 60);
  const parsed = new Map();
  let staleCount = 0;
  let supersededCount = 0;
  for (const [name, markdown] of pages) {
    const metadata = frontmatter(markdown, name);
    parsed.set(name, metadata);
    assert.equal(typeof metadata.title, 'string', `${name} title`);
    assert.ok(['active', 'superseded', 'disputed', 'confirmed'].includes(metadata.status), `${name} status`);
    assert.ok(metadata.generated, `${name} generated date`);
    assert.ok(metadata.stale_after, `${name} stale_after date`);
    assert.ok((markdown.match(/^## /gm) || []).length >= 2, `${name} has multiple sections`);
    assert.match(markdown, /```[\s\S]*?```/, `${name} has a code example`);
    assert.ok(words(markdown).length >= 150 && words(markdown).length <= 500, `${name} word count`);
    assert.equal(containsPrivatePattern(markdown), false, `${name} has no email, absolute user path, or IPv4 address`);
    if (metadata.status === 'superseded') {
      supersededCount++;
      assert.ok(typeof metadata.superseded_by === 'string', `${name} points to a replacement`);
      assert.ok(pages.has(metadata.superseded_by), `${name} replacement exists`);
    }
    if (Date.parse(metadata.stale_after) < Date.now()) staleCount++;
  }
  assert.ok(supersededCount >= 5, 'includes superseded evidence');
  assert.ok(staleCount >= 10, 'includes expired freshness dates');
});

test('development cases have unique IDs, valid paths, and expected category balance', () => {
  assert.equal(cases.length, 100);
  const ids = new Set();
  const counts = new Map();
  for (const item of cases) {
    assert.equal(typeof item.id, 'string');
    assert.equal(ids.has(item.id), false, `duplicate case id: ${item.id}`);
    ids.add(item.id);
    assert.equal(typeof item.query, 'string');
    assert.ok(item.query.trim().length > 0, `${item.id} query`);
    assert.ok(categoryTargets.has(item.category), `${item.id} category`);
    counts.set(item.category, (counts.get(item.category) || 0) + 1);
    assert.ok(Array.isArray(item.relevant), `${item.id} relevant list`);
    for (const file of [...item.relevant, ...(item.excluded || [])]) {
      assert.equal(basename(file), file, `${item.id} uses corpus filename only`);
      assert.ok(pages.has(file), `${item.id} references existing page ${file}`);
    }
    if (item.category === 'no-answer') assert.equal(item.abstain, true, `${item.id} abstains`);
    else assert.ok(item.relevant.length > 0, `${item.id} has positive evidence`);
    assert.equal(containsPrivatePattern(item.query), false, `${item.id} query has no private pattern`);
  }
  for (const [category, target] of categoryTargets) {
    assert.ok(Math.abs((counts.get(category) || 0) - target) <= 2, `${category} count`);
  }
});

test('case queries do not copy six consecutive words from any corpus page', () => {
  const pageTokens = [...pages.values()].map(words);
  for (const item of cases) {
    const queryTokens = words(item.query);
    for (let start = 0; start + 6 <= queryTokens.length; start++) {
      const phrase = queryTokens.slice(start, start + 6).join(' ');
      for (const tokens of pageTokens) {
        let found = false;
        for (let i = 0; i + 6 <= tokens.length; i++) {
          if (tokens.slice(i, i + 6).join(' ') === phrase) { found = true; break; }
        }
        assert.equal(found, false, `${item.id} copies a six-word phrase`);
      }
    }
  }
});
