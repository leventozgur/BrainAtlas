// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths, saveConfig } from '@brainatlas/core';
import { commands } from '../../../modules/semantic/src/index.mjs';

const setup = commands.semanticSetup;
const makeSecret = () => ['sk', 'test' + 'x'.repeat(24)].join('-');
const bytes = value => new TextEncoder().encode(value);

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'q-setup-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const vault = join(root, 'vault');
  const wiki = join(vault, 'wiki');
  const data = join(home, 'data');
  const configHome = join(home, 'config');
  const stateHome = join(home, 'state');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(wiki, { recursive: true })]);
  const paths = resolvePaths({ platform: 'linux', env: {
    HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome,
  } });
  const config = defaultConfig('custom');
  config.modules = ['semantic'];
  config.vault.path = vault;
  config.retrieval = { budgetChars: 4321, abstainThreshold: 0.73 };
  config.semantic = { ...config.semantic, model: 'fixture-embed:latest', dims: 2 };
  await writeFile(join(wiki, 'evidence.md'), `# Evidence\n${options.pageText ?? 'A local fixture page for deterministic embedding.'}\n`);
  await saveConfig(config, { paths });
  const before = await readFile(paths.configFile, 'utf8');
  const calls = [];
  const execs = [];
  const progress = [];
  const modelInstalled = options.modelInstalled ?? true;
  let embedDocumentsCount = 0;
  let embedQueriesCount = 0;

  const ctx = {
    config,
    paths,
    env: { HOME: home, PATH: `/fixture/bin${delimiter}/missing/bin` },
    platform: 'linux',
    nodeVersion: '20.0.0',
    totalmem: () => 6 * 1024 ** 3,
    statfs: async () => ({ bavail: 1, bsize: 1024 ** 3 }),
    access: async file => {
      if (file === '/fixture/bin/ollama') return;
      throw Object.assign(new Error('not executable'), { code: 'ENOENT' });
    },
    execFile: async (file, args, execOptions) => {
      execs.push({ file, args: [...args], options: execOptions });
      if (options.versionFailure) throw new Error('fixture version failure');
      return { stdout: 'ollama version fixture', stderr: '' };
    },
    progress: message => progress.push(message),
    isTTY: options.isTTY ?? false,
    prompt: async () => { options.promptCalls = (options.promptCalls ?? 0) + 1; return options.promptAnswer ?? true; },
    fetchImpl: async (url, request = {}) => {
      const method = request.method ?? 'GET';
      const call = { url: String(url), method, body: request.body };
      calls.push(call);
      const endpoint = new URL(url).pathname;
      if (options.fetchFailure === 'server' && endpoint === '/api/version') throw new Error('fixture server failure');
      if (endpoint === '/api/version') return { ok: true, json: async () => ({ version: 'fixture' }) };
      if (endpoint === '/api/tags') {
        if (options.malformedTags) return { ok: true, json: async () => ({ models: 'bad' }) };
        return { ok: true, json: async () => ({ models: modelInstalled ? [{ name: config.semantic.model }] : [] }) };
      }
      if (endpoint === '/api/pull') {
        if (options.pullFailure) return { ok: false, status: 500, json: async () => ({}) };
        const stream = async function* () {
          yield bytes('{"status":"pulling manifest","completed":1,"total":2}\n');
          yield bytes('{"status":"success"}\n');
        };
        return { ok: true, body: stream() };
      }
      if (endpoint === '/api/embed') {
        const body = JSON.parse(request.body);
        const query = body.input[0]?.startsWith(config.semantic.queryPrefix);
        if (query) {
          embedQueriesCount++;
          if (options.failProbe) throw new Error(options.errorText ?? 'fixture query failure');
        } else {
          embedDocumentsCount++;
          if (options.failIndex) throw new Error(options.errorText ?? 'fixture index failure');
        }
        return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
      }
      throw new Error('unexpected fixture endpoint');
    },
  };
  const result = { root, home, vault, wiki, paths, config, before, ctx, calls, execs, progress,
    get embedDocumentsCount() { return embedDocumentsCount; }, get embedQueriesCount() { return embedQueriesCount; },
    get promptCalls() { return options.promptCalls ?? 0; } };
  fixtureFetch.set(result, ctx.fetchImpl);
  return result;
}

