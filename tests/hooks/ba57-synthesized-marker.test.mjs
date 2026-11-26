// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../packages/hooks/src/index.mjs';
import { semanticHits } from '../../packages/hooks/src/semantic.mjs';
import { createSearcher } from '../../packages/core/src/retrieval/index.mjs';
import { SEMANTIC_DEFAULTS } from '../../packages/core/src/config/index.mjs';

const NOW = new Date('2026-11-20T00:00:00Z');
const OPEN = '<!-- brainatlas:current-state -->';
const CLOSE = '<!-- /brainatlas:current-state -->';
const record =
  '  - date: "2026-01-12"\n    evidence: "review"\n    scope: "zebrafish"\n    source: "wiki/sources/z.md"\n';
const block = (sentence) => `## Current state (proposed 2026-11-18)\n${OPEN}\n- ${sentence}\n${CLOSE}\n`;

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba57-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state'),
    home = join(root, 'home');
  await Promise.all([mkdir(vault), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return {
    env: { HOME: home },
    config: { vault: { path: vault }, stateDir: state, hooks: { mode: 'normal', deadlineMs: 4700 } },
  };
}

async function ask(f, prompt, session, hooks = {}) {
  const config = { ...f.config, hooks: { ...f.config.hooks, ...hooks }, retrieval: { abstainThreshold: 0 } };
  const r = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: session, prompt }),
    env: f.env,
    config,
    now: NOW,
  });
  assert.equal(r.exitCode, 0);
  if (r.stdout === '{}') return '';
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const pages = {
  'synth-verified.md': `---\nstatus: confirmed\nverified:\n${record}---\n# Zephyr Board\n\n## 2026-01-05 notes\n\nkestrel note.\n\n${block('The zebrafish ledger is reconciled weekly.')}`,
  'synth-weak.md': `---\nstatus: proposed\n---\n# Weak Board\n\n${block('The zebrafish pond is drained weekly.')}`,
  'plain.md': '---\nstatus: draft\n---\n# Plain Note\n\nzebrafish plain note text.\n',
};

test('BA-57: a synthesized section is marked in the title line, weak and synthesized keep both markers', async (t) => {
  const f = await fixture(t, pages);
  const context = await ask(f, 'zebrafish', 'ba57-marker');
  const lines = context.split('\n');
  assert.ok(lines.includes('Zephyr Board [synthesized] (synth-verified.md)'), context);
  assert.ok(lines.includes('Weak Board [unverified] [synthesized] (synth-weak.md)'), context);
  assert.ok(lines.includes('Plain Note (plain.md)'), context);
  assert.equal(context.split('[synthesized]').length - 1, 2);
});

test('BA-57: the synthesized title line still ends with its path', async (t) => {
  const f = await fixture(t, pages);
  const context = await ask(f, 'zebrafish', 'ba57-parse');
  for (const path of ['synth-verified.md', 'synth-weak.md']) {
    assert.ok(
      context.split('\n').some((line) => line.endsWith(`(${path})`)),
      path
    );
  }
});

const settings = { ...SEMANTIC_DEFAULTS, dims: 2 };
const stubModule = (hits) => ({
  validateConfiguredProvider() {},
  createOllamaProvider: () => ({ fingerprint: 'fp', dims: 2 }),
  readSemanticIndex: async () => ({
    entries: [{ path: 'board.md', vector: [1, 0] }],
    providerFingerprint: 'fp',
    dims: 2,
  }),
  searchHybrid: async () => hits,
});
const BOARD = `---\nstatus: confirmed\nverified:\n${record}---\n# Board\n\n## 2026-01-05 notes\n\nrotation schedule nightly.\n\n${block('The zebrafish ledger is reconciled weekly.')}`;
const hit = (extra = {}) => [
  {
    path: 'board.md',
    title: 'Board',
    status: 'confirmed',
    stale: false,
    semanticScore: 0.9,
    snippet: 'semantic chunk',
    headingPath: 'Board > Current state (proposed 2026-11-18)',
    rrfScore: 0.03,
    ...extra,
  },
];

