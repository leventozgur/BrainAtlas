// SPDX-License-Identifier: MIT
// BA-07: the prompt hook's semantic step. Hermetic: temporary HOME, vault and state directories; no network.
// Every case here ends before an embedding request (semantic off, Lite, index missing, fingerprint mismatch,
// remote URL refused), so no fetch is ever attempted. The embedding path itself is covered in ba07-semantic-step.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, buildHookCommand } from '../../packages/hooks/src/index.mjs';
import { semanticRequested, SEMANTIC_BUDGET_MS } from '../../packages/hooks/src/semantic.mjs';
import { resolvePaths } from '../../packages/core/src/paths/index.mjs';
import { SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');
const PAGES = {
  'fish.md': '---\nstatus: confirmed\n---\n# Fish\n\nzebrafish husbandry notes for the aquarium.\n',
  'weak.md': '---\nstatus: proposed\n---\n# Weak Note\n\nzebrafish unverified remark.\n',
};

async function fixture(t, pages = PAGES) {
  const root = await mkdtemp(join(tmpdir(), 'ba07-hook-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const vault = join(root, 'vault'), wiki = join(vault, 'wiki'), state = join(root, 'state'), home = join(root, 'home');
  await Promise.all([mkdir(wiki, {recursive: true}), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(wiki, name), body);
  const env = {HOME: home};
  return {root, vault, wiki, state, env, globalState: resolvePaths({env}).stateDir};
}

function config(f, overrides = {}) {
  return {
    vault: {path: f.vault}, stateDir: f.state, hooks: {mode: 'normal', deadlineMs: 4700}, retrieval: {abstainThreshold: 0},
    profile: 'full', modules: ['*'], semantic: {enabled: true, dims: 2}, ...overrides,
  };
}

let counter = 0;
async function ask(f, cfg, prompt) {
  const session = `ba07-${counter++}`;
  const r = await runHook({client: 'claude', event: 'prompt', stdin: JSON.stringify({session_id: session, prompt}), env: f.env, config: cfg, now: NOW});
  assert.equal(r.exitCode, 0);
  const context = r.stdout === '{}' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  return {context, session};
}

async function lastMetric(f) {
  const lines = (await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8')).trim().split('\n');
  return JSON.parse(lines.at(-1));
}

test('semanticRequested: opt-in, non-Lite profile and an included module are all required', () => {
  assert.equal(semanticRequested({semantic: {enabled: true}, profile: 'full', modules: ['*']}), true);
  assert.equal(semanticRequested({semantic: {enabled: true}, profile: 'custom', modules: ['semantic']}), true);
  assert.equal(semanticRequested({semantic: {enabled: false}, profile: 'full', modules: ['*']}), false);
  assert.equal(semanticRequested({semantic: {enabled: true}, profile: 'lite', modules: ['*']}), false);
  assert.equal(semanticRequested({semantic: {enabled: true}, profile: 'custom', modules: []}), false);
  assert.equal(semanticRequested({profile: 'full', modules: ['*']}), false);
  assert.equal(SEMANTIC_BUDGET_MS, 350);
});

test('semantic off: the output and the metric record are the same as before (no semantic field)', async t => {
  const f = await fixture(t);
  const off = await ask(f, config(f, {semantic: {enabled: false}}), 'zebrafish');
  assert.match(off.context, /Fish \(wiki\/fish\.md\)/);
  const record = await lastMetric(f);
  assert.deepEqual(Object.keys(record).sort(), ['ts', 'client', 'event', 'mode', 'durationMs', 'chars', 'results', 'outcome', 'session'].sort());
});

test('Lite with semantic.enabled true never attempts the semantic step (no field, same output as off)', async t => {
  const f = await fixture(t);
  const off = await ask(f, config(f, {semantic: {enabled: false}, profile: 'lite', modules: []}), 'zebrafish');
  const lite = await ask(f, config(f, {profile: 'lite', modules: []}), 'zebrafish');
  assert.equal(lite.context, off.context);
  assert.equal('semantic' in (await lastMetric(f)), false);
});

test('semantic on without an index: falls back to the BM25 output unchanged and says why in the metric', async t => {
  const f = await fixture(t);
  const off = await ask(f, config(f, {semantic: {enabled: false}}), 'zebrafish');
  const on = await ask(f, config(f), 'zebrafish');
  assert.equal(on.context, off.context);
  assert.equal((await lastMetric(f)).semantic, 'fallback:index-missing');
});

test('semantic on with an index built for another model: fingerprint mismatch falls back to BM25', async t => {
  const f = await fixture(t);
  const {buildSemanticIndex, markdownChunks, createOllamaProvider} = await import('../../modules/semantic/src/index.mjs');
  // The provider is only used for the index build; the fake fetch answers locally, so no request leaves the process.
  const fake = async (url, options) => ({ok: true, json: async () => ({embeddings: JSON.parse(options.body).input.map(() => [1, 0])})});
  const other = {...SEMANTIC_DEFAULTS, model: 'some-other-model', dims: 2};
  await buildSemanticIndex({corpusDir: f.wiki, stateDir: f.globalState, provider: createOllamaProvider({...other, fetchImpl: fake}), chunkMarkdown: markdownChunks});
  const off = await ask(f, config(f, {semantic: {enabled: false}}), 'zebrafish');
  const on = await ask(f, config(f), 'zebrafish');
  assert.equal(on.context, off.context);
  assert.equal((await lastMetric(f)).semantic, 'fallback:fingerprint-mismatch');
});

test('a remote provider URL is refused before any request, and the hook keeps BM25', async t => {
  const f = await fixture(t);
  const off = await ask(f, config(f, {semantic: {enabled: false}}), 'zebrafish');
  const remote = await ask(f, config(f, {semantic: {enabled: true, dims: 2, baseUrl: 'http://203.0.113.10:11434'}}), 'zebrafish');
  assert.equal(remote.context, off.context);
  assert.equal((await lastMetric(f)).semantic, 'fallback:remote-not-allowed');
});

test('metric records carry no prompt text, page paths or session identifiers', async t => {
  const f = await fixture(t);
  await ask(f, config(f), 'zebrafish husbandry');
  const raw = await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /zebrafish|husbandry|fish\.md|wiki|ba07-\d/u);
  assert.match(raw, /"semantic":"fallback:/u);
});

test('permission command grants read access to the global semantic index only', async t => {
  const f = await fixture(t);
  const bin = join(process.cwd(), 'packages/hooks/bin/brainatlas-hook.mjs');
  const savedHome = process.env.HOME;
  process.env.HOME = f.env.HOME;
  t.after(() => { process.env.HOME = savedHome; });
  const command = buildHookCommand({nodePath: process.execPath, shimPath: bin, client: 'claude', event: 'prompt',
    paths: {vault: f.vault, state: f.state, release: process.cwd()}});
  if (!command.includes('--permission')) { t.diagnostic('Node permission model unavailable here'); return; }
  assert.ok(command.includes(`--allow-fs-read=${join(f.globalState, 'semantic')}`));
  assert.ok(!command.some(flag => flag === `--allow-fs-write=${join(f.globalState, 'semantic')}`));
});
