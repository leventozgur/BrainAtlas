// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookCases } from '../../eval/hook-eval.mjs';
import { parseBlockHeading, parseInjectedPaths } from '../../eval/lib/hook-records.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');
const HEADER = 'More matches (open with wiki_read_page path + anchor):';

function corpus(t, count) {
  const dir = mkdtempSync(join(tmpdir(), 'ba32-eval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const corpusDir = join(dir, 'corpus');
  mkdirSync(corpusDir);
  for (let i = 1; i <= count; i++) writeFileSync(join(corpusDir, `p${i}.md`), `# Page ${i}\nzebrafish note ${i}\n`);
  return corpusDir;
}

test('BA-32: a block title with an anchor names its path without the fragment, for paths and headings', () => {
  const known = new Set(['alpha.md']);
  const context = 'Alpha (alpha.md#alpha)\n# Alpha\ntext';
  assert.deepEqual(parseInjectedPaths(context, known), ['alpha.md']);
  assert.equal(parseBlockHeading(context, 'alpha.md'), 'Alpha');
  assert.equal(parseBlockHeading(context, 'alpha.md#alpha'), null);
});

test('BA-32: pointer lines after the exact header add their paths; other pointer-like lines are ignored', () => {
  const known = new Set(['alpha.md', 'beta.md', 'gamma.md']);
  const context = [
    'Alpha (alpha.md#alpha)',
    '# Alpha',
    'text',
    '',
    'Beta (beta.md)',
    '# Beta',
    'text',
    '',
    HEADER,
    '- Gamma › G (gamma.md#g)',
    '- Beta again (beta.md)',
    '- Ghost (ghost.md)',
  ].join('\n');
  assert.deepEqual(parseInjectedPaths(context, known), ['alpha.md', 'beta.md', 'gamma.md']);
  assert.deepEqual(parseInjectedPaths('Alpha (alpha.md)\nsnippet\n- x (beta.md)', known), ['alpha.md']);
  assert.deepEqual(parseInjectedPaths('Alpha (alpha.md)\nsnippet\n- x (gamma.md#g)', known), ['alpha.md']);
});

test('BA-32: a pointer-like line after a blank line is neither a block nor a pointer', () => {
  const known = new Set(['alpha.md', 'beta.md']);
  const context = ['Alpha (alpha.md)', '# Alpha', 'text', '', '- bullet (beta.md)'].join('\n');
  assert.deepEqual(parseInjectedPaths(context, known), ['alpha.md']);
  assert.equal(parseBlockHeading(context, 'beta.md'), null);
});

test('BA-32: a blank line ends the pointer run; a later pointer-like line is ignored', () => {
  const known = new Set(['alpha.md', 'beta.md', 'gamma.md']);
  const context = [HEADER, '- Beta (beta.md)', '', '- Gamma (gamma.md)'].join('\n');
  assert.deepEqual(parseInjectedPaths(context, known), ['beta.md']);
  assert.equal(parseBlockHeading(context, 'gamma.md'), null);
});

test('BA-32: runHookCases progressive injects two blocks and six pointers; full stays nine blocks', async (t) => {
  const corpusDir = corpus(t, 9);
  const cases = [{ query: 'zebrafish', relevant: ['p1.md'], category: 'ba32' }];
  const full = await runHookCases({ corpusDir, cases, now: NOW, abstainThreshold: 0 });
  assert.equal(full[0].injected.length, 9);
  const progressive = await runHookCases({
    corpusDir,
    cases,
    now: NOW,
    abstainThreshold: 0,
    disclosure: 'progressive',
  });
  assert.deepEqual(progressive[0].injected, ['p1.md', 'p2.md', 'p3.md', 'p4.md', 'p5.md', 'p6.md', 'p7.md', 'p8.md']);
});

test('BA-32: runHookCases rejects an unknown disclosure', async (t) => {
  const corpusDir = corpus(t, 1);
  await assert.rejects(() => runHookCases({ corpusDir, cases: [], disclosure: 'partial' }), /Invalid disclosure/);
  await assert.rejects(() => runHookCases({ corpusDir, cases: [], disclosure: null }), /Invalid disclosure/);
});