async function semanticFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ba57-semantic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state');
  await Promise.all([mkdir(vault), mkdir(state)]);
  await writeFile(join(vault, 'board.md'), BOARD);
  return { searcher: createSearcher({ vaultDir: vault, stateDir: state }), state };
}

async function hybrid(f, query, hits) {
  const lexical = f.searcher.search(query, { limit: 20, abstainThreshold: 0 }).results;
  const answer = await semanticHits({
    searcher: f.searcher,
    query,
    limit: 20,
    abstainThreshold: 0,
    lexical,
    settings,
    stateDir: f.state,
    prepare: (item) => item,
    loadModule: async () => stubModule(hits),
  });
  assert.equal(answer.semantic, 'used');
  return { lexical, results: answer.results };
}

test('BA-57 hybrid: a hit carrying the synthesized flag loses verified trust', async (t) => {
  const f = await semanticFixture(t);
  const { lexical, results } = await hybrid(f, 'zebrafish', hit({ synthesized: true }));
  assert.equal(lexical[0].synthesized, true, 'the lexical row is the synthesized section (precondition)');
  assert.equal(Object.hasOwn(lexical[0], 'trust'), false);
  assert.equal(results[0].synthesized, true);
  assert.equal(Object.hasOwn(results[0], 'trust'), false, 'a synthesized hit is never verified evidence');
});

test('BA-57 hybrid: a hit whose headingPath ends in the synthesized heading is flagged too', async (t) => {
  const f = await semanticFixture(t);
  const { lexical, results } = await hybrid(f, 'zebrafish', hit());
  assert.equal(lexical[0].synthesized, true, 'the lexical row is the synthesized section (precondition)');
  assert.equal(results[0].headingPath, 'Board > Current state (proposed 2026-11-18)');
  assert.equal(Object.hasOwn(results[0], 'heading'), false);
  assert.equal(Object.hasOwn(results[0], 'anchor'), false);
  assert.equal(results[0].synthesized, true);
  assert.equal(Object.hasOwn(results[0], 'trust'), false, 'a synthesized hit is never verified evidence');
});

test('BA-57 hybrid: a hit whose headingPath points at another section keeps verified trust and no flag', async (t) => {
  const f = await semanticFixture(t);
  const { lexical, results } = await hybrid(f, 'zebrafish rotation', hit({ headingPath: 'Board > 2026-01-05 notes' }));
  assert.equal(lexical[0].synthesized, true, 'the lexical row is the synthesized section (precondition)');
  assert.equal(Object.hasOwn(lexical[0], 'trust'), false);
  assert.deepEqual(results[0], {
    path: 'board.md',
    title: 'Board',
    status: 'confirmed',
    stale: false,
    semanticScore: 0.9,
    snippet: 'semantic chunk',
    headingPath: 'Board > 2026-01-05 notes',
    rrfScore: 0.03,
    trust: 'verified',
  });
  assert.equal(Object.hasOwn(results[0], 'synthesized'), false);
});

test('BA-57: progressive pointer lines carry the marker after the heading', async (t) => {
  const many = { ...pages };
  for (const name of ['third.md', 'fourth.md'])
    many[name] = `---\nstatus: draft\n---\n# ${name}\n\nzebrafish ${name} text.\n`;
  const f = await fixture(t, many);
  const context = await ask(f, 'zebrafish', 'ba57-pointer', { disclosure: 'progressive' });
  const lines = context.split('\n');
  const pointer = lines.find((line) => line.startsWith('- ') && line.includes('synth-weak.md'));
  assert.ok(pointer, context);
  assert.match(
    pointer,
    /^- Weak Board › Current state \(proposed 2026-11-18\) \[unverified\] \[synthesized\] \(synth-weak\.md#/u
  );
});
