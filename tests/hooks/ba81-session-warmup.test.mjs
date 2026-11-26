// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { resolvePaths, vaultId } from '../../packages/core/src/paths/index.mjs';
import { SEMANTIC_DEFAULTS, defaultConfig } from '../../packages/core/src/config/index.mjs';
import { buildSemanticIndex, createOllamaProvider, markdownChunks } from '../../modules/semantic/src/index.mjs';
import { buildHookCommand } from '../../packages/hooks/src/index.mjs';

const ROOT = resolve('.');
const BIN = join(ROOT, 'packages/hooks/bin/brainatlas-hook.mjs');
const CLI = join(ROOT, 'packages/cli/bin/brainatlas.mjs');
const MODEL = 'ba81-test-model';
const DIMS = 2;

function startServer(t, { hang = false, hangPrompt = false, delayMs = 0 } = {}) {
  const requests = [];
  const finished = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const warmup = Array.isArray(parsed.input) && parsed.input.length === 1 && parsed.input[0] === 'warm-up';
      requests.push({ url: request.url, body: parsed, warmup, at: Date.now() });
      const done = new Promise((complete) => response.on('finish', complete));
      finished.push(done);
      if (hang || (hangPrompt && !warmup)) return;
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ embeddings: (parsed.input ?? []).map(() => [1, 0]) }));
      }, delayMs);
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        server.closeAllConnections?.();
        server.close();
      });
      done({ requests, finished, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const fakeFetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
};

async function fixture(t, { baseUrl, enabled = true, profile = 'custom', modules = ['semantic'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ba81-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  const wiki = join(vault, 'wiki');
  const home = join(root, 'home');
  await Promise.all([mkdir(wiki, { recursive: true }), mkdir(home)]);
  await writeFile(join(wiki, 'fish.md'), '# Fish\n\nzebrafish husbandry notes for the aquarium.\n');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  const paths = resolvePaths({ env });
  const config = defaultConfig(profile);
  config.vault.path = vault;
  config.modules = modules;
  config.hooks = { mode: 'normal', deadlineMs: 4700 };
  config.retrieval.abstainThreshold = 0;
  config.semantic = {
    ...SEMANTIC_DEFAULTS,
    enabled,
    baseUrl,
    model: MODEL,
    dims: DIMS,
  };
  config.stateDir = join(paths.stateDir, vaultId(vault));
  await mkdir(dirname(paths.configFile), { recursive: true });
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(paths.configFile, JSON.stringify({ ...config, stateDir: undefined }));
  return { root, vault, wiki, env, paths, config, stateDir: config.stateDir };
}

function runChild(bin, args, f, stdin, extraEnv = {}) {
  const started = Date.now();
  const env = Object.fromEntries(Object.entries({ ...f.env, ...extraEnv }).filter(([, value]) => value !== undefined));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    let stdoutAt = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!stdoutAt) stdoutAt = Date.now();
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr, started, stdoutAt, ended: Date.now() }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

const hookChild = (f, client, event, stdin, extraEnv) => runChild(BIN, [client, event], f, stdin, extraEnv);
const cliChild = (f, client, event, stdin, extraEnv) => runChild(CLI, ['hook', client, event], f, stdin, extraEnv);

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

test('session-start sends exactly one warm-up after stdout and waits for an 800 ms answer', async (t) => {
  const server = await startServer(t, { delayMs: 800 });
  const f = await fixture(t, { baseUrl: server.baseUrl });
  await writeFile(join(f.stateDir, 'handoff.md'), 'continuity');
  const result = await hookChild(f, 'claude', 'session-start', { session_id: 'warm' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /continuity/);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, '/api/embed');
  assert.deepEqual(server.requests[0].body, { model: MODEL, input: ['warm-up'], keep_alive: '30m' });
  await server.finished[0];
  assert.ok(result.ended - result.stdoutAt >= 700, 'the client waited for the slow answer');
  assert.ok(result.ended - result.stdoutAt <= 2500, 'the extra wait stays within the 2000 ms cap plus margin');
  const stamp = JSON.parse(await readFile(join(f.stateDir, 'semantic-warmup.json'), 'utf8')).at;
  assert.ok(Number.isFinite(Date.parse(stamp)));
});

test('the CLI hook path also writes stdout before the same in-process warm-up', async (t) => {
  const server = await startServer(t);
  const f = await fixture(t, { baseUrl: server.baseUrl });
  await writeFile(join(f.stateDir, 'handoff.md'), 'continuity');
  const result = await cliChild(f, 'claude', 'session-start', { session_id: 'cli-warm' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /continuity/);
  assert.equal(server.requests.length, 1, result.stderr);
  assert.deepEqual(server.requests[0].body, { model: MODEL, input: ['warm-up'], keep_alive: '30m' });
});

test('semantic off, Lite, offline and a missing HOME send zero requests', async (t) => {
  const server = await startServer(t);
  const cases = [
    { name: 'disabled', options: { enabled: false }, env: {} },
    { name: 'Lite', options: { profile: 'lite', modules: [] }, env: {} },
    { name: 'offline', options: {}, env: { BRAINATLAS_OFFLINE: '1' } },
    { name: 'no HOME', options: {}, env: { HOME: undefined } },
  ];
  for (const item of cases) {
    const f = await fixture(t, { baseUrl: server.baseUrl, ...item.options });
    server.requests.length = 0;
    const result = await hookChild(f, 'claude', 'session-start', { session_id: `none-${item.name}` }, item.env);
    assert.equal(result.status, 0, item.name);
    await wait(1500);
    assert.equal(server.requests.length, 0, item.name);
  }
});

test('a second session-start within 60 s sends no new request and the card is unchanged', async (t) => {
  const server = await startServer(t);
  const f = await fixture(t, { baseUrl: server.baseUrl });
  await writeFile(join(f.stateDir, 'handoff.md'), 'continuity');
  const one = await hookChild(f, 'claude', 'session-start', { session_id: 'rate' });
  assert.equal(server.requests.length, 1);
  const two = await hookChild(f, 'claude', 'session-start', { session_id: 'rate' });
  await wait(300);
  assert.equal(server.requests.length, 1, 'rate limited');
  assert.equal(two.stdout, one.stdout, 'the warm-up never changes the session-start output');
});

test('a corrupt, missing, invalid or future warm-up stamp is stale and gets overwritten', async (t) => {
  const server = await startServer(t);
  const stale = [
    { name: 'corrupt', content: 'not json' },
    { name: 'missing at', content: JSON.stringify({}) },
    { name: 'invalid at', content: JSON.stringify({ at: 'not-a-date' }) },
    { name: 'numeric at', content: JSON.stringify({ at: 123 }) },
    { name: 'future at', content: JSON.stringify({ at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }) },
  ];
  for (const item of stale) {
    const f = await fixture(t, { baseUrl: server.baseUrl });
    await writeFile(join(f.stateDir, 'handoff.md'), 'continuity');
    await writeFile(join(f.stateDir, 'semantic-warmup.json'), item.content);
    server.requests.length = 0;
    const result = await hookChild(f, 'claude', 'session-start', { session_id: `stale-${item.name}` });
    assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
    assert.equal(server.requests.length, 1, `${item.name}: a stale stamp allows the warm-up`);
    const stamp = JSON.parse(await readFile(join(f.stateDir, 'semantic-warmup.json'), 'utf8')).at;
    assert.ok(Number.isFinite(Date.parse(stamp)), `${item.name}: the stale stamp was overwritten`);
    assert.ok(Date.parse(stamp) <= Date.now(), `${item.name}: the new stamp is not in the future`);
  }
});

test('a prompt whose semantic step hits fallback:deadline sends one warm-up after stdout', async (t) => {
  const server = await startServer(t, { hangPrompt: true });
  const f = await fixture(t, { baseUrl: server.baseUrl });
  await buildSemanticIndex({
    corpusDir: f.wiki,
    stateDir: f.paths.stateDir,
    provider: createOllamaProvider({ ...f.config.semantic, fetchImpl: fakeFetch }),
    chunkMarkdown: markdownChunks,
  });
  const result = await hookChild(f, 'claude', 'prompt', { session_id: 'deadline', prompt: 'zebrafish aquarium' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdoutAt > 0);
  const warmups = server.requests.filter((request) => request.warmup);
  assert.equal(warmups.length, 1, 'one warm-up after fallback:deadline');
  assert.deepEqual(warmups[0].body, { model: MODEL, input: ['warm-up'], keep_alive: '30m' });
  assert.ok(warmups[0].at >= result.stdoutAt, 'the warm-up request follows stdout');
});

test('the prompt hook sends keep_alive on every embedding request', async (t) => {
  const server = await startServer(t);
  const f = await fixture(t, { baseUrl: server.baseUrl });
  await buildSemanticIndex({
    corpusDir: f.wiki,
    stateDir: f.paths.stateDir,
    provider: createOllamaProvider({ ...f.config.semantic, fetchImpl: fakeFetch }),
    chunkMarkdown: markdownChunks,
  });
  const result = await hookChild(f, 'claude', 'prompt', { session_id: 'prompt', prompt: 'zebrafish aquarium' });
  assert.equal(result.status, 0);
  assert.ok(server.requests.length >= 1, 'the prompt hook reached the provider');
  for (const request of server.requests) {
    assert.equal(request.url, '/api/embed');
    assert.equal(request.body.keep_alive, '30m', JSON.stringify(request.body));
  }
});

test('a server that never answers still lets the process exit within the warm-up cap', async (t) => {
  const server = await startServer(t, { hang: true });
  const f = await fixture(t, { baseUrl: server.baseUrl });
  await writeFile(join(f.stateDir, 'handoff.md'), 'continuity');
  const result = await hookChild(f, 'claude', 'session-start', { session_id: 'hang' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdoutAt > 0);
  assert.ok(result.ended - result.started <= 3500, `total ${result.ended - result.started} ms`);
  assert.ok(result.ended - result.stdoutAt <= 3000, `after stdout ${result.ended - result.stdoutAt} ms`);
  assert.equal(server.requests.length, 1);
});

test('buildHookCommand keeps the main permission flags and never allows child processes', () => {
  const f = { vault: '/tmp/ba81-vault', state: '/tmp/ba81-state', release: ROOT };
  const savedHome = process.env.HOME;
  process.env.HOME = '/tmp/ba81-home';
  try {
    const command = buildHookCommand({
      nodePath: process.execPath,
      shimPath: BIN,
      client: 'claude',
      event: 'prompt',
      paths: f,
    });
    if (!command.includes('--permission')) {
      assert.equal(process.allowedNodeEnvironmentFlags.has('--permission'), false);
      assert.ok(!command.includes('--allow-child-process'));
      return;
    }
    assert.equal(command[0], process.execPath);
    assert.equal(command[1], '--permission');
    const flags = command.slice(2, -3);
    const reads = flags.filter((value) => value.startsWith('--allow-fs-read='));
    const writes = flags.filter((value) => value.startsWith('--allow-fs-write='));
    assert.ok(reads.length >= 1);
    assert.ok(writes.length >= 1);
    assert.deepEqual(flags, [...reads, ...writes, '--allow-worker'], 'main permission order is unchanged');
    assert.deepEqual(command.slice(-3), [BIN, 'claude', 'prompt']);
    assert.ok(!command.includes('--allow-child-process'));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

const permissionSupported = (() => {
  const version = process.versions.node.split('.').map(Number);
  return (
    process.allowedNodeEnvironmentFlags.has('--permission') &&
    (version[0] > 22 || (version[0] === 22 && version[1] >= 13))
  );
})();

function spawnBuiltCommand(command, f, stdin, extraEnv = {}) {
  const started = Date.now();
  const env = Object.fromEntries(Object.entries({ ...f.env, ...extraEnv }).filter(([, value]) => value !== undefined));
  return new Promise((done, fail) => {
    const child = spawn(command[0], command.slice(1), { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    let stdoutAt = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!stdoutAt) stdoutAt = Date.now();
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr, started, stdoutAt, ended: Date.now() }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

test('the built hook command warms up under the Node permission sandbox', { skip: !permissionSupported }, async (t) => {
  const server = await startServer(t, { delayMs: 100 });
  const f = await fixture(t, { baseUrl: server.baseUrl });
  await writeFile(join(f.stateDir, 'handoff.md'), 'continuity');
  const command = buildHookCommand({
    nodePath: process.execPath,
    shimPath: BIN,
    client: 'claude',
    event: 'session-start',
    paths: { vault: f.vault, state: f.stateDir, release: ROOT, configFile: f.paths.configFile },
  });
  assert.ok(command.includes('--permission'), 'the sandbox is on for this test');
  assert.ok(!command.includes('--allow-child-process'));
  const result = await spawnBuiltCommand(command, f, { session_id: 'sandbox' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /continuity/);
  assert.equal(server.requests.filter((request) => request.warmup).length, 1, result.stderr);
  const stamp = JSON.parse(await readFile(join(f.stateDir, 'semantic-warmup.json'), 'utf8')).at;
  assert.ok(Number.isFinite(Date.parse(stamp)), 'the rate-limit stamp was written under the sandbox');
});
