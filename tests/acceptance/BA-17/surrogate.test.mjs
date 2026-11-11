// SPDX-License-Identifier: MIT
// BA-17 surrogate fix, black-box through search(): for every integer budget 1..400 no returned snippet may contain a
// lone UTF-16 surrogate, the snippets together must fit the budget, a truncated snippet ends with exactly one ellipsis
// and keeps a prefix of the full snippet, and a snippet that fits is returned whole. Hermetic and deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRetrieval, page, prng, LONE_SURROGATE, NOW } from './support.mjs';

const { buildIndex, search } = await loadRetrieval();
const ELL = '…';
const q = (index, query, options) => search(index, query, { abstainThreshold: 0, asOf: NOW, ...options });
const fullSnippet = (index, query) => q(index, query, { limit: 1 }).results[0].snippet;

const bodies = [
  '🚀'.repeat(120),
  '𝓐𝓑𝓒𝓓'.repeat(60),
  '👨‍👩‍👧‍👦'.repeat(40),
  '🇹🇷🇩🇪🇯🇵'.repeat(40),
  'çalışma İstanbul ığüşöç ŞŞ '.repeat(15) + '😀'.repeat(30),
  'é'.repeat(100) + '𝓐🚀',
  'x'.repeat(5) + '🚀'.repeat(60) + ' tail',
  '1️⃣2️⃣3️⃣'.repeat(30),
  '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'.repeat(30),
];
// Shift the astral and emoji runs by 0..3 ASCII units so cuts land on every position of a pair.
const shifted = bodies.flatMap((b) => [0, 1, 2, 3].map((n) => 'a'.repeat(n) + ' alpha ' + b));

test('single-result snippets: every budget 1..400 gives no lone surrogate, a fitting length and a correct ellipsis', () => {
  let truncatedCount = 0;
  shifted.forEach((body, i) => {
    const index = buildIndex([page(`s/${i}.md`, body, { title: `S${i}` })], { now: NOW });
    const full = fullSnippet(index, 'alpha');
    assert.ok(full.length > 0, 'fixture must produce a snippet');
    for (let b = 1; b <= 400; b++) {
      const r = q(index, 'alpha', { limit: 1, budgetChars: b });
      assert.equal(r.abstained, false, `case ${i} budget ${b} must not abstain`);
      const s = r.results[0].snippet;
      assert.equal(LONE_SURROGATE.test(s), false, `case ${i} budget ${b}: lone surrogate in ${JSON.stringify(s.slice(-4))}`);
      assert.ok(s.length <= b, `case ${i} budget ${b}: length ${s.length} exceeds budget`);
      if (full.length <= b) {
        assert.equal(s, full, `case ${i} budget ${b}: fitting snippet must be whole`);
        assert.equal(r.truncated, false);
      } else {
        truncatedCount++;
        assert.equal(r.truncated, true, `case ${i} budget ${b}: truncated flag`);
        assert.ok(s.endsWith(ELL), `case ${i} budget ${b}: must end with ellipsis`);
        assert.equal(s.indexOf(ELL), s.length - 1, `case ${i} budget ${b}: one ellipsis only, at the end`);
        assert.ok(b - s.length <= 1, `case ${i} budget ${b}: at most one unit short of the budget (got ${s.length})`);
        assert.ok(full.startsWith(s.slice(0, -1)), `case ${i} budget ${b}: must keep a prefix of the full snippet`);
      }
    }
  });
  assert.ok(truncatedCount > 5000, `truncation cases exercised: ${truncatedCount}`);
});

test('multi-result budgets: snippets together never exceed the budget and none has a lone surrogate', () => {
  const pages = shifted.map((body, i) => page(`m/${String(i).padStart(2, '0')}.md`, body, { title: `M${i}` }));
  const index = buildIndex(pages, { now: NOW });
  for (let b = 1; b <= 400; b++) {
    const r = q(index, 'alpha', { limit: 8, budgetChars: b });
    const total = r.results.reduce((sum, x) => sum + x.snippet.length, 0);
    assert.ok(total <= b, `budget ${b}: total ${total}`);
    for (const x of r.results) assert.equal(LONE_SURROGATE.test(x.snippet), false, `budget ${b}: ${x.path}`);
    // A result cut by the budget is either ellipsised or, once the budget is spent, empty; without a cut the flag is false.
    if (!r.truncated) assert.equal(r.results.some(x => x.snippet.endsWith(ELL)), false, `budget ${b}: no ellipsis without truncation`);
    else assert.ok(r.results.some(x => x.snippet.endsWith(ELL) || x.snippet === ''), `budget ${b}: truncated flag needs a cut`);
  }
});

test('property: random mixed emoji, astral, ZWJ, flag, combining and Turkish text never yields a lone surrogate', () => {
  const rand = prng(20261111);
  const pieces = ['a', ' ', 'ç', 'ğ', 'İ', 'ı', 'ş', '🚀', '😀', '𝓐', '𝔘', '👨‍👩‍👧', '🇹🇷', 'é', '1️⃣', '‍', '—', '…'];
  for (let n = 0; n < 60; n++) {
    let body = 'alpha ';
    const len = 1 + Math.floor(rand() * 180);
    for (let k = 0; k < len; k++) body += pieces[Math.floor(rand() * pieces.length)];
    const index = buildIndex([page(`r/${n}.md`, body, { title: `R${n}` })], { now: NOW });
    const full = fullSnippet(index, 'alpha');
    for (let b = 1; b <= 400; b++) {
      const s = q(index, 'alpha', { limit: 1, budgetChars: b }).results[0].snippet;
      assert.equal(LONE_SURROGATE.test(s), false, `random case ${n} budget ${b}`);
      assert.ok(s.length <= b, `random case ${n} budget ${b}`);
      assert.ok(full.startsWith(s.endsWith(ELL) && s.length < full.length ? s.slice(0, -1) : s), `random case ${n} budget ${b}: prefix`);
    }
  }
});

test('invalid budgets keep their previous meaning: zero budget gives an empty snippet and a truncated flag', () => {
  const index = buildIndex([page('z.md', '🚀 alpha 𝓐', { title: 'Z' })], { now: NOW });
  const r = q(index, 'alpha', { limit: 1, budgetChars: 0 });
  assert.equal(r.results[0].snippet, '');
  assert.equal(r.truncated, true);
});
