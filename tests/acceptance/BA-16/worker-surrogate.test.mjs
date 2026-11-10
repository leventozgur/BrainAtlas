// SPDX-License-Identifier: MIT
// BA-16 retest (independent tester): the worker excerpt cap must never leave a lone surrogate, and redaction
// must run before the cap. Black-box: drives the worker through workerData and the hook through runHook.
// BA16_WORKER_MODULE overrides the worker under test (used to prove the fixture fails on the pre-fix worker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const WORKER = process.env.BA16_WORKER_MODULE || fileURLToPath(new URL('../../../packages/hooks/src/worker.mjs', import.meta.url));
const HOOK = process.env.BA16_HOOK_MODULE || fileURLToPath(new URL('../../../packages/hooks/src/index.mjs', import.meta.url));
const { runHook } = await import(pathToFileURL(HOOK).href);
const NOW = new Date('2026-11-10T00:00:00Z');
const EXCERPT_LIMIT = 4002;
// In a Unicode-mode regex, a valid surrogate pair is one code point outside this range, so any match is a lone half.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
// Synthetic Anthropic-style key assembled at run time (same convention as the other BA-16 tests).
const TAIL = 'Zx9Qw3rT7yU1iO5pA2sD8fGh';
const SECRET = ['sk', 'ant'].join('-') + '-' + TAIL;
const EMOJI = '\u{1F600}'; // U+1F600 is a surrogate pair (D83D DE00) in UTF-16.

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba16-surr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), vault = join(root, 'vault'), state = join(root, 'state');
  await mkdir(home); await mkdir(vault); await mkdir(state);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return { root, home, vault, state, env: { HOME: home } };
}

// Runs the worker exactly as the hook does (same options and search options) and returns its results.
function runWorker(f, query) {
  const workerData = {
    options: { vaultDir: f.vault, stateDir: f.state, now: NOW },
    query,
    searchOptions: { limit: 20, abstainThreshold: 0 },
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(WORKER), { workerData });
    worker.once('message', value => { void worker.terminate(); value.error ? reject(new Error('worker error')) : resolve(value.results); });
    worker.once('error', error => { void worker.terminate(); reject(error); });
    worker.once('exit', () => reject(new Error('worker exited without a message')));
  });
}

async function ask(f, prompt, { budget, session }) {
  const retrieval = { abstainThreshold: 0 };
  if (budget !== undefined) retrieval.budgetChars = budget;
  const config = { vault: { path: f.vault }, stateDir: f.state, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval };
  const res = await runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ session_id: session, prompt }), env: f.env, config, now: NOW });
  const context = res.stdout && res.stdout !== '{}' ? JSON.parse(res.stdout).hookSpecificOutput.additionalContext : '';
  return { stdout: res.stdout, exitCode: res.exitCode, context };
}

// Page whose section text puts a full emoji pair on snippet indices 4001-4002. Its heading line is
// "# Emoji" + "\n" and the body starts "zebrafish " (18 chars), so 3983 ASCII letters put the pair at 4001.
const BOUNDARY_BODY = '# Emoji\nzebrafish ' + 'a'.repeat(3983) + EMOJI.repeat(3) + ' tail';

test('worker: a snippet cut at 4002 that would split a surrogate pair ends on a whole code point', async t => {
  const f = await fixture(t, { 'emoji.md': BOUNDARY_BODY });
  const results = await runWorker(f, 'zebrafish');
  assert.equal(results.length, 1, 'expected the single fixture page');
  const snippet = results[0].snippet;
  assert.ok(snippet.length <= EXCERPT_LIMIT, `snippet length ${snippet.length} exceeds ${EXCERPT_LIMIT}`);
  assert.doesNotMatch(snippet, LONE_SURROGATE, `lone surrogate at end: ${JSON.stringify(snippet.slice(-4))}`);
  // The cut lands inside the pair, so the cap must back off to 4001 and drop the whole emoji.
  assert.equal(snippet.length, EXCERPT_LIMIT - 1, `expected backoff to ${EXCERPT_LIMIT - 1}, got ${snippet.length}`);
  assert.ok(snippet.startsWith('# Emoji\nzebrafish aaa'), 'excerpt lost its opening');
});

test('worker: an emoji fully inside the cap is kept intact', async t => {
  const f = await fixture(t, { 'emoji.md': '# Emoji\nzebrafish ' + 'a'.repeat(100) + EMOJI + ' tail' });
  const [result] = await runWorker(f, 'zebrafish');
  assert.ok(result.snippet.includes(EMOJI), 'emoji inside the cap was dropped');
  assert.doesNotMatch(result.snippet, LONE_SURROGATE);
});

test('worker: a key that straddles the 4002 cut is redacted whole, never partially leaked', async t => {
  // "# Ops\nzebrafish " is 16 chars; the space keeps a word boundary before the key, which starts at snippet
  // index 3987 and runs past 4002. An excerpt-first cut would keep "sk-ant-Zx9Qw3" unredacted.
  const f = await fixture(t, { 'ops.md': '# Ops\nzebrafish ' + 'a'.repeat(3970) + ' ' + SECRET + ' rotate weekly.' });
  const [result] = await runWorker(f, 'zebrafish');
  assert.ok(!result.snippet.includes(SECRET), 'full secret in worker output');
  assert.ok(!result.snippet.includes('sk-ant-'), 'secret prefix leaked past the cut');
  for (let i = 0; i + 4 <= TAIL.length; i++) assert.ok(!result.snippet.includes(TAIL.slice(i, i + 4)), `key fragment "${TAIL.slice(i, i + 4)}" leaked`);
  assert.doesNotMatch(result.snippet, LONE_SURROGATE);
});

test('hook: the injected context never contains a lone surrogate, across budgets and the boundary page', async t => {
  const f = await fixture(t, { 'emoji.md': BOUNDARY_BODY });
  for (const budget of [undefined, 4002, 4001, 3000, 1000, 300, 120]) {
    const r = await ask(f, 'zebrafish', { budget, session: `surr-${budget ?? 'default'}` });
    assert.doesNotMatch(r.context, LONE_SURROGATE, `budget ${budget}: lone surrogate in context`);
    assert.ok(r.stdout.length <= EXCERPT_LIMIT, `budget ${budget}: stdout ${r.stdout.length}`);
    if (r.context) assert.ok(r.context.startsWith('Emoji (emoji.md)'), `budget ${budget}: ${JSON.stringify(r.context.slice(0, 40))}`);
  }
});

test('hook: a surrogate pair fully inside the budget is injected without damage', async t => {
  const f = await fixture(t, { 'emoji-short.md': '# Emoji Short\nzebrafish note ' + EMOJI.repeat(2) + ' end.' });
  const r = await ask(f, 'zebrafish', { session: 'surr-short' });
  assert.ok(r.context.includes(EMOJI.repeat(2)), `pair missing: ${JSON.stringify(r.context)}`);
  assert.doesNotMatch(r.context, LONE_SURROGATE);
});