async function run(f, args = ['--yes']) {
  const commandArgs = args.includes('--json') ? args : [...args, '--json'];
  const result = await setup(commandArgs, f.ctx);
  assert.equal(Number.isInteger(result?.exitCode), true);
  const report = JSON.parse(result.output);
  assert.deepEqual(Object.keys(report.steps), ['preflight', 'ollama', 'server', 'model', 'index', 'probe', 'config']);
  for (const [name, step] of Object.entries(report.steps)) {
    assert.ok(['ok', 'skipped', 'action-needed'].includes(step.status), `${name} has an invalid status`);
    assert.equal(typeof step.reason, 'string');
    assert.ok(step.reason.length > 0);
  }
  return { ...result, report };
}

function assertOnlyLoopbackGet(calls) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), call.url);
    assert.equal(call.method, 'GET', JSON.stringify(call));
    assert.ok(['/api/version', '/api/tags'].includes(url.pathname), url.pathname);
  }
}

test('successful setup enables semantic last, preserves retrieval/config, and is idempotent', async t => {
  const f = await fixture(t);
  const first = await run(f, ['--yes', '--json', '--mode', 'rrf']);
  assert.equal(first.exitCode, 0);
  assert.deepEqual(Object.values(first.report.steps).map(step => step.status), ['ok', 'ok', 'ok', 'skipped', 'ok', 'ok', 'ok']);
  assert.equal(first.report.mode, 'rrf');
  assert.equal(f.embedDocumentsCount, 1);
  assert.equal(f.embedQueriesCount, 1);
  assert.deepEqual(f.execs.map(item => item.args), [['--version']]);
  assert.equal(f.execs[0].options.timeout, 3000);
  assert.ok(f.calls.every(call => new URL(call.url).hostname === '127.0.0.1'));

  const saved = JSON.parse(await readFile(f.paths.configFile, 'utf8'));
  assert.equal(saved.semantic.enabled, true);
  assert.equal(saved.semantic.mode, 'rrf');
  assert.deepEqual(saved.retrieval, { budgetChars: 4321, abstainThreshold: 0.73 });
  const original = JSON.parse(f.before);
  for (const key of Object.keys(original)) {
    if (key === 'semantic') continue;
    assert.deepEqual(saved[key], original[key], `unexpected config change at ${key}`);
  }
  const savedConfigText = await readFile(f.paths.configFile, 'utf8');
  const savedIndexText = await readFile(join(f.paths.stateDir, 'semantic', 'index.json'), 'utf8');

  f.ctx.config = saved;
  const second = await run(f, ['--yes', '--json', '--mode', 'rrf']);
  assert.equal(second.exitCode, 0);
  assert.equal(second.report.steps.model.status, 'skipped');
  assert.equal(second.report.steps.index.status, 'skipped');
  assert.equal(second.report.steps.config.status, 'skipped');
  assert.equal(await readFile(f.paths.configFile, 'utf8'), savedConfigText);
  assert.equal(await readFile(join(f.paths.stateDir, 'semantic', 'index.json'), 'utf8'), savedIndexText);
});

test('dry-run and non-TTY runs make only loopback GETs and leave config and state untouched', async t => {
  for (const args of [[], ['--dry-run'], ['--dry-run', '--yes']]) {
    const f = await fixture(t);
    const result = await run(f, args);
    assert.equal(result.report.dryRun, true);
    assertOnlyLoopbackGet(f.calls);
    assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before);
    await assert.rejects(readFile(join(f.paths.stateDir, 'semantic', 'index.json')));
    assert.deepEqual(f.execs.map(item => item.args), [['--version']]);
  assert.equal(f.promptCalls, 0);
  }

  const missing = await fixture(t, { modelInstalled: false });
  const plannedDownload = await run(missing, []);
  assert.equal(plannedDownload.exitCode, 2);
  assert.equal(plannedDownload.report.steps.model.status, 'action-needed');
  assertOnlyLoopbackGet(missing.calls);
  assert.equal(await readFile(missing.paths.configFile, 'utf8'), missing.before);
  await assert.rejects(readFile(join(missing.paths.stateDir, 'semantic', 'index.json')));
});

