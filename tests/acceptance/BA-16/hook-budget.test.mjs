// SPDX-License-Identifier: MIT
// BA-16 blind acceptance (independent tester). Black-box: drives runHook only.
// BA16_HOOK_MODULE selects the hook module under test (default: this worktree).
// BA16_MAIN_HOOK_MODULE (optional) enables main-comparison tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOK = process.env.BA16_HOOK_MODULE || fileURLToPath(new URL('../../../packages/hooks/src/index.mjs', import.meta.url));
const MAIN = process.env.BA16_MAIN_HOOK_MODULE || '';
const { runHook } = await import(pathToFileURL(HOOK).href);
const mainHook = MAIN ? await import(pathToFileURL(MAIN).href) : null;
const NOW = new Date('2026-11-10T00:00:00Z');
// Synthetic Anthropic-style key, assembled at run time so the whole value never appears in source.
const TAIL = 'Zx9Qw3rT7yU1iO5pA2sD8fGh';
const SECRET = ['sk', 'ant'].join('-') + '-' + TAIL;
const ALL_BUDGETS = [...Array.from({ length: 200 }, (_, i) => i + 1), 300, 1000, 1400, 1500, 4002];

async function fixture(t, pages) {
  const root = await mkdtemp(join(tmpdir(), 'ba16-acc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), vault = join(root, 'vault'), state = join(root, 'state');
  await mkdir(home); await mkdir(vault); await mkdir(state);
  for (const [name, body] of Object.entries(pages)) await writeFile(join(vault, name), body);
  return { root, home, vault, state, env: { HOME: home } };
}
// Pages: {title, path, body} for the audit; body text is what the page's snippet must come from.
const page = (title, path, body) => ({ title, path, body, header: `${title} (${path})` });
const files = list => Object.fromEntries(list.map(p => [p.path, p.body]));

function contextOf(stdout, client) {
  if (client === 'kiro') return stdout;
  if (!stdout || stdout === '{}') return '';
  return JSON.parse(stdout).hookSpecificOutput.additionalContext;
}
async function ask(f, prompt, { budget, session = 's', client = 'claude', mode = 'normal', hook = runHook, event = 'prompt', now = NOW } = {}) {
  const retrieval = { abstainThreshold: 0 };
  if (budget !== undefined) retrieval.budgetChars = budget;
  const config = { vault: { path: f.vault }, stateDir: f.state, hooks: { mode, deadlineMs: 4700 }, retrieval };
  const res = await hook({ client, event, stdin: JSON.stringify({ session_id: session, prompt }), env: f.env, config, now });
  return { stdout: res.stdout, exitCode: res.exitCode, context: contextOf(res.stdout, client) };
}

// Audit a context: every line with "(" must be a complete "Title (path)" header of a known page; no header
// prefix may stand alone; each block must carry a non-empty excerpt. Returns the complete blocks found.
function audit(context, pages) {
  const byHeader = new Map(pages.map(p => [p.header, p]));
  const problems = [], blocks = [];
  let current = null;
  if (!context) return { blocks, problems };
  for (const line of context.split('\n')) {
    if (byHeader.has(line)) {
      current = { page: byHeader.get(line), lines: [] };
      blocks.push(current);
      continue;
    }
    if (line.includes('(')) { problems.push(`partial or unknown header line: ${JSON.stringify(line)}`); continue; }
    const t = line.trim();
    if (t.length >= 2 && pages.some(p => p.header.startsWith(t))) { problems.push(`header prefix without path: ${JSON.stringify(line)}`); continue; }
    if (!current) { if (t) problems.push(`text before first header: ${JSON.stringify(line)}`); continue; }
    current.lines.push(line);
  }
  const seen = new Set();
  for (const b of blocks) {
    if (seen.has(b.page.path)) problems.push(`duplicate block for ${b.page.path}`);
    seen.add(b.page.path);
    if (!b.lines.join('\n').trim()) problems.push(`title-only block: ${b.page.header}`);
  }
  return { blocks, problems };
}
const pathsOf = blocks => blocks.map(b => b.page.path);

const SMALL = [
  page('Alpha', 'alpha.md', '# Alpha\nzebrafish alpha note text.'),
  page('Beta', 'beta.md', '# Beta\nzebrafish ' + 'beta words '.repeat(30)),
  page('Gamma', 'gamma.md', '# Gamma\nzebrafish ' + 'gamma filler '.repeat(300)),
  page('Delta', 'delta.md', '# Delta\nzebrafish ' + 'delta words '.repeat(120)),
  page('Epsilon', 'eps.md', '# Epsilon\n## Part one\nzebrafish eps part one text\n## Part two\n' + 'eps tail '.repeat(40)),
];

test('F1 regression: a small budget never leaves a partial "Title (path)" header', async t => {
  const f = await fixture(t, files(SMALL.slice(0, 2)));
  const r = await ask(f, 'zebrafish', { budget: 96, session: 'f1-96' });
  const a = audit(r.context, SMALL.slice(0, 2));
  assert.deepEqual(a.problems, [], `output: ${r.stdout}`);
  assert.ok(r.stdout.length <= 96 || r.stdout === '{}', `length ${r.stdout.length}`);
});

test('property: budgets 1..200 and 300, 1000, 1400, 1500, 4002 stay within limits and never show a partial block', async t => {
  const f = await fixture(t, files(SMALL));
  let injectingBudgets = 0;
  for (const b of ALL_BUDGETS) {
    for (const client of ['claude', 'codex']) {
      const r = await ask(f, 'zebrafish', { budget: b, client, session: `p-${client}-${b}` });
      const limit = Math.min(b, client === 'codex' ? 1400 : 4002);
      if (r.context) {
        injectingBudgets++;
        assert.ok(r.stdout.length <= limit, `${client} budget ${b}: stdout ${r.stdout.length} > ${limit}`);
        const a = audit(r.context, SMALL);
        assert.deepEqual(a.problems, [], `${client} budget ${b}: ${r.stdout}`);
      } else assert.equal(r.stdout, '{}', `${client} budget ${b}`);
    }
    const e = await ask(f, 'what is zebrafish?', { budget: b, mode: 'economic', session: `pe-${b}` });
    if (e.context) {
      assert.ok(e.stdout.length <= Math.min(b, 1500), `economic budget ${b}: ${e.stdout.length}`);
      assert.deepEqual(audit(e.context, SMALL).problems, [], `economic budget ${b}`);
    }
  }
  assert.ok(injectingBudgets > 100, `expected many injecting budgets, got ${injectingBudgets}`);
});

test('limits: budgetChars above 4002 is capped at 4002; economic 1500 and codex 1400 caps hold', async t => {
  const f = await fixture(t, files(SMALL));
  const big = await ask(f, 'zebrafish', { budget: 10000, session: 'lim-big' });
  assert.ok(big.context && big.stdout.length <= 4002, `big ${big.stdout.length}`);
  assert.deepEqual(audit(big.context, SMALL).problems, []);
  const codex = await ask(f, 'zebrafish', { client: 'codex', session: 'lim-codex' });
  assert.ok(codex.stdout.length <= 1400, `codex ${codex.stdout.length}`);
  const econ = await ask(f, 'what is zebrafish?', { mode: 'economic', session: 'lim-econ' });
  assert.ok(econ.stdout.length <= 1500 && econ.context, `economic ${econ.stdout.length}`);
  const kiro = await ask(f, 'zebrafish', { client: 'kiro', budget: 300, session: 'lim-kiro' });
  assert.ok(kiro.stdout.length <= 300 && kiro.stdout.length > 0, `kiro ${kiro.stdout.length}`);
  assert.deepEqual(audit(kiro.context, SMALL).problems, []);
});

test('F1b regression: only fully injected pages are marked seen; a later prompt in the session shows the rest', async t => {
  const pages = SMALL.slice(0, 3);
  const f = await fixture(t, files(pages));
  let partialCases = 0;
  for (const b of ALL_BUDGETS.filter(x => x <= 200)) {
    const session = `f1b-${b}`;
    const first = await ask(f, 'zebrafish', { budget: b, session });
    const injected = pathsOf(audit(first.context, pages).blocks);
    const second = await ask(f, 'zebrafish', { session });
    const shown = pathsOf(audit(second.context, pages).blocks);
    const expected = pages.map(p => p.path).filter(p => !injected.includes(p));
    if (injected.length > 0 && injected.length < pages.length) partialCases++;
    assert.deepEqual([...shown].sort(), [...expected].sort(), `budget ${b}: first=${first.stdout} second=${second.stdout}`);
  }
  assert.ok(partialCases > 0, 'sweep never produced a strict subset of injected pages');
});

test('F2 regression: a cumulative retrieval budget must not starve later results into header-only blocks', async t => {
  // Second prompt in one session: already-seen pages still consume the core's cumulative snippet budget, so
  // fresh pages after them used to arrive with empty excerpts (header-only blocks).
  const big = Array.from({ length: 4 }, (_, i) => page(`Big ${i}`, `big${i}.md`, `# Big ${i}\nzebrafish ` + 'word '.repeat(600)));
  const s = await fixture(t, files(big));
  const first = await ask(s, 'zebrafish', { session: 'f2-seq' });
  assert.deepEqual(audit(first.context, big).problems, [], first.stdout);
  const second = await ask(s, 'zebrafish again', { session: 'f2-seq' });
  const a0 = audit(second.context, big);
  assert.deepEqual(a0.problems, [], `second prompt: ${second.stdout}`);
  assert.ok(a0.blocks.length >= 1, 'second prompt injected nothing');
  const six = Array.from({ length: 6 }, (_, i) => page(`Long ${i}`, `long${i}.md`, `# Long ${i}\nzebrafish ` + 'word '.repeat(700)));
  const f = await fixture(t, files(six));
  const r = await ask(f, 'zebrafish', { session: 'f2-long' });
  const a = audit(r.context, six);
  assert.deepEqual(a.problems, [], r.stdout);
  assert.ok(a.blocks.length >= 1);
  const mid = Array.from({ length: 6 }, (_, i) => page(`Mid ${i}`, `mid${i}.md`, `# Mid ${i}\nzebrafish ` + 'mid '.repeat(240)));
  const g = await fixture(t, files(mid));
  const r2 = await ask(g, 'zebrafish', { session: 'f2-mid' });
  const a2 = audit(r2.context, mid);
  assert.deepEqual(a2.problems, [], r2.stdout);
  assert.ok(a2.blocks.length >= 3, `expected several blocks, got ${a2.blocks.length}`);
});

test('secret redaction: a key cut by the excerpt budget never leaks any 8-character fragment', async t => {
  // Ten complete keys shrink under redaction, moving a final key that straddles the 4001-char core excerpt cut
  // (raw start ~3976) into the visible range. Its kept part is shorter than a full key, so it is not matched.
  const f = await fixture(t, { 'ops-notes.md': `# Ops\nzebrafish ${(SECRET + ' ').repeat(10)}${'word '.repeat(728)}${SECRET} rotate weekly. ` + 'tail '.repeat(200) });
  for (const b of [4002, 4000, 3000, 2000, 1000, 500, 200, 120, 60, 30, 10]) {
    const r = await ask(f, 'zebrafish', { budget: b, session: `red-${b}` });
    assert.ok(!r.stdout.includes(SECRET), `full secret at budget ${b}`);
    for (let i = 0; i + 4 <= TAIL.length; i++) assert.ok(!r.stdout.includes(TAIL.slice(i, i + 4)), `key fragment "${TAIL.slice(i, i + 4)}" at budget ${b}: ${r.stdout}`);
  }
  // Secret fully inside the excerpt: must show the placeholder, never the key.
  const g = await fixture(t, { 'ops-notes.md': `# Ops\nzebrafish key ${SECRET} rotate weekly.` });
  const full = await ask(g, 'zebrafish', { session: 'red-full' });
  assert.ok(!full.stdout.includes(TAIL), 'key tail visible');
  assert.match(full.context, /\[REDACTED:anthropic\]/u);
});

test('large sections: 25 pages of 100 KB each still give bounded, well-formed output', async t => {
  const big = Array.from({ length: 25 }, (_, i) => page(`Huge ${i}`, `huge${i}.md`, `# Huge ${i}\nzebrafish ` + 'lorem '.repeat(16000)));
  const f = await fixture(t, files(big));
  const started = Date.now();
  const r = await ask(f, 'zebrafish', { session: 'huge' });
  const elapsed = Date.now() - started;
  assert.ok(r.stdout.length <= 4002, `stdout ${r.stdout.length}`);
  assert.deepEqual(audit(r.context, big).problems, []);
  console.log(`# BA-16 large-section run: ${elapsed} ms, stdout ${r.stdout.length} chars, blocks ${audit(r.context, big).blocks.length}`);
});

test('metrics stay content-free and keep their keys', async t => {
  const f = await fixture(t, { 'zq-title.md': '# Zq Title\nzebrafish zqsecretword ' + 'zq '.repeat(50) });
  await ask(f, 'zebrafish zqpromptword', { session: 'metric' });
  const lines = (await readFile(join(f.state, 'metrics', 'hooks.jsonl'), 'utf8')).trim().split('\n');
  for (const line of lines) {
    assert.doesNotMatch(line, /zq|zebrafish/u);
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['ts', 'client', 'event', 'mode', 'durationMs', 'chars', 'results', 'outcome', 'session'].sort());
  }
});

test('session-start output is independent of prompt packing (handoff card wins, recap unchanged)', async t => {
  const f = await fixture(t, files(SMALL.slice(0, 1)));
  await writeFile(join(f.state, 'handoff.md'), 'continuity card');
  const r = await runHook({ client: 'claude', event: 'session-start', stdin: '{"session_id":"ss"}', env: f.env, config: { vault: { path: f.vault }, stateDir: f.state, hooks: { mode: 'normal' }, retrieval: {} }, now: NOW });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'continuity card');
});

