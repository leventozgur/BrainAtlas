// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths, saveConfig } from '@brainatlas/core';
import { startUiServer } from '../../packages/cli/src/ui.mjs';
import { main } from '../../packages/cli/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../..'));

async function fixture(t, { readOnly = false } = {}) {
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
  const panel = await startUiServer({ paths, env });
  t.after(() => panel.close());
  return { paths, env, panel, vault, home };
}

function call(panel, { method = 'GET', path = '/', headers = {}, body, token = panel.token } = {}) {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
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
          resolveCall({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('the panel needs the token, the exact Host and a same-origin Origin', async (t) => {
  const f = await fixture(t);
  assert.equal((await call(f.panel, { token: '' })).status, 401);
  assert.equal((await call(f.panel, { token: 'wrong' })).status, 401);
  assert.equal((await call(f.panel, { headers: { host: 'evil.example:80' } })).status, 403);
  assert.equal((await call(f.panel, { headers: { origin: 'http://evil.example' } })).status, 403);
  const page = await call(f.panel);
  assert.equal(page.status, 200);
  assert.match(page.text, /BrainAtlas/);
  assert.match(f.panel.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
  const byQuery = await call(f.panel, { path: `/?t=${f.panel.token}`, token: '' });
  assert.equal(byQuery.status, 200);
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
  assert.ok(!keys.some((key) => /^(vault|node|stateDir|sync\.options|channels)/.test(key)));
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
  for (const key of ['vault.path', 'node.path', 'channels.codex', 'stateDir', 'nonexistent.key'])
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
  await assert.rejects(fetch(url.replace(/\?t=.*/, '')), /fetch failed/);
  await assert.rejects(main(['ui', '--bogus'], f.env), { code: 'E_ARGUMENT' });
});
