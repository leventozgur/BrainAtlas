// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, loadConfig, saveConfig, setConfigValue, SEMANTIC_DEFAULTS, validateConfig } from '../../../packages/core/src/config/index.mjs';
import { resolvePaths } from '../../../packages/core/src/paths/index.mjs';
import { main as cliMain } from '../../../packages/cli/src/index.mjs';
import { buildSemanticIndex, createOllamaProvider, markdownChunks, readSemanticIndex, searchHybrid, updateSemanticIndex } from '../../../modules/semantic/src/index.mjs';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const testRoot = dirname(fileURLToPath(import.meta.url));
const makeSecret = () => ['sk', 'test' + 'x'.repeat(24)].join('-');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'q-semwire-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = join(root, 'vault', 'wiki');
  const stateDir = join(root, 'external-state');
  await mkdir(corpus, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { root, corpus, stateDir, vault: join(root, 'vault') };
}
const doc = (title, body) => '# ' + title + '\n' + body + '\n';
const provider = (fingerprint, calls) => ({
  id: 'fake', dims: 2, fingerprint,
  embedDocuments: async texts => { calls.push([...texts]); return texts.map(() => [1, 0]); },
  embedQuery: async () => [1, 0],
});

test('incremental rebuild embeds only changed chunks, removes deleted files, and rebuilds everything on fingerprint change', async t => {
  const f = await fixture(t), calls = [];
  await writeFile(join(f.corpus, 'a.md'), doc('A', 'first distinct content'));
  await writeFile(join(f.corpus, 'b.md'), doc('B', 'second distinct content'));
  const firstProvider = provider('fingerprint-a', calls);
  const first = await updateSemanticIndex({ corpusDir: f.corpus, stateDir: f.stateDir, provider: firstProvider, chunkMarkdown: markdownChunks });
  assert.equal(calls.flat().length, 2);
  assert.deepEqual(Object.keys(first.fileHashes), ['a.md', 'b.md']);
  assert.equal(await readFile(join(f.stateDir, 'semantic/index.json'), 'utf8').then(() => true), true);
  assert.equal((await stat(join(f.stateDir, 'semantic/index.json'))).mode & 0o777, 0o600);
  assert.ok(relative(f.vault, join(f.stateDir, 'semantic/index.json')).startsWith('..' + sep), 'test index path should be outside the vault');

  calls.length = 0;
  await writeFile(join(f.corpus, 'a.md'), doc('A', 'edited one file only'));
  await rm(join(f.corpus, 'b.md'));
  const incremental = await updateSemanticIndex({ corpusDir: f.corpus, stateDir: f.stateDir, provider: firstProvider, chunkMarkdown: markdownChunks });
  assert.deepEqual(calls, [['edited one file only']]);
  assert.deepEqual(Object.keys(incremental.fileHashes), ['a.md']);
  assert.deepEqual([...new Set(incremental.entries.map(item => item.path))], ['a.md']);

  calls.length = 0;
  await writeFile(join(f.corpus, 'c.md'), doc('C', 'third distinct content'));
  const changedFingerprint = await updateSemanticIndex({ corpusDir: f.corpus, stateDir: f.stateDir, provider: provider('fingerprint-b', calls), chunkMarkdown: markdownChunks });
  assert.deepEqual(calls, [['edited one file only', 'third distinct content']]);
  assert.equal(changedFingerprint.providerFingerprint, 'fingerprint-b');
  assert.deepEqual(Object.keys(changedFingerprint.fileHashes), ['a.md', 'c.md']);
});

test('two concurrent updates share one embedding pass and both resolve successfully', async t => {
  const f = await fixture(t); let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await writeFile(join(f.corpus, 'one.md'), doc('One', 'concurrent content'));
  const fake = { id: 'fake', dims: 2, fingerprint: 'same', embedDocuments: async texts => { calls++; await gate; return texts.map(() => [1, 0]); } };
  const options = { corpusDir: f.corpus, stateDir: f.stateDir, provider: fake, chunkMarkdown: markdownChunks };
  const left = updateSemanticIndex(options), right = updateSemanticIndex(options);
  assert.equal(left, right, 'concurrent callers should share the same in-flight update');
  for (let attempt = 0; calls === 0 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([left, right]);
  assert.deepEqual(a, b);
  assert.equal((await readSemanticIndex(f.stateDir)).entries.length, 1);
});

test('truncated index and abandoned temporary files rebuild safely; symlinked semantic state is rejected', async t => {
  const f = await fixture(t), calls = [];
  await writeFile(join(f.corpus, 'one.md'), doc('One', 'safe recovery content'));
  const dir = join(f.stateDir, 'semantic');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), '{"version":1');
  await writeFile(join(dir, 'index.json.tmp-abandoned'), 'partial private bytes');
  assert.equal(await readSemanticIndex(f.stateDir), null);
  const recovered = await updateSemanticIndex({ corpusDir: f.corpus, stateDir: f.stateDir, provider: provider('recovered', calls), chunkMarkdown: markdownChunks });
  assert.equal(recovered.entries.length, 1);
  assert.equal((await readSemanticIndex(f.stateDir)).providerFingerprint, 'recovered');
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('index.json.tmp-')), ['index.json.tmp-abandoned']);

  const outside = join(f.root, 'outside-state'); await mkdir(outside);
  await rm(dir, { recursive: true, force: true }); await symlink(outside, dir);
  await assert.rejects(updateSemanticIndex({ corpusDir: f.corpus, stateDir: f.stateDir, provider: provider('recovered', []), chunkMarkdown: markdownChunks }), error => error.code === 'E_SEMANTIC_STATE');
  await assert.rejects(readFile(join(outside, 'index.json')), { code: 'ENOENT' });
});

