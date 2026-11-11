// SPDX-License-Identifier: MIT
// BA-17: the snippet budget cut must never split a UTF-16 surrogate pair. Hermetic: in-memory index, no files, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');
// A lone surrogate: a high (D800-DBFF) not followed by a low, or a low not preceded by a high.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const EMOJI = '\u{1F600}';
const ASTRAL = '\u{1D11E}\u{20000}';
const BODY = `Zebra ${EMOJI.repeat(120)} ${ASTRAL.repeat(40)} tail words`;
const index = buildIndex([{ path: 'emoji.md', title: 'Emoji', aliases: [], keywords: [], headings: [], body: BODY, frontmatter: {} }], { now });

test('every budget from 1 to 300 yields a snippet without a lone surrogate', () => {
  for (let budget = 1; budget <= 300; budget++) {
    const r = search(index, 'zebra', { limit: 1, budgetChars: budget, abstainThreshold: 0, asOf: now });
    assert.equal(r.abstained, false, `budget ${budget}`);
    const { snippet } = r.results[0];
    assert.equal(LONE_SURROGATE.test(snippet), false, `lone surrogate at budget ${budget}`);
    assert.ok(snippet.length <= budget, `budget ${budget}: length ${snippet.length}`);
    assert.equal(r.truncated, true, `budget ${budget} must be reported as truncated`);
    if (budget > 1) assert.ok(snippet.endsWith('…'), `budget ${budget} keeps the ellipsis`);
  }
});

test('an astral-only truncation keeps whole code points before the ellipsis', () => {
  const astralIndex = buildIndex([{ path: 'astral.md', title: 'Astral', aliases: [], keywords: [], headings: [], body: `Zebra ${ASTRAL.repeat(30)}`, frontmatter: {} }], { now });
  for (let budget = 1; budget <= 80; budget++) {
    const { snippet } = search(astralIndex, 'zebra', { limit: 1, budgetChars: budget, abstainThreshold: 0, asOf: now }).results[0];
    assert.equal(LONE_SURROGATE.test(snippet), false, `budget ${budget}`);
    const kept = [...snippet.slice(0, -1)];
    assert.ok(kept.every(ch => ch === ' ' || ch === '\u{1D11E}' || ch === '\u{20000}' || /[A-Za-z]/.test(ch)), `budget ${budget}`);
  }
});

test('ASCII truncation is unchanged: budget-1 characters followed by the ellipsis', () => {
  const text = `Zebra ${'abcdefghij'.repeat(10)}`;
  const plain = buildIndex([{ path: 'plain.md', title: 'Plain', aliases: [], keywords: [], headings: [], body: text, frontmatter: {} }], { now });
  const r = search(plain, 'zebra', { limit: 1, budgetChars: 20, abstainThreshold: 0, asOf: now });
  assert.equal(r.results[0].snippet, `${text.slice(0, 19)}…`);
  assert.equal(r.results[0].snippet.length, 20);
});

test('a budget that fits the whole snippet is not truncated and keeps the emoji intact', () => {
  const small = buildIndex([{ path: 'small.md', title: 'Small', aliases: [], keywords: [], headings: [], body: `Zebra ${EMOJI}`, frontmatter: {} }], { now });
  const r = search(small, 'zebra', { limit: 1, budgetChars: 100, abstainThreshold: 0, asOf: now });
  assert.equal(r.truncated, false);
  assert.equal(r.results[0].snippet, `Zebra ${EMOJI}`);
});
