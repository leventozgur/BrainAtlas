// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const corpusDir = resolve(root, 'eval/corpus-natural');
const casesPath = resolve(root, 'eval/dev/xling-cases.json');
const files = readdirSync(corpusDir).filter(name => name.endsWith('.md')).sort();
const pages = new Map(files.map(name => [name, readFileSync(resolve(corpusDir, name), 'utf8')]));
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const expectedCounts = new Map([['xling-tr2en', 5], ['xling-en2tr', 10], ['no-answer', 10]]);

function pageLanguage(markdown) {
  const text = markdown.replace(/^---[\s\S]*?---/u, '').toLocaleLowerCase('tr-TR');
  const turkishMarkers = (text.match(/[çğıöşüİı]/giu) || []).length;
  const englishMarkers = (text.match(/\b(?:the|and|with|when|should|while|from|into|which|this|that)\b/giu) || []).length;
  if (turkishMarkers >= 8 && englishMarkers < 5) return 'tr';
  if (englishMarkers >= 5 && turkishMarkers < 8) return 'en';
  return 'mixed';
}

function words(text) {
  return text.toLocaleLowerCase('tr-TR').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').match(/[\p{L}\p{N}_]+/gu) || [];
}

function containsPrivatePattern(text) {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text)
    || /(?:^|[\s"'`])\/(?:Users|home)\/[^\s"'`]+/mu.test(text)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/u.test(text);
}

test('cross-language and abstain cases have valid shape, unique IDs, and balanced categories', () => {
  assert.equal(cases.length, 30);
  const ids = new Set();
  const counts = new Map();
  const allowedKeys = new Set(['id', 'query', 'relevant', 'category', 'trToEn', 'abstain', 'excluded']);
  for (const item of cases) {
    assert.ok(item && typeof item === 'object' && !Array.isArray(item));
    assert.ok(Object.keys(item).every(key => allowedKeys.has(key)), `${item.id} uses only the case schema`);
    assert.equal(typeof item.id, 'string');
    assert.equal(ids.has(item.id), false, `duplicate case id: ${item.id}`);
    ids.add(item.id);
    assert.equal(typeof item.query, 'string');
    assert.ok(item.query.trim().length > 0, `${item.id} query`);
    assert.ok(expectedCounts.has(item.category), `${item.id} category`);
    counts.set(item.category, (counts.get(item.category) || 0) + 1);
    assert.ok(Array.isArray(item.relevant), `${item.id} relevant list`);
    for (const file of [...item.relevant, ...(item.excluded || [])]) {
      assert.equal(basename(file), file, `${item.id} uses corpus filename only`);
      assert.ok(pages.has(file), `${item.id} references existing page ${file}`);
    }
    assert.equal(containsPrivatePattern(item.query), false, `${item.id} query has no private pattern`);
    if (item.category === 'xling-tr2en') {
      assert.equal(item.trToEn, true, `${item.id} marks Turkish-to-English direction`);
      assert.ok(item.relevant.length > 0, `${item.id} has positive evidence`);
      for (const file of item.relevant) assert.equal(pageLanguage(pages.get(file)), 'en', `${item.id}: ${file} is English`);
    } else if (item.category === 'xling-en2tr') {
      assert.equal(item.trToEn, undefined, `${item.id} is not marked Turkish-to-English`);
      assert.ok(item.relevant.length > 0, `${item.id} has positive evidence`);
      for (const file of item.relevant) assert.equal(pageLanguage(pages.get(file)), 'tr', `${item.id}: ${file} is Turkish`);
    } else {
      assert.deepEqual(item.relevant, [], `${item.id} has no relevant page`);
      assert.equal(item.abstain, true, `${item.id} abstains`);
      assert.match(item.id, /^no-answer-(?:tr|en)-/u, `${item.id} identifies query language`);
    }
  }
  for (const [category, target] of expectedCounts) assert.equal(counts.get(category), target, `${category} count`);
  assert.equal(cases.filter(item => item.category === 'no-answer' && item.id.startsWith('no-answer-tr-')).length, 5);
  assert.equal(cases.filter(item => item.category === 'no-answer' && item.id.startsWith('no-answer-en-')).length, 5);
});

test('queries do not copy four consecutive words from a corpus page', () => {
  const pageTokens = [...pages.values()].map(words);
  for (const item of cases) {
    const queryTokens = words(item.query);
    for (let start = 0; start + 4 <= queryTokens.length; start++) {
      const phrase = queryTokens.slice(start, start + 4).join(' ');
      for (const tokens of pageTokens) {
        let found = false;
        for (let i = 0; i + 4 <= tokens.length; i++) {
          if (tokens.slice(i, i + 4).join(' ') === phrase) { found = true; break; }
        }
        assert.equal(found, false, `${item.id} copies a four-word phrase`);
      }
    }
  }
});

test('all referenced corpus pages have readable language metadata', () => {
  for (const item of cases.filter(entry => entry.relevant.length)) {
    for (const file of item.relevant) {
      const frontmatter = pages.get(file).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
      assert.ok(frontmatter, `${file} frontmatter`);
      assert.ok(parse(frontmatter[1]) && typeof parse(frontmatter[1]).title === 'string', `${file} title`);
      assert.ok(['tr', 'en'].includes(pageLanguage(pages.get(file))), `${file} is unambiguously Turkish or English`);
    }
  }
});
