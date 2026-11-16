// SPDX-License-Identifier: MIT
// BA-32: the opt-in progressive hook format (two full blocks, then up to six pointer lines) and byte identity with
// `full`/absent. Hermetic: temporary vault, state and HOME directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../packages/hooks/src/index.mjs';

const NOW = new Date('2026-11-10T00:00:00Z');
const HEADER = 'More matches (open with wiki_read_page path + anchor):';
const text = (r) => r.stdout === '{}' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
const stateFile = (f, session, client = 'claude') => join(f.state, 'hooks', `${client}-${createHash('sha256').update(session).digest('hex')}.json`);

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba32-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'), state = join(root, 'state'), home = join(root, 'home');
  await Promise.all([mkdir(vault), mkdir(state), mkdir(home)]);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return { env: { HOME: home }, vault, state };
}

async function run(f, session, prompt, { hooks = {}, retrieval = {}, client = 'claude' } = {}) {
  const config = { vault: { path: f.vault }, stateDir: f.state, hooks: { mode: 'normal', deadlineMs: 4700, ...hooks }, retrieval: { abstainThreshold: 0, ...retrieval } };
  const result = await runHook({ client, event: 'prompt', stdin: JSON.stringify({ session_id: session, prompt }), env: f.env, config, now: NOW });
  assert.equal(result.exitCode, 0);
  return result;
}

const ask = async (f, session, prompt, options) => text(await run(f, session, prompt, { hooks: { disclosure: 'progressive' }, ...options }));
const numbered = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i + 1}.md`, `# Page ${i + 1}\nzebrafish note ${i + 1}\n`]));

