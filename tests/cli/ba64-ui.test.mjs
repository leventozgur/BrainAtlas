// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths, saveConfig } from '@brainatlas/core';
import { startUiServer, EDITABLE_KEYS } from '../../packages/cli/src/ui.mjs';
import { main } from '../../packages/cli/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../..'));

async function fixture(t, { readOnly = false, idleMs } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'ba64-ui-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const vault = join(temp, 'vault');
  const env = cleanEnv({
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: temp,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const paths = resolvePaths({ platform: 'linux', env });
  const releaseDir = join(paths.releasesDir, 'ba64-fixture');
  await mkdir(releaseDir, { recursive: true });
  await symlink(join(root, 'packages'), join(releaseDir, 'packages'), 'dir');
  await symlink('releases/ba64-fixture', paths.currentDir, 'dir');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  const config = defaultConfig('custom');
  config.vault.path = vault;
  config.readOnly = readOnly;
  await saveConfig(config, { paths });
  const panel = await startUiServer({ paths, env, idleMs });
  t.after(() => panel.close());
  return { paths, env, panel, vault, home };
}

function call(panel, { method = 'GET', path = '/', headers = {}, body, rawBody, token = panel.token } = {}) {
  return new Promise((resolveCall, reject) => {
    const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: panel.port,
        method,
        path,
        headers: {
          ...(token ? { 'x-brainatlas-token': token } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* HTML */
          }
          resolveCall({ status: res.statusCode, text, json, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function paddedSetting(size) {
  const body = { key: 'hooks.mode', value: 'economic', apply: false, pad: '' };
  body.pad = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(body)));
  const text = JSON.stringify(body);
  assert.equal(Buffer.byteLength(text), size);
  return text;
}

test('the panel needs the token, the exact Host and a same-origin Origin', async (t) => {
  const f = await fixture(t);
  assert.equal((await call(f.panel, { path: '/api/summary', token: '' })).status, 401);
  assert.equal((await call(f.panel, { path: '/api/summary', token: 'wrong' })).status, 401);
  assert.equal((await call(f.panel, { path: '/', token: '' })).status, 200);
  assert.equal((await call(f.panel, { headers: { host: 'evil.example:80' } })).status, 403);
  assert.equal((await call(f.panel, { headers: { origin: 'http://evil.example' } })).status, 403);
  const page = await call(f.panel);
  assert.equal(page.status, 200);
  assert.match(page.text, /BrainAtlas/);
  assert.equal(page.text.includes(f.panel.token), false);
  assert.match(f.panel.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{48}$/);
  assert.equal(f.panel.url.includes('?t='), false);
  const byQuery = await call(f.panel, { path: `/?t=${f.panel.token}`, token: '' });
  assert.equal(byQuery.status, 200);
  const byQueryGet = await call(f.panel, { path: `/api/summary?t=${f.panel.token}`, token: '' });
  assert.equal(byQueryGet.status, 401);
  const byQueryPost = await call(f.panel, {
    method: 'POST',
    path: `/api/setting?t=${f.panel.token}`,
    body: { key: 'hooks.mode', value: 'economic', apply: false },
    token: '',
  });
  assert.equal(byQueryPost.status, 401);
});

test('every response carries frame and content-type protections', async (t) => {
  const f = await fixture(t);
  for (const response of [await call(f.panel), await call(f.panel, { path: '/api/summary' })]) {
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});

test('the body limit accepts 16384 bytes and refuses 16385', async (t) => {
  const f = await fixture(t);
  const accepted = await call(f.panel, { method: 'POST', path: '/api/setting', rawBody: paddedSetting(16384) });
  assert.notEqual(accepted.status, 413);
  assert.equal(accepted.status, 200);
  const refused = await call(f.panel, { method: 'POST', path: '/api/setting', rawBody: paddedSetting(16385) });
  assert.equal(refused.status, 413);
});

test('the server closes after an idle period and refuses new connections', async (t) => {
  const f = await fixture(t, { idleMs: 200 });
  await f.panel.idle;
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: f.panel.port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once('error', reject);
    }),
    /ECONNREFUSED/
  );
});

test('a request resets the idle timer', async (t) => {
  const f = await fixture(t, { idleMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await call(f.panel, { path: '/api/summary' })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await call(f.panel, { path: '/api/summary' })).status, 200);
  await f.panel.idle;
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: f.panel.port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once('error', reject);
    }),
    /ECONNREFUSED/
  );
});

test('a declared oversized body is refused and the connection is closed', async (t) => {
  const f = await fixture(t);
  const result = await new Promise((resolveCall, reject) => {
    let response;
    const req = request(
      {
        host: '127.0.0.1',
        port: f.panel.port,
        method: 'POST',
        path: '/api/setting',
        headers: {
          'x-brainatlas-token': f.panel.token,
          'content-type': 'application/json',
          'content-length': '20000',
        },
      },
      (res) => {
        response = res;
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          const socket = req.socket;
          const done = () => resolveCall({ status: res.statusCode, text, headers: res.headers });
          if (socket.destroyed) done();
          else socket.once('close', done);
        });
      }
    );
    req.on('error', (error) => {
      if (!response) reject(error);
    });
    req.write('{}');
    req.end();
  });
  assert.equal(result.status, 413);
  assert.equal(result.headers.connection, 'close');
});