test('corpus symlinks are not embedded and semantic artifacts stay outside the vault tree', async t => {
  const f = await fixture(t), calls = [];
  const marker = makeSecret();
  const outside = join(f.root, 'outside.md');
  await writeFile(outside, doc('Outside', marker));
  await writeFile(join(f.corpus, 'inside.md'), doc('Inside', 'ordinary visible content'));
  await symlink(outside, join(f.corpus, 'linked.md'));
  const before = await readdir(f.vault, { recursive: true });
  const index = await buildSemanticIndex({ corpusDir: f.corpus, stateDir: f.stateDir, provider: provider('private-check', calls), chunkMarkdown: markdownChunks });
  assert.deepEqual(Object.keys(index.fileHashes), ['inside.md']);
  assert.deepEqual(calls, [['ordinary visible content']]);
  assert.ok(!JSON.stringify(index).includes(marker));
  assert.deepEqual(await readdir(f.vault, { recursive: true }), before);
  assert.ok((await stat(join(f.stateDir, 'semantic/index.json'))).isFile());
});

test('hybrid threshold boundaries are inclusive, including minScore zero and one', async () => {
  const pages = [{ path: 'target.md', title: 'Target', aliases: [], keywords: [], headings: [], body: 'nothing lexical', frontmatter: {} }];
  const make = vector => searchHybrid({ query: 'unmatched', pages, entries: [{ path: 'target.md', title: 'Target', headingPath: 'Evidence', text: 'target evidence', vector }], provider: { embedQuery: async () => [1, 0] }, mode: 'semantic-primary', minSemanticScore: 0 });
  // PM correction: a cosine of exactly 0 means unrelated and is never a hit; an inclusive minScore of 0 admits any positive score.
  const atZero = await make([1e-6, 1]);
  assert.ok(atZero.some(item => item.path === 'target.md'), 'a positive score passes a minScore of zero');
  const atOne = await searchHybrid({ query: 'unmatched', pages, entries: [{ path: 'target.md', vector: [1, 0], text: 'target evidence' }], provider: { embedQuery: async () => [1, 0] }, mode: 'semantic-primary', minSemanticScore: 1 });
  assert.ok(atOne.some(item => item.path === 'target.md'), 'a score exactly equal to one should pass an inclusive maximum threshold');
  const justAboveOne = await searchHybrid({ query: 'unmatched', pages, entries: [{ path: 'target.md', vector: [1, 0], text: 'target evidence' }], provider: { embedQuery: async () => [1, 0] }, mode: 'semantic-primary', minSemanticScore: 1 + Number.EPSILON }).catch(() => null);
  assert.equal(justAboveOne, null, 'invalid score thresholds are rejected');
});

