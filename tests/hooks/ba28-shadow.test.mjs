// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../packages/hooks/src/index.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');
const PAGES = Object.fromEntries(
  Array.from({ length: 6 }, (_, index) => [
    `topic-${index + 1}.md`,
    `# Topic ${index + 1}\n\ntopic evidence number ${index + 1}\n`,
  ])
);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ba28-shadow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state');
  await mkdir(vault);
  await mkdir(state);
  for (const [name, body] of Object.entries(PAGES)) await writeFile(join(vault, name), body);
  return { vault, state };
}

function config(f, overrides = {}) {
  return {
    vault: { path: f.vault },
    stateDir: f.state,
    hooks: { mode: 'normal', deadlineMs: 4700 },
    retrieval: { abstainThreshold: 0.35 },
    ...overrides,
  };
}

let counter = 0;
async function ask(f, cfg, prompt = 'topic') {
  const session = `ba28-${counter++}`;
  const result = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: session, prompt }),
    env: {},
    config: cfg,
    now: NOW,
  });
  assert.equal(result.exitCode, 0);
  return result;
}

async function lastMetric(f) {
  const lines = (await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8')).trim().split('\n');
  return JSON.parse(lines.at(-1));
}

test('shadow absent keeps the previous metric keys', async (t) => {
  const f = await fixture(t);
  await ask(f, config(f));
  const record = await lastMetric(f);
  assert.deepEqual(
    Object.keys(record).sort(),
    ['ts', 'client', 'event', 'mode', 'durationMs', 'chars', 'results', 'outcome', 'session'].sort()
  );
  assert.equal('shadow' in record, false);
});

test('equal shadow threshold is identical to the baseline', async (t) => {
  const f = await fixture(t);
  const result = await ask(f, config(f, { retrieval: { abstainThreshold: 0.35, shadow: { abstainThreshold: 0.35 } } }));
  assert.match(result.stdout, /Topic/);
  const record = await lastMetric(f);
  assert.deepEqual(record.shadow, { top1Same: true, overlap5: 5, injectDiff: false });
  assert.deepEqual(Object.keys(record.shadow).sort(), ['injectDiff', 'overlap5', 'top1Same']);
});

test('a lower shadow threshold reuses the non-empty baseline', async (t) => {
  const f = await fixture(t);
  const result = await ask(f, config(f, { retrieval: { abstainThreshold: 0.35, shadow: { abstainThreshold: 0 } } }));
  assert.match(result.stdout, /Topic/);
  assert.deepEqual((await lastMetric(f)).shadow, { top1Same: true, overlap5: 5, injectDiff: false });
});

test('a stricter shadow threshold that still matches reuses the baseline', async (t) => {
  const f = await fixture(t);
  const result = await ask(f, config(f, { retrieval: { abstainThreshold: 0, shadow: { abstainThreshold: 0.35 } } }));
  assert.match(result.stdout, /Topic/);
  assert.deepEqual((await lastMetric(f)).shadow, { top1Same: true, overlap5: 5, injectDiff: false });
});

test('an empty baseline compares with the shadow top five', async (t) => {
  const f = await fixture(t);
  const result = await ask(f, config(f, { retrieval: { abstainThreshold: 1, shadow: { abstainThreshold: 0.35 } } }));
  assert.doesNotMatch(result.stdout, /Topic/);
  assert.deepEqual((await lastMetric(f)).shadow, { top1Same: false, overlap5: 0, injectDiff: true });
});

test('an empty baseline stays empty when the shadow threshold is at least as strict', async (t) => {
  const f = await fixture(t);
  const result = await ask(f, config(f, { retrieval: { abstainThreshold: 1, shadow: { abstainThreshold: 1 } } }));
  assert.doesNotMatch(result.stdout, /Topic/);
  assert.deepEqual((await lastMetric(f)).shadow, { top1Same: true, overlap5: 0, injectDiff: false });
});

test('an exclude list keeps the shadow comparison inside the same search scope', async (t) => {
  const f = await fixture(t);
  const result = await ask(
    f,
    config(f, { retrieval: { abstainThreshold: 0.35, exclude: ['topic-1.md'], shadow: { abstainThreshold: 1 } } })
  );
  assert.doesNotMatch(result.stdout, /topic-1\.md/);
  assert.match(result.stdout, /Topic 2/);
  assert.deepEqual((await lastMetric(f)).shadow, { top1Same: false, overlap5: 0, injectDiff: true });
});

test('shadow threshold 1 abstains while the baseline injects', async (t) => {
  const f = await fixture(t);
  const result = await ask(f, config(f, { retrieval: { abstainThreshold: 0.35, shadow: { abstainThreshold: 1 } } }));
  assert.match(result.stdout, /Topic/);
  assert.deepEqual((await lastMetric(f)).shadow, { top1Same: false, overlap5: 0, injectDiff: true });
});

test('stdout and exit code are byte-identical with and without shadow', async (t) => {
  const f = await fixture(t);
  const cases = [
    { prompt: 'topic', hooks: { mode: 'normal', deadlineMs: 4700 } },
    { prompt: 'nothing-matches-this-query', hooks: { mode: 'normal', deadlineMs: 4700 } },
    { prompt: 'topic', hooks: { mode: 'normal', deadlineMs: 1 } },
  ];
  for (const item of cases) {
    const plain = await ask(f, config(f, { hooks: item.hooks }), item.prompt);
    const shadow = await ask(
      f,
      config(f, { hooks: item.hooks, retrieval: { abstainThreshold: 0.35, shadow: { abstainThreshold: 1 } } }),
      item.prompt
    );
    assert.equal(shadow.stdout, plain.stdout);
    assert.equal(shadow.exitCode, plain.exitCode);
  }
  const record = await lastMetric(f);
  assert.equal(record.outcome, 'deadline');
});

test('the shadow metric carries aggregates only, never prompt or page content', async (t) => {
  const f = await fixture(t);
  await ask(f, config(f, { retrieval: { abstainThreshold: 0.35, shadow: { abstainThreshold: 1 } } }), 'topic evidence');
  const raw = await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /topic evidence|topic-1\.md|ba28-\d/);
  assert.deepEqual(Object.keys((await lastMetric(f)).shadow).sort(), ['injectDiff', 'overlap5', 'top1Same']);
});