test('interactive decline and missing wiki are safe and actionable', async t => {
  const declined = await fixture(t, { isTTY: true, promptAnswer: false });
  const answer = await setup(['--json'], declined.ctx);
  const declineReport = JSON.parse(answer.output);
  assert.equal(answer.exitCode, 2);
  assert.equal(declineReport.steps.index.status, 'action-needed');
  assert.match(declineReport.next, /semanticSetup --yes/u);
  assert.equal(declined.promptCalls, 1);
  assertOnlyLoopbackGet(declined.calls);
  assert.equal(await readFile(declined.paths.configFile, 'utf8'), declined.before);
  await assert.rejects(readFile(join(declined.paths.stateDir, 'semantic', 'index.json')));

  const missing = await fixture(t);
  missing.ctx.config.vault.path = join(missing.root, 'absent-vault');
  const absent = await run(missing, ['--dry-run']);
  assert.equal(absent.exitCode, 2);
  assert.equal(absent.report.steps.preflight.status, 'action-needed');
  assert.match(absent.report.next, /wiki directory/u);
  assert.equal(missing.calls.length, 0);
  assert.equal(await readFile(missing.paths.configFile, 'utf8'), missing.before);
});

test('missing Ollama, stopped server, failed model pull, index failure, and probe failure preserve config and give a next step', async t => {
  const cases = [
    { name: 'ollama', next: /ollama\.com\/download/u, configure: f => { f.ctx.access = async () => { throw new Error('absent'); }; } },
    { name: 'server', next: /ollama serve/u, configure: f => { f.ctx.fetchImpl = async (url, request = {}) => {
      if (String(url).endsWith('/api/version')) throw new Error('offline');
      return fFetch(f, url, request);
    }; } },
    { name: 'model', next: /server|disk|semanticSetup/u, configure: f => { f.ctx.fetchImpl = async (url, request = {}) => {
      if (String(url).endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      if (String(url).endsWith('/api/pull')) return { ok: false, status: 500 };
      return fFetch(f, url, request);
    }; } },
    { name: 'index', next: /vault|model|state|semanticSetup/u, configure: f => { f.ctx.fetchImpl = failingFetch(f, { failIndex: true }); } },
    { name: 'probe', next: /vault|model|semanticSetup/u, configure: f => { f.ctx.fetchImpl = failingFetch(f, { failProbe: true }); } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const f = await fixture(t);
      scenario.configure(f);
      const result = await run(f);
      assert.equal(result.exitCode, 2);
      assert.equal(result.report.steps[scenario.name].status, 'action-needed');
      assert.match(result.report.next, scenario.next);
      assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before);
      assert.ok(f.execs.every(item => JSON.stringify(item.args) === '["--version"]'));
    });
  }
});

function fFetch(f, url, request) {
  // Reuse the fixture implementation without recursively recording a second wrapper.
  return fixtureFetch.get(f)(url, request);
}

const fixtureFetch = new WeakMap();
function failingFetch(f, failure) {
  const original = f.ctx.fetchImpl;
  fixtureFetch.set(f, original);
  return async (url, request = {}) => {
    if (failure.failIndex && String(url).endsWith('/api/embed') && !JSON.parse(request.body).input[0]?.startsWith(f.config.semantic.queryPrefix)) {
      f.ctx.fetchImpl = original;
      const body = JSON.parse(request.body);
      f.calls.push({ url: String(url), method: request.method, body: request.body });
      return { ok: false, status: 500 };
    }
    if (failure.failProbe && String(url).endsWith('/api/embed') && JSON.parse(request.body).input[0]?.startsWith(f.config.semantic.queryPrefix)) {
      f.calls.push({ url: String(url), method: request.method, body: request.body });
      return { ok: false, status: 500 };
    }
    return original(url, request);
  };
}

test('missing model can be pulled only after --yes, then completes with the configured model', async t => {
  const f = await fixture(t, { modelInstalled: false });
  const result = await setup(['--yes'], f.ctx);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /model: ok/u);
  const pull = f.calls.find(call => call.url.endsWith('/api/pull'));
  assert.ok(pull);
  assert.equal(pull.method, 'POST');
  assert.deepEqual(JSON.parse(pull.body), { model: f.config.semantic.model, stream: true });
  assert.ok(f.progress.some(message => message.includes('240 MB')));
  assert.equal(JSON.parse(await readFile(f.paths.configFile, 'utf8')).semantic.enabled, true);
});