test('config keeps v1 compatibility, defaults optional semantic settings, rejects invalid values, and CLI get/set work', async t => {
  const f = await fixture(t);
  const original = defaultConfig('custom');
  delete original.semantic;
  assert.equal(original.schemaVersion, 1);
  assert.equal(validateConfig(original).ok, true);
  const configFile = join(f.root, 'legacy-config.json');
  await writeFile(configFile, JSON.stringify(original));
  const loaded = await loadConfig({ paths: { configFile }, env: { HOME: f.root } });
  assert.equal(loaded.schemaVersion, 1);
  assert.deepEqual(loaded.semantic, SEMANTIC_DEFAULTS);
  assert.equal(validateConfig(loaded).ok, true);
  assert.equal(defaultConfig('full').semantic.enabled, false);
  assert.deepEqual(defaultConfig('lite').modules, []);

  for (const [key, value] of [['dims', 0], ['minScore', 2], ['mode', 'x'], ['timeoutMs', -1], ['enabled', 'yes']]) {
    const cfg = defaultConfig('custom');
    cfg.semantic[key] = value;
    assert.equal(validateConfig(cfg).ok, false, key);
    assert.throws(() => setConfigValue(defaultConfig('custom'), 'semantic.' + key, value), { code: 'E_CONFIG_INVALID' });
  }
  for (const value of [0, 1]) {
    const cfg = setConfigValue(defaultConfig('custom'), 'semantic.minScore', value);
    assert.equal(validateConfig(cfg).ok, true);
  }
  for (const mode of ['semantic-primary', 'rrf']) assert.equal(validateConfig(setConfigValue(defaultConfig('custom'), 'semantic.mode', mode)).ok, true);
  const configSecret = makeSecret();
  const invalidSecretConfig = defaultConfig('custom'); invalidSecretConfig.semantic.enabled = configSecret;
  const privateValidation = validateConfig(invalidSecretConfig);
  assert.equal(privateValidation.ok, false);
  assert.ok(!JSON.stringify(privateValidation).includes(configSecret));
  const nested = structuredClone(defaultConfig('custom'));
  delete nested.semantic;
  await saveConfig(nested, { paths: { configFile } });

  const env = {
    ...process.env,
    HOME: f.root,
    BRAINATLAS_PLATFORM: 'linux',
    XDG_CONFIG_HOME: join(f.root, 'cfg'),
    XDG_DATA_HOME: join(f.root, 'data'),
    XDG_STATE_HOME: join(f.root, 'state'),
  };
  const paths = resolvePaths({ platform: 'linux', env });
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(defaultConfig('custom')));
  const run = (...args) => spawnSync(process.execPath, [join(repo, 'packages/cli/bin/brainatlas.mjs'), ...args], { cwd: repo, env, encoding: 'utf8' });
  const set = run('config', 'set', 'semantic.enabled', 'true', '--json');
  assert.equal(set.status, 0, set.stderr + set.stdout);
  assert.equal(JSON.parse(await readFile(paths.configFile, 'utf8')).semantic.enabled, true);
  const get = run('config', 'get', 'semantic.enabled', '--json');
  assert.equal(get.status, 0, get.stderr + get.stdout);
  assert.equal(JSON.parse(get.stdout), true);
  const score = run('config', 'set', 'semantic.minScore', '1', '--json');
  assert.equal(score.status, 0, score.stderr + score.stdout);
  const saved = JSON.parse(await readFile(paths.configFile, 'utf8'));
  assert.equal(saved.semantic.minScore, 1);
  assert.equal(saved.schemaVersion, 1);
});

