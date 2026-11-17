// SPDX-License-Identifier: MIT
// BA-32b: per-block clips of the opt-in progressive hook format — the first full block is never clipped by progressive
// packing, the second is clipped to 300 UTF-16 units, and `full` stays byte-identical. Hermetic: temporary vault, state
// and HOME directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../packages/hooks/src/index.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');
const HEADER = 'More matches (open with wiki_read_page path + anchor):';
const text = (r) => (r.stdout === '{}' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext);
const stateFile = (f, session, client = 'claude') =>
  join(f.state, 'hooks', `${client}-${createHash('sha256').update(session).digest('hex')}.json`);

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba32b-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'),
    state = join(root, 'state'),
    home = join(root, 'home');
  await Promise.all([mkdir(vault), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return { env: { HOME: home }, vault, state };
}

async function run(f, session, prompt, { hooks = {}, retrieval = {}, client = 'claude' } = {}) {
  const config = {
    vault: { path: f.vault },
    stateDir: f.state,
    hooks: { mode: 'normal', deadlineMs: 4700, ...hooks },
    retrieval: { abstainThreshold: 0, ...retrieval },
  };
  const result = await runHook({
    client,
    event: 'prompt',
    stdin: JSON.stringify({ session_id: session, prompt }),
    env: f.env,
    config,
    now: NOW,
  });
  assert.equal(result.exitCode, 0);
  return result;
}

const ask = async (f, session, prompt, options) =>
  text(await run(f, session, prompt, { hooks: { disclosure: 'progressive' }, ...options }));
const excerpts = (context) => context.split('\n\n').map((block) => block.split('\n').slice(1).join('\n'));
// A short page that outranks the long one, so the long snippet is always the second full block.
const strong = ['# Strong', 'zebrafish '.repeat(6).trim()].join('\n');
const clipped = (snippet) => ({ 'aa.md': `${strong}\n`, 'zz-long.md': snippet });

test('BA-32b: the first full block keeps a 2000-unit snippet whole (no progressive ellipsis)', async (t) => {
  const f = await fixture(t, { 'long.md': `# Long\nzebrafish ${'a'.repeat(2000)}` });
  const context = await ask(f, 'long', 'zebrafish');
  assert.equal(excerpts(context).length, 1);
  assert.equal(excerpts(context)[0], `# Long\nzebrafish ${'a'.repeat(2000)}`);
  assert.equal(excerpts(context)[0].length, 2017);
  assert.equal(excerpts(context)[0].endsWith('…'), false);
});

test('BA-32b: a Codex-capped single result is cut exactly as full mode cuts it', async (t) => {
  const pages = { 'flat.md': `zebrafish ${'a'.repeat(2000)}` };
  const progressive = await run(await fixture(t, pages), 'codex', 'zebrafish', {
    hooks: { disclosure: 'progressive' },
    client: 'codex',
  });
  const full = await run(await fixture(t, pages), 'codex', 'zebrafish', { client: 'codex' });
  assert.equal(progressive.stdout, full.stdout);
  const excerpt = excerpts(text(progressive))[0];
  assert.ok(excerpt.length < 2000);
  assert.ok(excerpt.endsWith('…'));
});

test('BA-32b: two results keep the first excerpt whole and clip the second to 300 units', async (t) => {
  const snippet = `# Long\nzebrafish ${'a'.repeat(2000)}`;
  const f = await fixture(t, clipped(snippet));
  const context = await ask(f, 'two', 'zebrafish');
  assert.deepEqual(excerpts(context), [strong, `${snippet.slice(0, 299)}…`]);
});

test('BA-32b: a second snippet of 300 units is unchanged, 301 units becomes 299 plus an ellipsis', async (t) => {
  for (const [length, expected] of [
    [300, 300],
    [301, 300],
  ]) {
    const snippet = `# Two\nzebrafish ${'a'.repeat(length - 16)}`;
    assert.equal(snippet.length, length);
    const f = await fixture(t, clipped(snippet));
    const excerpt = excerpts(await ask(f, `n${length}`, 'zebrafish'))[1];
    assert.equal(excerpt.length, expected, `snippet ${length}`);
    assert.equal(excerpt.endsWith('…'), length > 300);
  }
});

test('BA-32b: a second snippet cut at 299 units never splits a surrogate pair', async (t) => {
  const snippet = `# Astral\nzebrafish ${'a'.repeat(279)}😀${'b'.repeat(100)}`;
  const f = await fixture(t, clipped(snippet));
  const excerpt = excerpts(await ask(f, 'astral', 'zebrafish'))[1];
  assert.equal(excerpt.length, 299);
  assert.ok(excerpt.endsWith('…'));
  assert.doesNotMatch(excerpt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test('BA-32b: nine results still give two blocks, the header and six pointers; metrics results is 8', async (t) => {
  const pages = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`p${i + 1}.md`, `# Page ${i + 1}\nzebrafish note ${i + 1}\n`])
  );
  const f = await fixture(t, pages);
  const context = await ask(f, 'nine', 'zebrafish');
  const lines = context.split('\n');
  assert.deepEqual(
    lines.filter((line) => /^Page \d \(p\d\.md#page-\d\)$/u.test(line)),
    ['Page 1 (p1.md#page-1)', 'Page 2 (p2.md#page-2)']
  );
  assert.equal(lines.indexOf(HEADER) > 0, true);
  assert.equal(lines.slice(lines.indexOf(HEADER) + 1).length, 6);
  const metrics = (await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(metrics.at(-1).results, 8);
  assert.deepEqual(JSON.parse(await readFile(stateFile(f, 'nine'), 'utf8')), ['p1.md', 'p2.md']);
});

test('BA-32b: full mode keeps the pinned multi-result output and matches an absent disclosure', async (t) => {
  const pages = { 'alpha.md': '# Alpha\nzebrafish alpha note.\n', 'beta.md': '# Beta\nzebrafish beta note.\n' };
  const expected = 'Alpha (alpha.md)\n# Alpha\nzebrafish alpha note.\n\nBeta (beta.md)\n# Beta\nzebrafish beta note.';
  const absent = await run(await fixture(t, pages), 'full', 'zebrafish');
  const full = await run(await fixture(t, pages), 'full', 'zebrafish', { hooks: { disclosure: 'full' } });
  assert.equal(text(absent), expected);
  assert.equal(absent.stdout, full.stdout);
  assert.equal(absent.exitCode, full.exitCode);
});