test('BA-32: progressive keeps the first two results in full, then six pointers; result nine is absent', async t => {
  const f = await fixture(t, numbered(9));
  const context = await ask(f, 'mine', 'zebrafish');
  const lines = context.split('\n');
  const blocks = lines.filter(line => /^Page \d \(p\d\.md#page-\d\)$/u.test(line));
  assert.deepEqual(blocks, ['Page 1 (p1.md#page-1)', 'Page 2 (p2.md#page-2)'], context);
  const headerAt = lines.indexOf(HEADER);
  assert.ok(headerAt > 0, context);
  assert.equal(lines[headerAt - 1], '', 'the header is preceded by an empty line');
  assert.deepEqual(lines.slice(headerAt + 1), [
    '- Page 3 › Page 3 (p3.md#page-3)',
    '- Page 4 › Page 4 (p4.md#page-4)',
    '- Page 5 › Page 5 (p5.md#page-5)',
    '- Page 6 › Page 6 (p6.md#page-6)',
    '- Page 7 › Page 7 (p7.md#page-7)',
    '- Page 8 › Page 8 (p8.md#page-8)',
  ]);
  assert.equal(context.includes('p9.md'), false);
});

test('BA-32: the state file stores full-block paths without the fragment; pointer paths are not marked', async t => {
  const f = await fixture(t, numbered(9));
  await ask(f, 'mine-state', 'zebrafish');
  assert.deepEqual(JSON.parse(await readFile(stateFile(f, 'mine-state'), 'utf8')), ['p1.md', 'p2.md']);
  const metrics = (await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(metrics.at(-1).results, 8, 'two full blocks plus six pointers');
});

test('BA-32: one result gives one full block and no header; three results give two blocks, header and one pointer', async t => {
  const one = await fixture(t, numbered(1));
  const single = await ask(one, 'one', 'zebrafish');
  assert.deepEqual(single.split('\n'), ['Page 1 (p1.md#page-1)', '# Page 1', 'zebrafish note 1']);
  const three = await fixture(t, numbered(3));
  const context = await ask(three, 'three', 'zebrafish');
  assert.deepEqual(context.split('\n').slice(-2), [HEADER, '- Page 3 › Page 3 (p3.md#page-3)']);
  assert.equal(context.split(HEADER).length - 1, 1);
});

test('BA-32b: a 2000-unit snippet in the first full block is not clipped by progressive packing', async t => {
  const f = await fixture(t, { 'long.md': `# Long\nzebrafish ${'a'.repeat(2000)}` });
  const context = await ask(f, 'long', 'zebrafish');
  const excerpt = context.split('\n').slice(1).join('\n');
  assert.equal(excerpt.length, 2017);
  assert.equal(excerpt, `# Long\nzebrafish ${'a'.repeat(2000)}`);
  assert.equal(excerpt.endsWith('…'), false);
});

test('BA-32b: the second full block is clipped to 300 units and the cut never splits a surrogate pair', async t => {
  const f = await fixture(t, {
    'aa.md': `# Strong\n${'zebrafish '.repeat(6)}`,
    'zz-astral.md': `# Astral\nzebrafish ${'a'.repeat(279)}😀${'b'.repeat(100)}`,
  });
  const context = await ask(f, 'astral', 'zebrafish');
  const blocks = context.split('\n\n');
  assert.equal(blocks[0].split('\n').slice(1).join('\n'), ['# Strong', 'zebrafish '.repeat(6).trim()].join('\n'));
  const excerpt = blocks[1].split('\n').slice(1).join('\n');
  assert.equal(excerpt.length, 299);
  assert.ok(excerpt.endsWith('…'));
  assert.doesNotMatch(excerpt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test('BA-32: a pointer without heading/anchor is "Title (path)" and a weak page is marked before the path', async t => {
  const f = await fixture(t, {
    'strong1.md': '# Strong One\nzebrafish zebrafish zebrafish zebrafish\n',
    'strong2.md': '# Strong Two\nzebrafish zebrafish zebrafish zebrafish\n',
    'weak.md': '---\ntitle: Plain\nstatus: proposed\n---\nzebrafish plain note\n',
  });
  const context = await ask(f, 'pointer', 'zebrafish');
  assert.ok(context.split('\n').includes('- Plain [unverified] (weak.md)'), context);
  assert.ok(context.split('\n').includes('Strong One (strong1.md#strong-one)'), context);
});

test('BA-32: a small Codex cap leaves out the pointers that do not fit and never shows a lone header', async t => {
  const long = 'T'.repeat(60);
  const pages = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i + 1}.md`, `---\ntitle: ${long} ${i + 1}\n---\n# ${long} ${i + 1}\nzebrafish ${'y'.repeat(200)}\n`]));
  const f = await fixture(t, pages);
  const context = await ask(f, 'codex', 'zebrafish', { client: 'codex' });
  assert.ok(context.length <= 1400, `length ${context.length}`);
  const lines = context.split('\n');
  const headerAt = lines.indexOf(HEADER);
  assert.ok(headerAt > 0, context);
  const pointers = lines.slice(headerAt + 1).filter(line => line.startsWith('- '));
  assert.ok(pointers.length >= 1 && pointers.length < 6, `pointers: ${pointers.length}`);
  const anchor = (n) => `${long.toLowerCase()}-${n}`;
  const pointer = (n) => `- ${long} ${n} › ${long} ${n} (p${n}.md#${anchor(n)})`;
  assert.deepEqual(pointers, [3, 4, 5, 6, 7, 8].map(pointer).slice(0, pointers.length));
  // The first omitted pointer is the one that no longer fits the cap.
  const overflow = `${context}\n${pointer(3 + pointers.length)}`;
  assert.ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: overflow } }).length > 1400);
});

test('BA-32: a former pointer page can be injected in full later; former full-block pages never return', async t => {
  const f = await fixture(t, numbered(9));
  await ask(f, 'again', 'zebrafish');
  const second = await ask(f, 'again', 'zebrafish');
  assert.equal(second.includes('(p1.md'), false);
  assert.equal(second.includes('(p2.md'), false);
  assert.ok(second.split('\n').includes('Page 3 (p3.md#page-3)'), second);
  assert.deepEqual(JSON.parse(await readFile(stateFile(f, 'again'), 'utf8')), ['p1.md', 'p2.md', 'p3.md', 'p4.md']);
});

test('BA-32: disclosure full and absent produce identical bytes, metrics and state', async t => {
  const pages = {
    'alpha.md': '# Alpha\nzebrafish alpha note.\n',
    'beta.md': '---\nstatus: proposed\n---\n# Beta\nzebrafish beta note.\n',
    'gamma.md': '# Gamma\nzebrafish gamma note.\n',
  };
  const prompts = [['inject', 'zebrafish'], ['abstain', 'nothingmatchesatall'], ['dedup', 'zebrafish']];
  const outputs = [];
  for (const hooks of [{ mode: 'normal', deadlineMs: 4700 }, { mode: 'normal', deadlineMs: 4700, disclosure: 'full' }]) {
    const f = await fixture(t, pages);
    const runs = [];
    for (const [session, prompt] of prompts) {
      const result = await run(f, `${session}-full`, prompt, { hooks });
      const state = await readFile(stateFile(f, `${session}-full`), 'utf8').catch(() => '');
      runs.push({ stdout: result.stdout, exitCode: result.exitCode, state });
    }
    const metrics = (await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8')).trim().split('\n')
      .map(line => { const { ts, durationMs, ...rest } = JSON.parse(line); return rest; });
    outputs.push({ runs, metrics });
  }
  assert.deepEqual(outputs[0].runs, outputs[1].runs);
  assert.deepEqual(outputs[0].metrics, outputs[1].metrics);
});
