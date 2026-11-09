// SPDX-License-Identifier: MIT
// Acceptance (6) semanticSetup progress output and (7) ETA confirmation, dry-run, status partialChunks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { defaultConfig, resolvePaths, saveConfig } from '@brainatlas/core';
import { commands } from '../../../modules/semantic/src/index.mjs';
import { exists, fakeClock, makeSecret, readJson, sectionPage, snapshot, tempRoot } from './helpers.mjs';

const STEP_NAMES = ['preflight', 'ollama', 'server', 'model', 'index', 'probe', 'config'];

/**
 * `durations[i]` is the simulated (fake clock) duration of the i-th /api/embed document request;
 * the last value repeats.
 */
async function fixture(t, { files, sections = 100, durations = [1000], isTTY = false, answers = [true, true], embedError } = {}) {
  const root = await tempRoot(t);
  const home = join(root, 'home'); const vault = join(root, 'vault'); const wiki = join(vault, 'wiki');
  await mkdir(home, { recursive: true }); await mkdir(wiki, { recursive: true });
  const paths = resolvePaths({ platform: 'linux', env: { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') } });
  const config = defaultConfig('custom');
  config.modules = ['semantic']; config.vault.path = vault;
  config.semantic = { ...config.semantic, model: 'fixture-embed:latest', dims: 2 };
  for (const [name, body] of Object.entries(files ?? { 'page.md': sectionPage('Page', sections) })) await writeFile(join(wiki, name), body);
  await saveConfig(config, { paths });
  const clock = fakeClock();
  const state = { embedRequests: [], posts: 0, prompts: [], progress: [], embedCalls: 0 };
  const ctx = {
    config, paths, env: { HOME: home, PATH: `/fixture/bin${delimiter}/missing` }, platform: 'linux', nodeVersion: '20.0.0',
    totalmem: () => 8 * 1024 ** 3, statfs: async () => ({ bavail: 100, bsize: 1024 ** 3 }),
    access: async file => { if (file === '/fixture/bin/ollama') return; throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    execFile: async () => ({ stdout: 'v', stderr: '' }),
    now: clock.now, isTTY,
    prompt: async question => { state.prompts.push(question); const answer = answers[Math.min(state.prompts.length - 1, answers.length - 1)]; return answer; },
    fetchImpl: async (url, request = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/version') return { ok: true, json: async () => ({}) };
      if (pathname === '/api/tags') return { ok: true, json: async () => ({ models: [{ name: config.semantic.model }] }) };
      if (pathname === '/api/embed') {
        const body = JSON.parse(request.body);
        const isQuery = body.input[0]?.startsWith(config.semantic.queryPrefix);
        if (!isQuery) {
          state.embedRequests.push(body.input.length);
          if (embedError) throw new Error(embedError);
          clock.advance(durations[Math.min(state.embedCalls, durations.length - 1)]); state.embedCalls++;
        }
        return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
      }
      state.posts++; throw new Error('unexpected endpoint');
    },
  };
  if (!fixture.noProgress) ctx.progress = message => state.progress.push(message);
  return { root, home, vault, wiki, paths, config, ctx, clock, state,
    configBytes: () => readFile(paths.configFile, 'utf8'),
    partialFile: join(paths.stateDir, 'semantic', 'index.partial.json'),
    indexFile: join(paths.stateDir, 'semantic', 'index.json') };
}
fixture.noProgress = false;
const run = (f, args) => commands.semanticSetup(args, f.ctx);
const runJson = async (f, args) => { const result = await run(f, [...args, '--json']); return { ...result, report: JSON.parse(result.output) }; };
const partialCount = async f => Object.keys((await readJson(f.partialFile).catch(() => ({ vectors: {} }))).vectors).length;

test('non-TTY progress is throttled (<= ~10% steps), prints no per-file lines and leaves the report contract intact', async t => {
  const files = {}; for (let i = 0; i < 60; i++) files[`file-${String(i).padStart(2, '0')}.md`] = `# File ${i}\n\nbody ${i}\n`;
  const f = await fixture(t, { files, durations: [1000] });
  const { exitCode, report } = await runJson(f, ['--yes']);
  assert.equal(exitCode, 0);
  assert.deepEqual(Object.keys(report.steps), STEP_NAMES);
  assert.deepEqual(Object.keys(report).sort(), ['dryRun', 'mode', 'next', 'steps']);
  const lines = f.state.progress;
  assert.ok(lines.length >= 1, 'some progress is reported');
  assert.ok(lines.length <= 12, `at most one line per 10% step, got ${lines.length}`);
  for (const line of lines) {
    assert.doesNotMatch(line, /file-\d\d|\.md/u, 'no file names');
    assert.doesNotMatch(line, /\d+\/\d+ files/u, 'no per-file counter');
  }
});

test('time throttle: in non-TTY mode no more than one line per 30 s of fake time unless a 10% step is crossed', async t => {
  const f = await fixture(t, { sections: 400, durations: [1] });
  await runJson(f, ['--yes']);
  const lines = f.state.progress;
  assert.ok(lines.length <= 11, `got ${lines.length}`);
});

test('text mode output keeps the documented step lines and exit code contract', async t => {
  const f = await fixture(t);
  const result = await run(f, ['--yes']);
  assert.equal(result.exitCode, 0);
  const lines = result.output.split('\n');
  assert.deepEqual(lines.slice(0, 7).map(line => line.split(':')[0]), STEP_NAMES);
  for (const line of lines.slice(0, 7)) assert.match(line, /^(preflight|ollama|server|model|index|probe|config): (ok|skipped|action-needed) — .+/u);
  assert.equal(lines.some(line => /^Index:/u.test(line)), false, 'progress is not part of the command output');
});

test('TTY progress overwrites a single stderr line (\\r), at most once per second, never on stdout, --json stdout is pure JSON', async t => {
  fixture.noProgress = true;
  const f = await fixture(t, { sections: 200, isTTY: true, durations: [1500] });
  fixture.noProgress = false;
  const originalErr = process.stderr.write; const originalOut = process.stdout.write;
  const err = []; const out = [];
  process.stderr.write = (chunk, ...rest) => { err.push(String(chunk)); const callback = rest.find(item => typeof item === 'function'); callback?.(); return true; };
  process.stdout.write = function (chunk, ...rest) { if (/Index:|ETA/u.test(String(chunk))) out.push(String(chunk)); return originalOut.call(process.stdout, chunk, ...rest); };
  let result;
  try { result = await runJson(f, ['--yes']); } finally { process.stderr.write = originalErr; process.stdout.write = originalOut; }
  assert.equal(result.exitCode, 0);
  assert.deepEqual(out, [], 'no progress text on stdout');
  assert.doesNotThrow(() => JSON.parse(result.output));
  const progress = err.filter(chunk => /Index:/u.test(chunk));
  assert.ok(progress.length >= 1);
  assert.ok(progress.every(chunk => chunk.startsWith('\r') && !chunk.slice(1).includes('\n')), 'carriage-return updates, no newline per update');
  const elapsedSeconds = Math.ceil(f.clock.time / 1000) - Math.floor(1_700_000_000_000 / 1000);
  assert.ok(progress.length <= elapsedSeconds + 1, `${progress.length} lines for ${elapsedSeconds} fake seconds`);
  assert.ok(progress.every(chunk => !/files/u.test(chunk)));
});

test('--json: nothing but the report JSON is returned even when progress and ETA notices are emitted', async t => {
  const f = await fixture(t, { durations: [200000, 1], isTTY: false });
  const result = await run(f, ['--yes', '--json']);
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.output);
  assert.equal(result.output, JSON.stringify(parsed));
  assert.ok(f.state.progress.length > 0, 'progress went to the progress/stderr channel');
  for (const line of f.state.progress) assert.equal(result.output.includes(line), false);
});

// ---------- ETA confirmation (7) ----------
test('ETA above 300 s, interactive, no --yes: one confirmation; decline stops with action-needed, config untouched, partial kept', async t => {
  const f = await fixture(t, { isTTY: true, durations: [200000, 1], answers: [true, false] });
  const before = await f.configBytes();
  const { exitCode, report } = await runJson(f, []);
  assert.equal(exitCode, 2);
  assert.equal(report.steps.index.status, 'action-needed');
  assert.equal(report.steps.probe.status, 'skipped');
  assert.equal(report.steps.config.status, 'skipped');
  assert.match(report.next, /brainatlas semanticSetup --yes/u, 'next command is printed');
  assert.equal(f.state.prompts.length, 2, 'one consent prompt plus exactly one ETA prompt');
  assert.equal(await f.configBytes(), before, 'config unchanged');
  assert.equal(await exists(f.indexFile), false);
  assert.equal(await partialCount(f), 32, 'the finished first group is saved');
  assert.equal(await exists(join(f.paths.stateDir, 'semantic', 'index.lock')), false);
  assert.equal(f.state.embedRequests.length, 1, 'nothing embedded after the decline');
  const notice = f.state.progress.find(line => /minutes?/u.test(line));
  assert.ok(notice, 'ETA notice is shown');
  assert.match(notice, /CPU/u);
  assert.match(notice, /\b[78]\b/u, 'approximate duration (425 s ~ 7-8 min)');
  assert.match(notice, /(resume|interrupt)/iu);

  const status = await commands.semanticStatus([], f.ctx);
  assert.equal(status.partialChunks, 32);
});

test('after a declined run, rerunning with --yes continues from the partial, skips the prompt and finishes', async t => {
  const f = await fixture(t, { isTTY: true, durations: [200000, 1], answers: [true, false] });
  await runJson(f, []);
  f.state.prompts.length = 0; f.state.embedRequests.length = 0; f.state.embedCalls = 1; // later requests are fast
  const { exitCode, report } = await runJson(f, ['--yes']);
  assert.equal(exitCode, 0);
  assert.equal(f.state.prompts.length, 0, '--yes never prompts');
  assert.equal(f.state.embedRequests.reduce((a, b) => a + b, 0), 68, 'only the 68 missing chunks are requested');
  assert.equal(report.steps.index.status, 'ok');
  assert.equal(report.steps.config.status, 'ok');
  assert.equal(JSON.parse(await f.configBytes()).semantic.enabled, true);
  assert.equal(await exists(f.partialFile), false);
  assert.equal((await readJson(f.indexFile)).entries.length, 100);
  assert.equal((await commands.semanticStatus([], { ...f.ctx, config: JSON.parse(await f.configBytes()) })).partialChunks, 0);
});

test('ETA notice appears with --yes but without any prompt, and indexing completes', async t => {
  const f = await fixture(t, { isTTY: true, durations: [200000, 1] });
  const { exitCode } = await runJson(f, ['--yes']);
  assert.equal(exitCode, 0);
  assert.equal(f.state.prompts.length, 0);
  assert.ok(f.state.progress.some(line => /CPU/u.test(line)));
});

test('ETA at or below 300 s: no notice, no ETA prompt; just above 300 s: notice and prompt (exact boundary)', async t => {
  // 96 chunks: first group of 32 leaves 64; eta = D / 32 * 64 = 2 * D.
  const below = await fixture(t, { sections: 96, isTTY: true, durations: [100000, 1] });
  assert.equal((await runJson(below, [])).exitCode, 0);
  assert.equal(below.state.prompts.length, 1, 'consent only');
  assert.equal(below.state.progress.some(line => /CPU/u.test(line)), false);

  const exact = await fixture(t, { sections: 96, isTTY: true, durations: [150000, 1] });
  assert.equal((await runJson(exact, [])).exitCode, 0);
  assert.equal(exact.state.prompts.length, 1, 'exactly 300 s does not exceed the threshold');
  assert.equal(exact.state.progress.some(line => /CPU/u.test(line)), false);

  const above = await fixture(t, { sections: 96, isTTY: true, durations: [150100, 1], answers: [true, false] });
  assert.equal((await runJson(above, [])).exitCode, 2);
  assert.equal(above.state.prompts.length, 2);
  assert.equal(above.state.progress.some(line => /CPU/u.test(line)), true);
});

test('the ETA prompt is asked only once per run', async t => {
  const f = await fixture(t, { isTTY: true, durations: [200000, 100000, 100000, 100000], answers: [true, true] });
  assert.equal((await runJson(f, [])).exitCode, 0);
  assert.equal(f.state.prompts.length, 2);
  assert.equal(f.state.progress.filter(line => /CPU/u.test(line)).length, 1, 'single notice');
});

test('ETA above 3600 s adds an extra warning; the run still proceeds with --yes; 425 s does not warn', async t => {
  const long = await fixture(t, { isTTY: true, durations: [2000000, 1] });
  const result = await runJson(long, ['--yes']);
  assert.equal(result.exitCode, 0);
  assert.equal(long.state.prompts.length, 0);
  const hourWarnings = long.state.progress.filter(line => /hour/iu.test(line));
  assert.equal(hourWarnings.length, 1, 'extra >1 h warning once');
  assert.ok(long.state.progress.some(line => /CPU/u.test(line)), 'the generic notice is still printed');

  const medium = await fixture(t, { isTTY: true, durations: [200000, 1] });
  await runJson(medium, ['--yes']);
  assert.equal(medium.state.progress.some(line => /hour/iu.test(line)), false);

  const interactive = await fixture(t, { isTTY: true, durations: [2000000, 1], answers: [true, true] });
  assert.equal((await runJson(interactive, [])).exitCode, 0);
  assert.equal(interactive.state.prompts.length, 2, 'one combined confirmation');
});

test('non-interactive run without --yes never prompts and never embeds (implicit dry-run)', async t => {
  const f = await fixture(t, { isTTY: false, durations: [200000] });
  const { report } = await runJson(f, []);
  assert.equal(report.dryRun, true);
  assert.equal(f.state.prompts.length, 0);
  assert.equal(f.state.embedRequests.length, 0);
});

// ---------- dry-run ----------
test('--dry-run reports the chunks still to embed (partial excluded) and performs no write or embedding', async t => {
  const f = await fixture(t, { isTTY: true, durations: [200000, 1], answers: [true, false] });
  await runJson(f, []);
  assert.equal(await partialCount(f), 32);
  const embedBefore = f.state.embedRequests.length;
  const stateBefore = await snapshot(f.paths.stateDir); const configBefore = await f.configBytes();
  const wikiBefore = await snapshot(f.wiki);
  f.state.prompts.length = 0;
  const { exitCode, report } = await runJson(f, ['--dry-run']);
  assert.equal(exitCode, 0);
  assert.equal(report.dryRun, true);
  assert.equal(report.steps.index.status, 'skipped');
  assert.match(report.steps.index.reason, /\b68\b/u, 'remaining chunks: 100 minus 32 cached');
  assert.match(report.steps.index.reason, /hardware/iu);
  assert.equal(f.state.embedRequests.length, embedBefore, 'no embedding request');
  assert.equal(f.state.prompts.length, 0);
  assert.deepEqual(await snapshot(f.paths.stateDir), stateBefore, 'state directory byte-identical');
  assert.deepEqual(await snapshot(f.wiki), wikiBefore);
  assert.equal(await f.configBytes(), configBefore);
  assert.equal(report.steps.config.status, 'skipped');
});

test('--dry-run on a fresh state counts every chunk and creates nothing', async t => {
  const f = await fixture(t, { sections: 57, isTTY: true });
  const { report } = await runJson(f, ['--dry-run']);
  assert.match(report.steps.index.reason, /\b57\b/u);
  assert.equal(await exists(f.paths.stateDir), false, 'no state directory created by a dry-run');
  assert.equal(f.state.embedRequests.length, 0);
});

// ---------- failure paths and secrets ----------
test('provider failures during setup indexing do not leak error text, secrets or paths and keep the contract', async t => {
  const secret = makeSecret();
  const f = await fixture(t, { isTTY: false, embedError: `provider exploded ${secret}` });
  const result = await run(f, ['--yes', '--json']);
  assert.equal(result.exitCode, 2);
  const everything = [result.output, ...f.state.progress].join('\n');
  assert.equal(everything.includes(secret), false);
  assert.equal(everything.includes(f.home), false);
  const report = JSON.parse(result.output);
  assert.equal(report.steps.index.status, 'action-needed');
  assert.equal(await exists(join(f.paths.stateDir, 'semantic', 'index.lock')), false);
});

test('page text and secrets never reach progress output or the partial file', async t => {
  const secret = makeSecret();
  const files = { 'page.md': `${sectionPage('Page', 100)}\n## Credentials\nthe token is ${secret}\n` };
  const f = await fixture(t, { files, isTTY: true, durations: [200000, 1], answers: [true, false] });
  const result = await run(f, ['--json']);
  assert.equal(result.exitCode, 2);
  const partialText = await readFile(f.partialFile, 'utf8');
  assert.equal(partialText.includes('lorem'), false);
  assert.equal(partialText.includes(secret), false);
  assert.equal([result.output, ...f.state.progress].join('\n').includes('lorem'), false);
});

test('status exposes partialChunks additively and 0 when the partial file is absent or foreign', async t => {
  const f = await fixture(t, { sections: 40 });
  const before = await commands.semanticStatus([], f.ctx);
  assert.deepEqual(Object.keys(before).sort(), ['ageSeconds', 'enabled', 'fingerprintMatches', 'indexed', 'missing', 'model', 'partialChunks', 'stale']);
  assert.equal(before.partialChunks, 0);
  await mkdir(join(f.paths.stateDir, 'semantic'), { recursive: true });
  await writeFile(f.partialFile, JSON.stringify({ version: 1, providerFingerprint: 'someone-else', dims: 2, preprocessVersion: '1', vectors: {} }));
  assert.equal((await commands.semanticStatus([], f.ctx)).partialChunks, 0, 'incompatible fingerprint is not counted');
});

test('setup while another live indexer holds the lock stops with action-needed, embeds nothing and leaves the foreign lock alone', async t => {
  const f = await fixture(t, { sections: 20 });
  await mkdir(join(f.paths.stateDir, 'semantic'), { recursive: true });
  const lockFile = join(f.paths.stateDir, 'semantic', 'index.lock');
  const held = { pid: process.pid, startedAt: f.clock.now() };
  await writeFile(lockFile, JSON.stringify(held));
  const before = await f.configBytes();
  const { exitCode, report } = await runJson(f, ['--yes']);
  assert.equal(exitCode, 2);
  assert.equal(report.steps.index.status, 'action-needed');
  assert.equal(f.state.embedRequests.length, 0);
  assert.deepEqual(await readJson(lockFile), held);
  assert.equal(await f.configBytes(), before);
  assert.equal(await exists(f.indexFile), false);
});
