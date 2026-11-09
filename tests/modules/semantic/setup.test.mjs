// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, saveConfig } from '../../../packages/core/src/config/index.mjs';
import { commands } from '../../../modules/semantic/src/index.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-setup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault'); await mkdir(join(vault, 'wiki'), { recursive: true }); await writeFile(join(vault, 'wiki', 'page.md'), '# Topic\nUseful content');
  const config = defaultConfig('full'); config.vault.path = vault; config.semantic.dims = 2; config.retrieval.budgetChars = 4321;
  const paths = { stateDir: join(root, 'state'), configFile: join(root, 'config', 'config.json') }; await saveConfig(config, { paths });
  const calls = []; const execs = [];
  const ctx = { config, paths, env: { HOME: root, PATH: join(root, 'bin') }, isTTY: false, platform: 'linux', totalmem: () => 8 * 1024 ** 3,
    access: async path => { if (!path.endsWith('/ollama')) throw new Error(); },
    execFile: async (...args) => { execs.push(args); }, progress: () => {},
    fetchImpl: async (url, options) => { calls.push([new URL(url).pathname, options.method]);
      if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version: '1' }) };
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: config.semantic.model }] }) };
      if (url.endsWith('/api/pull')) return { ok: true, body: (async function* () { yield Buffer.from('{"status":"success"}\n'); })() };
      if (url.endsWith('/api/embed')) { const body = JSON.parse(options.body); return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) }; }
      throw new Error(); }, ...overrides };
  return { root, config, paths, ctx, calls, execs, before: await readFile(paths.configFile, 'utf8') };
}
const run = async (ctx, args = ['--yes']) => { const result = await commands.semanticSetup([...args, '--json'], ctx); return { ...result, report: JSON.parse(result.output) }; };
test('setup enables last, preserves config and is idempotent', async t => {
  const f = await fixture(t); const first = await run(f.ctx); assert.equal(first.exitCode, 0);
  const cfg = JSON.parse(await readFile(f.paths.configFile)); assert.equal(cfg.semantic.enabled, true); assert.equal(cfg.retrieval.budgetChars, 4321);
  const indexBefore = await readFile(join(f.paths.stateDir, 'semantic', 'index.json'), 'utf8'); f.ctx.config = cfg;
  const second = await run(f.ctx); assert.equal(second.report.steps.index.status, 'skipped'); assert.equal(second.report.steps.config.status, 'skipped');
  assert.equal(await readFile(join(f.paths.stateDir, 'semantic', 'index.json'), 'utf8'), indexBefore);
  assert.ok(f.execs.every(([, args]) => JSON.stringify(args) === '["--version"]'));
});
test('dry and noninteractive runs use only GET and do not write', async t => {
  for (const args of [[], ['--dry-run'], ['--dry-run', '--yes']]) { const f = await fixture(t); const result = await run(f.ctx, args); assert.equal(result.report.dryRun, true); assert.deepEqual(f.calls, [['/api/version', 'GET'], ['/api/tags', 'GET']]); assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before); await assert.rejects(readFile(join(f.paths.stateDir, 'semantic', 'index.json'))); }
});
test('failure paths preserve config and provide next action', async t => {
  for (const failure of ['ollama', 'server', 'model', 'index', 'probe']) {
    const f = await fixture(t); const fetch = f.ctx.fetchImpl; let embeds = 0;
    if (failure === 'ollama') f.ctx.access = async () => { throw new Error(); };
    else f.ctx.fetchImpl = async (url, options) => {
      if (failure === 'server' && url.endsWith('/api/version')) throw new Error();
      if (failure === 'model' && url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      if (failure === 'model' && url.endsWith('/api/pull')) throw new Error();
      if (url.endsWith('/api/embed') && (++embeds === (failure === 'index' ? 1 : failure === 'probe' ? 2 : 999))) throw new Error();
      return fetch(url, options);
    };
    const result = await run(f.ctx); assert.equal(result.exitCode, 2, failure); assert.equal(result.report.steps[failure].status, 'action-needed'); assert.ok(result.report.next); assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before);
  }
});
test('model pull and mode use configured values', async t => {
  const f = await fixture(t); const fetch = f.ctx.fetchImpl; let pull;
  f.ctx.fetchImpl = async (url, options) => { if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }; if (url.endsWith('/api/pull')) pull = JSON.parse(options.body); return fetch(url, options); };
  const result = await run(f.ctx, ['--yes', '--mode', 'rrf']); assert.equal(result.exitCode, 0); assert.equal(pull.model, f.config.semantic.model); assert.equal(JSON.parse(await readFile(f.paths.configFile)).semantic.mode, 'rrf');
});
test('remote and credential URLs are rejected without network', async t => {
  for (const baseUrl of ['https://example.com', 'http://user:pass@127.0.0.1']) { const f = await fixture(t); f.ctx.config.semantic.baseUrl = baseUrl; await assert.rejects(run(f.ctx), { code: 'E_SEMANTIC_PROVIDER' }); assert.equal(f.calls.length, 0); assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before); }
});
test('interactive consent is required and declining changes nothing', async t => {
  const f = await fixture(t, { isTTY: true, prompt: async () => false });
  const result = await run(f.ctx, []); assert.equal(result.exitCode, 2); assert.equal(result.report.steps.index.status, 'action-needed');
  assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before); assert.ok(f.calls.every(([, method]) => method === 'GET'));
});
test('preflight failures and low-resource warnings are safe', async t => {
  const f = await fixture(t, { totalmem: () => 1, statfs: async () => ({ bavail: 1, bsize: 1 }) });
  const result = await run(f.ctx, ['--dry-run']); assert.match(result.report.steps.preflight.reason, /6 GB/); assert.match(result.report.steps.preflight.reason, /1 GB/);
  const g = await fixture(t); await rm(join(g.config.vault.path, 'wiki'), { recursive: true }); const missing = await run(g.ctx);
  assert.equal(missing.report.steps.preflight.status, 'action-needed'); assert.equal(await readFile(g.paths.configFile, 'utf8'), g.before); assert.equal(g.calls.length, 0);
});
test('slow indexing asks once after ETA and retains progress when declined', async t => {
  const f = await fixture(t, { isTTY: true });
  for (let i = 0; i < 4; i++) await writeFile(join(f.config.vault.path, 'wiki', `${i}.md`), `# Page ${i}\nContent ${i}`);
  f.config.semantic.indexBatchSize = 1;
  let clock = 0, prompts = 0; const messages = []; const fetch = f.ctx.fetchImpl;
  f.ctx.now = () => clock; f.ctx.prompt = async () => ++prompts === 1; f.ctx.progress = message => messages.push(message);
  f.ctx.fetchImpl = async (url, options) => { const result = await fetch(url, options); if (url.endsWith('/api/embed')) clock += 2000000; return result; };
  const result = await run(f.ctx, []);
  assert.equal(result.report.steps.index.status, 'action-needed'); assert.equal(prompts, 2);
  assert.match(messages.join(' '), /more than an hour/); assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before);
  const partial = JSON.parse(await readFile(join(f.paths.stateDir, 'semantic', 'index.partial.json'), 'utf8')); assert.equal(Object.keys(partial.vectors).length, 1);
});
test('dry run reports pending chunks without writes', async t => {
  const f = await fixture(t); const result = await run(f.ctx, ['--dry-run']);
  assert.match(result.report.steps.index.reason, /1 chunks; duration depends on hardware/);
  await assert.rejects(readFile(join(f.paths.stateDir, 'semantic', 'index.partial.json')));
});