test('remote and credential URLs fail before any request and do not echo credentials', async t => {
  const secret = makeSecret();
  for (const baseUrl of ['https://remote.invalid', `http://${secret}@127.0.0.1:11434`]) {
    const f = await fixture(t);
    f.ctx.config.semantic.baseUrl = baseUrl;
    await assert.rejects(setup(['--yes', '--json'], f.ctx), error => {
      assert.equal(error.code, 'E_SEMANTIC_PROVIDER');
      assert.ok(!String(error.message + error.stack).includes(secret));
      assert.ok(!String(error.message + error.stack).includes(baseUrl));
      return true;
    });
    assert.equal(f.calls.length, 0);
    assert.equal(await readFile(f.paths.configFile, 'utf8'), f.before);
  }
});

test('bad arguments and malformed tags do not change config or proceed to indexing', async t => {
  const invalid = await fixture(t);
  await assert.rejects(setup(['--mode', 'other'], invalid.ctx), { code: 'E_ARGUMENT' });
  assert.equal(invalid.calls.length, 0);
  assert.equal(await readFile(invalid.paths.configFile, 'utf8'), invalid.before);

  const malformed = await fixture(t, { malformedTags: true });
  const result = await run(malformed);
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.steps.model.status, 'action-needed');
  assert.match(result.report.next, /semanticSetup/u);
  assert.equal(malformed.calls.filter(call => call.url.endsWith('/api/pull')).length, 0);
  assert.equal(await readFile(malformed.paths.configFile, 'utf8'), malformed.before);
});

test('setup output does not expose page text or provider errors; corpus symlinks and state symlinks stay contained', async t => {
  const secret = makeSecret();
  const outsideSecret = `${makeSecret()}-outside`;
  const f = await fixture(t, { pageText: `Local note ${secret}`, failProbe: true, errorText: secret });
  const outside = join(f.root, 'outside.md');
  const outsideDir = join(f.root, 'outside-state');
  await writeFile(outside, `# Outside\n${outsideSecret}`);
  await symlink(outside, join(f.wiki, 'linked.md'));
  const result = await run(f);
  assert.equal(result.exitCode, 2);
  assert.ok(!`${result.output}${JSON.stringify(result.report)}${f.progress.join('\n')}`.includes(secret));
  assert.ok(f.calls.every(call => new URL(call.url).hostname === '127.0.0.1'));
  assert.ok(f.calls.filter(call => call.url.endsWith('/api/embed')).every(call => JSON.parse(call.body).input.every(text => !text.includes(outsideSecret))));

  const g = await fixture(t);
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, 'marker'), 'unchanged');
  await mkdir(g.paths.stateDir, { recursive: true });
  await symlink(outsideDir, join(g.paths.stateDir, 'semantic'));
  const symlinkResult = await run(g);
  assert.equal(symlinkResult.exitCode, 2);
  assert.equal(symlinkResult.report.steps.index.status, 'action-needed');
  assert.deepEqual(await readdir(outsideDir), ['marker']);
  assert.equal(await readFile(join(outsideDir, 'marker'), 'utf8'), 'unchanged');
  assert.equal(await readFile(g.paths.configFile, 'utf8'), g.before);
});

test('vault path traversal cannot redirect semantic state writes outside the injected HOME', async t => {
  const f = await fixture(t);
  f.ctx.config.vault.path = '../vault';
  const result = await run(f);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await readdir(f.vault), ['wiki']);
  assert.deepEqual(await readdir(f.wiki), ['evidence.md']);
  assert.ok((await readFile(join(f.paths.stateDir, 'semantic', 'index.json'), 'utf8')).includes('fixture page'));
  assert.equal(JSON.parse(await readFile(f.paths.configFile, 'utf8')).semantic.enabled, true);
});