// ---- main comparison (runs only with BA16_MAIN_HOOK_MODULE set) ----
const mainTest = MAIN ? test : test.skip;
mainTest('normal budget: output without truncation is byte-identical to main for claude, codex, gemini, kiro', async t => {
  const f = await fixture(t, files(SMALL.slice(0, 2)));
  for (const client of ['claude', 'codex', 'gemini', 'kiro']) {
    const a = await ask(f, 'zebrafish', { client, session: `cmp-${client}` });
    const b = await ask(f, 'zebrafish', { client, session: `cmp-${client}-main`, hook: mainHook.runHook });
    assert.equal(a.stdout, b.stdout, client);
  }
});
mainTest('normal budget: truncated output differs from main only at the cut point (ellipsis)', async t => {
  const f = await fixture(t, files(SMALL.slice(0, 3)));
  const a = await ask(f, 'zebrafish', { session: 'cut-wt' });
  const b = await ask(f, 'zebrafish', { session: 'cut-main', hook: mainHook.runHook });
  let i = 0;
  while (i < a.stdout.length && a.stdout[i] === b.stdout[i]) i++;
  assert.equal(a.stdout.slice(0, i), b.stdout.slice(0, i));
  assert.ok(i > 3000, `first difference at ${i}`);
  assert.equal(a.stdout[i], '…', `worktree should place the ellipsis at the cut, got ${JSON.stringify(a.stdout.slice(i - 20, i + 10))}`);
  console.log(`# BA-16 truncation tail: worktree ${JSON.stringify(a.stdout.slice(i - 12, i + 1))} main ${JSON.stringify(b.stdout.slice(i - 12, i + 12))}`);
});
mainTest('normal budget: long fixture first blocks match main in header and order', async t => {
  const six = Array.from({ length: 6 }, (_, i) => page(`Long ${i}`, `long${i}.md`, `# Long ${i}\nzebrafish ` + 'word '.repeat(700)));
  const f = await fixture(t, files(six));
  const a = await ask(f, 'zebrafish', { session: 'cl' });
  const b = await ask(f, 'zebrafish', { session: 'cl-main', hook: mainHook.runHook });
  const ha = audit(a.context, six), hb = audit(b.context, six);
  assert.deepEqual(pathsOf(ha.blocks).slice(0, 1), pathsOf(hb.blocks).slice(0, 1));
  console.log(`# BA-16 first-block length: worktree ${ha.blocks[0]?.lines.join('\n').length}, main ${hb.blocks[0]?.lines.join('\n').length}`);
});