test('brainatlas semanticIndex and semanticStatus commands use injected test fetch and report only safe progress', async t => {
  const f = await fixture(t);
  const home = join(f.root, 'cli-home');
  const env = {
    ...process.env, HOME: home, BRAINATLAS_PLATFORM: 'linux',
    XDG_CONFIG_HOME: join(home, 'config-home'), XDG_DATA_HOME: join(home, 'data-home'), XDG_STATE_HOME: join(home, 'state-home'),
  };
  const paths = resolvePaths({ platform: 'linux', env });
  const release = join(paths.releasesDir, '1.0.0');
  const moduleDir = join(release, 'modules', 'semantic');
  await mkdir(moduleDir, { recursive: true });
  await cp(join(repo, 'modules/semantic'), moduleDir, { recursive: true });
  await symlink(join(repo, 'packages'), join(release, 'packages'));
  await mkdir(join(f.root, 'cli-vault/wiki'), { recursive: true });
  await writeFile(join(f.root, 'cli-vault/wiki/cli.md'), doc('CLI', 'private cli document evidence'));
  await symlink('releases/1.0.0', paths.currentDir);
  const cfg = defaultConfig('custom');
  cfg.modules = ['semantic']; cfg.vault.path = join(f.root, 'cli-vault');
  cfg.semantic = { ...SEMANTIC_DEFAULTS, enabled: true, dims: 2 };
  await saveConfig(cfg, { paths });

  const originalFetch = globalThis.fetch, originalLog = console.log;
  const output = [];
  globalThis.fetch = async (_url, options) => ({ ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0]) }) });
  console.log = value => output.push(String(value));
  try {
    await cliMain(['semanticIndex'], env);
    const indexed = JSON.parse(output.pop());
    assert.equal(indexed.indexed, 1);
    await cliMain(['semanticStatus'], env);
    const status = JSON.parse(output.pop());
    assert.equal(status.enabled, true);
    assert.equal(status.model, SEMANTIC_DEFAULTS.model);
    assert.equal(status.indexed, 1);
    assert.equal(status.stale, 0);
    assert.equal(status.missing, 0);
    assert.equal(status.fingerprintMatches, true);
    assert.ok(!JSON.stringify([indexed, status]).includes('private cli document evidence'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('provider endpoint allowlist covers loopback forms and rejects remotes without disclosing URLs', async () => {
  const { validateConfiguredProvider } = await import('../../../modules/semantic/src/provider.mjs');
  for (const baseUrl of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) {
    assert.doesNotThrow(() => validateConfiguredProvider({ baseUrl, allowRemote: false }));
  }
  const remotes = ['http://example.test', 'http://192.0.2.15', 'http://[2001:4860:4860::8888]', 'http://localhost.evil.test', 'http://127.0.0.1@evil.test', 'http://3232235777', 'http://0300.0250.0001.0001'];
  for (const baseUrl of remotes) {
    assert.throws(() => validateConfiguredProvider({ baseUrl, allowRemote: false }), error => error.code === 'E_SEMANTIC_PROVIDER' && !String(error.message + error.stack).includes(baseUrl));
    if (!baseUrl.includes('@')) assert.doesNotThrow(() => validateConfiguredProvider({ baseUrl, allowRemote: true }));
  }
  // PM decision: URLs with embedded credentials are always rejected (secrets must not live in config or logs), even with allowRemote.
  assert.throws(() => validateConfiguredProvider({ baseUrl: 'http://127.0.0.1@evil.test', allowRemote: true }), error => error.code === 'E_SEMANTIC_PROVIDER');
});

async function staticGraph(entry, visited = new Set()) {
  const file = resolve(entry);
  if (visited.has(file)) return visited;
  visited.add(file);
  if (!file.endsWith('.mjs') && !file.endsWith('.js')) return visited;
  const source = await readFile(file, 'utf8');
  const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu)].map(match => match[1]);
  for (const specifier of specifiers) {
    let target;
    if (specifier.startsWith('.')) target = resolve(dirname(file), specifier);
    else if (specifier === '@brainatlas/core') target = join(repo, 'packages/core/src/index.mjs');
    else if (specifier.startsWith('@brainatlas/core/')) target = join(repo, 'packages/core/src', specifier.slice('@brainatlas/core/'.length));
    else continue;
    if (await stat(target).then(() => true, () => false)) await staticGraph(target, visited);
  }
  return visited;
}

test('core, MCP, and hooks static import graphs remain free of semantic module code; Lite excludes it', async () => {
  for (const entry of ['packages/core/src/index.mjs', 'packages/mcp/src/index.mjs', 'packages/hooks/src/index.mjs']) {
    const graph = await staticGraph(join(repo, entry));
    assert.ok([...graph].every(file => !file.split(sep).includes('semantic')), entry);
  }
  const hookFiles = await readdir(join(repo, 'packages/hooks/src'));
  for (const file of hookFiles.filter(file => file.endsWith('.mjs'))) assert.doesNotMatch(await readFile(join(repo, 'packages/hooks/src', file), 'utf8'), /modules[/'"]semantic/u);
  const manifest = JSON.parse(await readFile(join(repo, 'modules/semantic/module.json'), 'utf8'));
  assert.ok(manifest.profiles.includes('full'));
  assert.ok(manifest.profiles.includes('custom'));
  assert.ok(!manifest.profiles.includes('lite'));
  const core = await readFile(join(repo, 'packages/core/src/config/index.mjs'), 'utf8');
  assert.doesNotMatch(core, /from\s+['"][^'"]*modules\/semantic/u);
});

test('semantic docs and contracts describe actual defaults, command names, state location, and fallback fields', async () => {
  const [user, configContract, mcpContract] = await Promise.all([
    readFile(join(repo, 'docs/user/semantic.md'), 'utf8'),
    readFile(join(repo, 'docs/contracts/config.md'), 'utf8'),
    readFile(join(repo, 'docs/contracts/mcp-tools.md'), 'utf8'),
  ]);
  assert.match(configContract, /enabled:false/u);
  assert.match(user, /off by default/u);
  for (const text of [configContract, user]) {
    assert.match(text, /embeddinggemma:300m-qat-q4_0/u);
    assert.match(text, /0\.45/u);
  }
  assert.match(configContract, /dims:768/u);
  assert.match(configContract, /baseUrl:http:\/\/127\.0\.0\.1:11434/u);
  assert.match(configContract, /mode:semantic-primary/u);
  assert.match(configContract, /timeoutMs:5000/u);
  assert.match(configContract, /allowRemote:false/u);
  assert.match(configContract, /queryPrefix/u);
  assert.match(configContract, /documentPrefix/u);
  assert.match(user, /brainatlas semanticIndex/u);
  assert.match(user, /brainatlas semanticStatus/u);
  assert.match(user, /state directory[\s\S]*outside the vault/u);
  assert.match(user, /239 MB[\s\S]*385 MB[\s\S]*5 seconds[\s\S]*16 ms/u);
  assert.match(mcpContract, /semantic:\{used:boolean,fallbackReason\?:string\}/u);
  assert.match(mcpContract, /mode:lexical\|semantic-primary\|rrf/u);
  assert.match(mcpContract, /run in the background/u);
});