test('runtime and resource preflight boundaries are explicit', async t => {
  const boundary = await fixture(t);
  boundary.ctx.nodeVersion = '20.0.0';
  boundary.ctx.totalmem = () => 6 * 1024 ** 3;
  boundary.ctx.statfs = async () => ({ bavail: 1, bsize: 1024 ** 3 });
  const ready = await run(boundary, ['--dry-run']);
  assert.equal(ready.report.steps.preflight.status, 'ok');
  assert.doesNotMatch(ready.report.steps.preflight.reason, /Less than/u);

  const warning = await fixture(t);
  warning.ctx.nodeVersion = '20.0.0';
  warning.ctx.totalmem = () => 6 * 1024 ** 3 - 1;
  warning.ctx.statfs = async () => ({ bavail: 1, bsize: 1024 ** 3 - 1 });
  const low = await run(warning, ['--dry-run']);
  assert.match(low.report.steps.preflight.reason, /Less than 6 GB RAM/u);
  assert.match(low.report.steps.preflight.reason, /Less than 1 GB free disk space/u);

  const oldNode = await fixture(t);
  oldNode.ctx.nodeVersion = '19.9.9';
  const unsupported = await run(oldNode, ['--dry-run']);
  assert.equal(unsupported.report.steps.preflight.status, 'action-needed');
  assert.match(unsupported.report.next, /Node\.js 20/u);
  assert.equal(oldNode.calls.length, 0);
  assert.equal(await readFile(oldNode.paths.configFile, 'utf8'), oldNode.before);
});

test('source has no shell-installer pattern and docs use the semanticSetup command', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  async function collectSourceFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await collectSourceFiles(file));
      else if (entry.isFile() && /\.(?:mjs|cjs|js|sh)$/u.test(entry.name)) files.push(file);
    }
    return files;
  }
  const sourceFiles = (await Promise.all(['modules', 'packages', 'scripts', 'release'].map(directory => collectSourceFiles(resolve(root, directory))))).flat();
  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /curl\s*\|\s*(?:sh|bash)/iu, file);
    assert.doesNotMatch(source, /\bsudo\b/iu, file);
  }
  const productionFiles = [
    resolve(root, 'modules/semantic/src/setup.mjs'),
    resolve(root, 'modules/semantic/src/index.mjs'),
    resolve(root, 'packages/cli/src/index.mjs'),
    resolve(root, 'docs/user/semantic.md'),
    resolve(root, 'docs/user/install.md'),
    resolve(root, 'docs/user/troubleshooting.md'),
  ];
  for (const file of productionFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /curl\s*\|\s*(?:sh|bash)/iu, file);
    assert.doesNotMatch(source, /\bsudo\b/iu, file);
  }
  const setupSource = await readFile(productionFiles[0], 'utf8');
  assert.match(setupSource, /\[['"]--version['"]\]/u);
  assert.doesNotMatch(setupSource, /(?:spawn|execSync|spawnSync)\s*\(/u);

  const semanticDocs = await readFile(resolve(root, 'docs/user/semantic.md'), 'utf8');
  const installDocs = await readFile(resolve(root, 'docs/user/install.md'), 'utf8');
  const troubleshooting = await readFile(resolve(root, 'docs/user/troubleshooting.md'), 'utf8');
  assert.match(semanticDocs, /brainatlas semanticSetup\b/u);
  assert.match(semanticDocs, /brainatlas semanticSetup --dry-run\b/u);
  assert.match(semanticDocs, /brainatlas semanticSetup --yes\b/u);
  assert.match(semanticDocs, /brainatlas semanticSetup --mode rrf\b/u);
  assert.match(semanticDocs, /brainatlas config set semantic\.enabled false/u);
  assert.match(installDocs, /brainatlas-<v>-distribution\.tar\.gz/u);
  assert.match(installDocs, /empty directory|boş dizin/iu);
  for (const command of ['semanticSetup', 'semanticIndex', 'semanticStatus']) assert.ok(Object.hasOwn(commands, command), `${command} must be an exported module command`);
  assert.match(troubleshooting, /brainatlas semanticIndex\b/u);
  assert.match(troubleshooting, /brainatlas semanticStatus\b/u);
  const documentedSemanticCommands = [...`${semanticDocs}\n${troubleshooting}`.matchAll(/\bbrainatlas\s+(semantic[A-Z][A-Za-z]+)\b/gu)].map(match => match[1]);
  assert.ok(documentedSemanticCommands.length > 0);
  assert.ok(documentedSemanticCommands.every(command => Object.hasOwn(commands, command)));
});
