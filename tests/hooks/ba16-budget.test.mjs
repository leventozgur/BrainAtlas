// SPDX-License-Identifier: MIT
// BA-16 regressions: prompt-hook budget packing (F1, F1b, F2) and the no-partial-header property.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../packages/hooks/src/index.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba16-hooks-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const vault = join(root, 'vault'), state = join(root, 'state'), home = join(root, 'home');
  await Promise.all([mkdir(vault), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return {env: {HOME: home}, config: {vault: {path: vault}, stateDir: state, hooks: {mode: 'normal', deadlineMs: 4700}}};
}

/** Claude prompt hook; returns the injected additionalContext ('' when the hook injected nothing). */
async function ask(f, prompt, session, retrieval = {}) {
  const config = {...f.config, retrieval: {abstainThreshold: 0, ...retrieval}};
  const r = await runHook({client: 'claude', event: 'prompt', stdin: JSON.stringify({session_id: session, prompt}), env: f.env, config, now: NOW});
  assert.equal(r.exitCode, 0);
  if (r.stdout === '{}') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const twoPages = {
  'alpha.md': '# Alpha\nzebrafish alpha note.',
  'beta.md': '# Beta\nzebrafish beta note text here.',
};

test('BA-16-F1: a small retrieval budget never leaves a path header cut short', async t => {
  const f = await fixture(t, twoPages);
  const context = await ask(f, 'zebrafish', 'f1', {budgetChars: 96});
  // A cut header looks like "Alpha (alpha." : an open parenthesis that never closes on its line.
  assert.doesNotMatch(context, /\([^()\n]*$/mu);
});

test('BA-16-F1b: only pages whose header was injected are recorded as seen', async t => {
  const f = await fixture(t, twoPages);
  const first = await ask(f, 'zebrafish', 'f1b', {budgetChars: 140});
  const second = await ask(f, 'zebrafish', 'f1b');
  const pages = ['alpha.md', 'beta.md'];
  const injected = pages.filter(p => first.includes(`(${p})`));
  const missing = pages.filter(p => !first.includes(`(${p})`));
  // The scenario only means something if the first call fit one page and not the other.
  assert.equal(injected.length, 1, `first call: ${JSON.stringify(first)}`);
  assert.equal(missing.length, 1, `first call: ${JSON.stringify(first)}`);
  for (const p of injected) assert.doesNotMatch(second, new RegExp(`\\(${p.replace('.', '\\.')}\\)`, 'u'));
  for (const p of missing) assert.match(second, new RegExp(`\\(${p.replace('.', '\\.')}\\)`, 'u'));
});

/** Split injected context into blocks, each starting at a "Title (path.md)" header line. */
function blocksOf(context) {
  const blocks = [];
  for (const line of context.split('\n')) {
    if (/ \([^()\n]+\.md\)$/u.test(line)) blocks.push({header: line, excerpt: []});
    else if (blocks.length) blocks.at(-1).excerpt.push(line);
  }
  return blocks;
}

// Each section redacts to a short marker, so the hook has room left after the search has spent its
// raw snippet budget on the first results; later results then reach the hook with empty snippets.
// Assembled at run time so the source never contains a key-shaped literal.
const privateKey = [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'MIIB'.repeat(110), ['-----END', 'PRIVATE KEY-----'].join(' ')].join('\n');

test('BA-16-F2: every injected result keeps an excerpt when its page has text', async t => {
  const pages = {};
  for (let i = 0; i < 12; i++) pages[`key${i}.md`] = `# Key ${i}\nzebrafish note ${i}\n${privateKey}\n`;
  const f = await fixture(t, pages);
  const context = await ask(f, 'zebrafish', 'f2');
  const blocks = blocksOf(context);
  assert.ok(blocks.length >= 2, `expected several blocks, got ${blocks.length}`);
  for (const block of blocks) assert.ok(block.excerpt.join('\n').trim() !== '', `header-only block: ${block.header}`);
});

test('BA-16 property: for every budget 1..200 no output contains an incomplete path header', async t => {
  const f = await fixture(t, twoPages);
  for (let budget = 1; budget <= 200; budget++) {
    const config = {...f.config, retrieval: {abstainThreshold: 0, budgetChars: budget}};
    const r = await runHook({client: 'claude', event: 'prompt', stdin: JSON.stringify({prompt: 'zebrafish'}), env: f.env, config, now: NOW});
    assert.equal(r.exitCode, 0);
    if (r.stdout === '{}') continue;
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(r.stdout.length <= budget, `budget ${budget}: output ${r.stdout.length} chars`);
    for (const [title, path] of [['Alpha', 'alpha.md'], ['Beta', 'beta.md']]) {
      if (context.includes(`${title} (`)) assert.ok(context.includes(`${title} (${path})`), `budget ${budget}: partial header in ${JSON.stringify(context)}`);
    }
  }
});

test('BA-16: a very large section is bounded and answered quickly', async t => {
  const f = await fixture(t, {'huge.md': `# Huge\nzebrafish ${'x '.repeat(200_000)}`});
  const started = Date.now();
  const context = await ask(f, 'zebrafish', 'huge');
  assert.ok(Date.now() - started < 4700);
  assert.match(context, /^Huge \(huge\.md\)\n# Huge\nzebrafish/u);
  assert.ok(JSON.stringify({hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: context}}).length <= 4002);
});