test('the CLI reports the idle shutdown and returns normally', async (t) => {
  const f = await fixture(t);
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await main(['ui', '--no-open'], f.env, { uiIdleMs: 150 });
  } finally {
    console.log = original;
  }
  assert.equal(lines.at(-1), 'BrainAtlas panel closed after 30 minutes idle.');
});

test('summary, agents and settings are read-only views without paths or secrets', async (t) => {
  const f = await fixture(t);
  const summary = await call(f.panel, { path: '/api/summary' });
  assert.equal(summary.status, 200);
  assert.equal(summary.json.summary.profile, 'custom');
  const agents = await call(f.panel, { path: '/api/agents' });
  assert.equal(agents.status, 200);
  assert.ok(agents.json.agents.length >= 5);
  const settings = await call(f.panel, { path: '/api/settings' });
  const keys = settings.json.settings.map((row) => row.key);
  assert.ok(keys.includes('hooks.mode'));
  assert.ok(
    !keys.some((key) =>
      /^(vault|node|stateDir|sync|channels|safety|readOnly|semantic\.(baseUrl|allowRemote|model))/.test(key)
    )
  );
  assert.ok(keys.every((key) => EDITABLE_KEYS.has(key)));
  for (const response of [summary, agents, settings]) {
    assert.equal(response.text.includes(f.vault), false);
    assert.equal(response.text.includes(f.panel.token), false);
  }
});

test('a setting change shows a plan first and the apply path writes the same file as config set', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.paths.configFile, 'utf8');
  const plan = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'hooks.mode', value: 'economic', apply: false },
  });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.applied, false);
  assert.equal(await readFile(f.paths.configFile, 'utf8'), before, 'a plan writes nothing');
  const applied = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'hooks.mode', value: 'economic', apply: true },
  });
  assert.equal(applied.json.applied, true);
  assert.equal(JSON.parse(await readFile(f.paths.configFile, 'utf8')).hooks.mode, 'economic');
  const invalid = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'hooks.mode', value: 'not-a-mode', apply: true },
  });
  assert.notEqual(invalid.status, 200);
  assert.equal(JSON.parse(await readFile(f.paths.configFile, 'utf8')).hooks.mode, 'economic');
});

test('blocked keys, bad bodies and wrong content types are refused', async (t) => {
  const f = await fixture(t);
  for (const key of [
    'vault.path',
    'node.path',
    'channels.codex',
    'stateDir',
    'nonexistent.key',
    'semantic.baseUrl',
    'semantic.allowRemote',
    'sync.transport',
    'readOnly',
    'safety.secretFilter',
  ])
    assert.equal(
      (await call(f.panel, { method: 'POST', path: '/api/setting', body: { key, value: 'x', apply: true } })).status,
      400,
      key
    );
  const wrongType = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    headers: { 'content-type': 'text/plain' },
    body: { key: 'hooks.mode', value: 'economic' },
  });
  assert.equal(wrongType.status, 415);
  const badAgent = await call(f.panel, { method: 'POST', path: '/api/agent', body: { agent: 'codex', channel: 'x' } });
  assert.equal(badAgent.status, 400);
  assert.equal((await call(f.panel, { path: '/nope' })).status, 404);
});

test('a read-only installation disables every write', async (t) => {
  const f = await fixture(t, { readOnly: true });
  const summary = await call(f.panel, { path: '/api/summary' });
  assert.equal(summary.json.readOnly, true);
  const write = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'hooks.mode', value: 'economic', apply: true },
  });
  assert.equal(write.status, 403);
});

test('brainatlas ui prints the address and the server stops when the command ends', async (t) => {
  const f = await fixture(t);
  let url;
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await main(['ui', '--no-open', '--json'], f.env, {
      uiStop: async (panel) => {
        url = panel.url;
        assert.equal((await call(panel, { path: '/api/summary' })).status, 200);
      },
    });
  } finally {
    console.log = original;
  }
  assert.equal(JSON.parse(lines.join('\n')).url, url);
  await assert.rejects(fetch(url.replace(/#t=.*/, '')), /fetch failed/);
  await assert.rejects(main(['ui', '--bogus'], f.env), { code: 'E_ARGUMENT' });
});
