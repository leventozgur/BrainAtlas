// SPDX-License-Identifier: MIT
// BA-87: typed controls, one-step confirmation, reset, agent install, channel labels, profile-aware semantic switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, resolvePaths, saveConfig } from '@brainatlas/core';
import { startUiServer, EDITABLE_KEYS } from '../../packages/cli/src/ui.mjs';
import { cleanEnv } from './clean-env.mjs';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../..'));
const NOTE = 'Semantic search needs the Full profile and release. See docs/user/semantic.md.';
const OK_REPORT = {
  dryRun: true,
  mode: 'semantic-primary',
  steps: {
    preflight: { status: 'ok', reason: 'Vault and runtime available. Less than 6 GB RAM.' },
    ollama: { status: 'ok', reason: 'Ollama is installed.' },
    config: { status: 'skipped', reason: 'Configuration would be enabled after verification.' },
  },
  next: 'brainatlas semanticSetup --yes',
};

/** A stub semantic module that records every call and returns the report from BA87_SEMANTIC_REPORT. */
function moduleSource() {
  return `// SPDX-License-Identifier: MIT
import { appendFileSync, readFileSync } from 'node:fs';
export async function activate() {}
export const commands = {
  async semanticSetup(_args, ctx) {
    appendFileSync(ctx.env.BA87_SEMANTIC_MARKER, 'called\\n');
    return { exitCode: 0, output: readFileSync(ctx.env.BA87_SEMANTIC_REPORT, 'utf8') };
  },
};
`;
}

async function writeSemanticModule(releaseDir) {
  const dir = join(releaseDir, 'modules', 'semantic');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'module.json'),
    `${JSON.stringify(
      {
        name: 'semantic',
        version: '1.0.0',
        description: 'Semantic fixture',
        requires: [],
        provides: [],
        profiles: ['full'],
        entry: 'src/index.mjs',
      },
      null,
      2
    )}\n`
  );
  await writeFile(join(dir, 'src', 'index.mjs'), moduleSource());
}

async function fixture(
  t,
  { profile = 'custom', readOnly = false, module = true, report = OK_REPORT, detected = [], modules } = {}
) {
  const temp = await mkdtemp(join(tmpdir(), 'ba87-ui-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const vault = join(temp, 'vault');
  await mkdir(home, { recursive: true });
  for (const name of detected) await mkdir(join(home, name), { recursive: true });
  const reportFile = join(temp, 'semantic-report.json');
  await writeFile(reportFile, JSON.stringify(report));
  const marker = join(temp, 'semantic-calls.log');
  const env = cleanEnv({
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: temp,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BA87_SEMANTIC_MARKER: marker,
    BA87_SEMANTIC_REPORT: reportFile,
  });
  const paths = resolvePaths({ platform: 'linux', env });
  const releaseDir = join(paths.releasesDir, 'ba87-fixture');
  await mkdir(releaseDir, { recursive: true });
  await symlink(join(root, 'packages'), join(releaseDir, 'packages'), 'dir');
  await symlink('releases/ba87-fixture', paths.currentDir, 'dir');
  if (module) await writeSemanticModule(releaseDir);
  await mkdir(join(vault, 'wiki'), { recursive: true });
  const config = defaultConfig(profile);
  config.vault.path = vault;
  config.readOnly = readOnly;
  if (modules !== undefined) config.modules = modules;
  else if (module && profile !== 'lite') config.modules = ['semantic'];
  await saveConfig(config, { paths });
  const panel = await startUiServer({ paths, env });
  t.after(() => panel.close());
  return { paths, env, panel, vault, home, marker };
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
          resolveCall({ status: res.statusCode, text, json, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const calls = async (marker) =>
  readFile(marker, 'utf8').then(
    (text) => text.trim().split('\n').filter(Boolean),
    () => []
  );

test('settings rows carry a typed control, default and help for every allowlisted key', async (t) => {
  const f = await fixture(t);
  const result = await call(f.panel, { path: '/api/settings' });
  assert.equal(result.status, 200);
  assert.equal(result.json.notes, undefined);
  const rows = new Map(result.json.settings.map((row) => [row.key, row]));
  assert.deepEqual([...rows.keys()].sort(), [...EDITABLE_KEYS].sort());
  for (const row of rows.values()) assert.match(row.help, /^[A-Z].*\.$/u, `${row.key} help`);
  assert.equal(result.text.includes(f.vault), false);
  assert.deepEqual(rows.get('hooks.mode'), {
    key: 'hooks.mode',
    value: 'normal',
    control: 'select',
    options: ['normal', 'economic', 'manual'],
    default: 'normal',
    help: rows.get('hooks.mode').help,
  });
  assert.equal(rows.get('okf.level').control, 'select');
  assert.deepEqual(rows.get('okf.level').options, ['warn', 'strict']);
  assert.equal(rows.get('okf.level').default, 'warn');
  assert.equal(rows.get('hooks.disclosure').default, 'full');
  assert.equal(rows.get('retrieval.pullLowConfidence').control, 'checkbox');
  assert.equal(rows.get('retrieval.pullLowConfidence').default, true);
  assert.equal(rows.get('retrieval.budgetChars').control, 'number');
  assert.equal(rows.get('retrieval.budgetChars').min, 1);
  assert.equal(rows.get('retrieval.budgetChars').step, 1);
  assert.equal(rows.get('retrieval.budgetChars').default, 4000);
  assert.equal(rows.get('retrieval.abstainThreshold').max, 1);
  assert.equal(rows.get('retrieval.abstainThreshold').step, 0.01);
  assert.equal(rows.get('retrieval.abstainThreshold').default, 0.35);
  assert.equal(rows.get('hooks.deadlineMs').step, 1);
  assert.equal(rows.get('semantic.enabled').control, 'checkbox');
  assert.equal(rows.get('semantic.enabled').default, false);
  assert.equal(rows.get('semantic.minScore').control, 'number');
  assert.equal(rows.get('semantic.minScore').min, -1);
  assert.equal(rows.get('semantic.minScore').max, 1);
  assert.equal(rows.get('semantic.minScore').step, 0.01);
  assert.equal(rows.get('semantic.minScore').default, 0.45);
  assert.equal(result.text.includes(f.home), false);
  assert.equal(result.text.includes(f.panel.token), false);
});

test('wrong type, out-of-range and unknown enum values are refused with a message and no write', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.paths.configFile, 'utf8');
  const cases = [
    { key: 'hooks.mode', value: 3, expect: /normal, economic, manual/u },
    { key: 'hooks.mode', value: 'not-a-mode', expect: /normal, economic, manual/u },
    { key: 'retrieval.abstainThreshold', value: 5, expect: /between 0 and 1/u },
    { key: 'retrieval.budgetChars', value: 1.5, expect: /integer/u },
    { key: 'retrieval.pullLowConfidence', value: 'yes', expect: /true or false/u },
    { key: 'semantic.minScore', value: -2, expect: /-1 and 1/u },
    { key: 'hooks.deadlineMs', value: undefined, expect: /integer/u },
  ];
  for (const item of cases) {
    const response = await call(f.panel, {
      method: 'POST',
      path: '/api/setting',
      body: { key: item.key, value: item.value, apply: true },
    });
    assert.equal(response.status, 400, item.key);
    assert.equal(response.json.error, 'E_CONFIG_INVALID', item.key);
    assert.match(response.json.message, new RegExp(item.key.replaceAll('.', '\\.'), 'u'), item.key);
    assert.match(response.json.message, item.expect, item.key);
    assert.equal(response.text.includes(f.vault), false);
  }
  assert.equal(await readFile(f.paths.configFile, 'utf8'), before);
});

test('the page has no separate plan button, a confirmation dialog and full channel labels', async (t) => {
  const f = await fixture(t);
  const page = await call(f.panel);
  assert.equal(page.status, 200);
  assert.equal(/Plan/u.test(page.text), false);
  assert.match(page.text, /<dialog/u);
  assert.match(page.text, /Confirm/u);
  assert.match(page.text, /Cancel/u);
  assert.match(page.text, /Every change asks for confirmation and shows what it will change\./u);
  assert.equal(page.text.includes('Changes show a plan first; apply is a separate step.'), false);
  assert.match(page.text, /MCP server/u);
  assert.match(page.text, /CLI \+ skill/u);
  assert.match(page.text, /The agent calls BrainAtlas tools over MCP\./u);
  assert.match(page.text, /The agent runs the brainatlas CLI, guided by an installed skill file\./u);
  assert.match(page.text, /Reset/u);
  assert.match(page.text, /describeChange/u);
  assert.match(page.text, /→/u);
  assert.match(page.text, /<details>/u);
  assert.match(page.text, /Raw plan/u);
  assert.match(page.text, /apply\.disabled=/u);
  assert.match(page.text, /read\(row,el\)===baseline/u);
  assert.match(page.text, /sel\.value===g\.channel/u);
  assert.match(page.text, /#change\{white-space:pre-wrap\}/u);
  assert.match(page.text, /result\.changes/u);
  assert.equal(/result\.remove|result\.install/u.test(page.text), false);
});

test('a config without hooks.disclosure still reports an effective default for the row', async (t) => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(f.paths.configFile, 'utf8'));
  assert.equal(Object.hasOwn(config.hooks, 'disclosure'), false);
  const settings = await call(f.panel, { path: '/api/settings' });
  const row = settings.json.settings.find((item) => item.key === 'hooks.disclosure');
  assert.equal(row.value, undefined);
  assert.equal(row.default, 'full');
});

test('an agent install plans first and applies through the same handler as agent add', async (t) => {
  const f = await fixture(t, { detected: ['.kiro'] });
  const agents = await call(f.panel, { path: '/api/agents' });
  const kiro = agents.json.agents.find((item) => item.agent === 'kiro');
  assert.equal(kiro.detected, true);
  assert.equal(kiro.installed, false);
  const before = await readFile(f.paths.configFile, 'utf8');
  const plan = await call(f.panel, { method: 'POST', path: '/api/agent-add', body: { agent: 'kiro', channel: 'cli' } });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.applied, false);
  assert.equal(plan.json.result.action, 'agent-add');
  assert.equal(plan.json.result.channel, 'cli');
  assert.equal(await readFile(f.paths.configFile, 'utf8'), before, 'a plan writes nothing');
  const applied = await call(f.panel, {
    method: 'POST',
    path: '/api/agent-add',
    body: { agent: 'kiro', channel: 'cli', apply: true },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.json.applied, true);
  const config = JSON.parse(await readFile(f.paths.configFile, 'utf8'));
  assert.ok(config.agents.includes('kiro'));
  assert.equal(config.channels.kiro, 'cli');
  const unknown = await call(f.panel, {
    method: 'POST',
    path: '/api/agent-add',
    body: { agent: 'nope', channel: 'cli' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, 'E_ARGUMENT');
  const badChannel = await call(f.panel, {
    method: 'POST',
    path: '/api/agent-add',
    body: { agent: 'codex', channel: 'shell' },
  });
  assert.equal(badChannel.status, 400);
  assert.equal(badChannel.json.error, 'E_ARGUMENT');
});

test('agent-add enforces the token, the content type and the body limit', async (t) => {
  const f = await fixture(t, { detected: ['.kiro'] });
  const payload = { agent: 'kiro', channel: 'cli' };
  const noToken = await call(f.panel, { method: 'POST', path: '/api/agent-add', body: payload, token: '' });
  assert.equal(noToken.status, 401);
  const wrongType = await call(f.panel, {
    method: 'POST',
    path: '/api/agent-add',
    headers: { 'content-type': 'text/plain' },
    body: payload,
  });
  assert.equal(wrongType.status, 415);
  const oversized = await call(f.panel, {
    method: 'POST',
    path: '/api/agent-add',
    body: { ...payload, pad: 'x'.repeat(17 * 1024) },
  });
  assert.equal(oversized.status, 413);
  assert.equal((await call(f.panel, { method: 'POST', path: '/api/agent-add', body: payload })).status, 200);
});

test('a read-only installation refuses the agent install endpoint', async (t) => {
  const f = await fixture(t, { readOnly: true, detected: ['.kiro'] });
  const response = await call(f.panel, {
    method: 'POST',
    path: '/api/agent-add',
    body: { agent: 'kiro', channel: 'cli', apply: true },
  });
  assert.equal(response.status, 403);
});

test('a Lite profile hides semantic rows, shows the note and refuses semantic keys', async (t) => {
  const f = await fixture(t, { profile: 'lite' });
  const settings = await call(f.panel, { path: '/api/settings' });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.json.notes, [NOTE]);
  const keys = settings.json.settings.map((row) => row.key);
  assert.ok(keys.includes('hooks.mode'));
  assert.equal(
    keys.some((key) => key.startsWith('semantic.')),
    false
  );
  for (const value of [true, false]) {
    const refused = await call(f.panel, {
      method: 'POST',
      path: '/api/setting',
      body: { key: 'semantic.enabled', value, apply: true },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'E_CONFIG_KEY');
    assert.equal(refused.json.message, undefined);
  }
  assert.deepEqual(await calls(f.marker), []);
});

test('a Full profile whose module list excludes semantic hides the semantic rows', async (t) => {
  const f = await fixture(t, { profile: 'full', modules: [] });
  const settings = await call(f.panel, { path: '/api/settings' });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.json.notes, [NOTE]);
  assert.equal(
    settings.json.settings.some((row) => row.key.startsWith('semantic.')),
    false
  );
  const refused = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'semantic.enabled', value: true, apply: true },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'E_CONFIG_KEY');
  assert.deepEqual(await calls(f.marker), []);
});

test('enabling semantic search stops on an action-needed step and writes nothing', async (t) => {
  const f = await fixture(t, {
    report: {
      dryRun: true,
      steps: {
        preflight: { status: 'ok', reason: 'Vault and runtime available.' },
        model: { status: 'action-needed', reason: 'Configured model needs a download of approximately 240 MB.' },
      },
      next: 'brainatlas semanticSetup --yes',
    },
  });
  const before = await readFile(f.paths.configFile, 'utf8');
  const response = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'semantic.enabled', value: true, apply: false },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, 'E_SEMANTIC_NOT_READY');
  assert.deepEqual(Object.keys(response.json.steps), ['model']);
  assert.deepEqual(response.json.steps.model.status, 'action-needed');
  assert.match(response.json.next, /brainatlas semanticSetup --yes/u);
  assert.equal(await readFile(f.paths.configFile, 'utf8'), before);
  assert.deepEqual(await calls(f.marker), ['called']);
  const applied = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'semantic.enabled', value: true, apply: true },
  });
  assert.equal(applied.status, 409);
  assert.equal(applied.json.error, 'E_SEMANTIC_NOT_READY');
  assert.equal(await readFile(f.paths.configFile, 'utf8'), before);
});

test('a ready semantic report adds its warnings to the plan and enables on apply', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.paths.configFile, 'utf8');
  const plan = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'semantic.enabled', value: true, apply: false },
  });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.applied, false);
  assert.equal(plan.json.semantic.steps.ollama.status, 'ok');
  assert.ok(plan.json.semantic.warnings.some((warning) => /Less than 6 GB RAM/u.test(warning)));
  assert.ok(plan.json.semantic.warnings.includes('Each prompt waits up to 350 ms for semantic search.'));
  assert.ok(plan.json.semantic.warnings.every((warning) => typeof warning === 'string'));
  assert.equal(await readFile(f.paths.configFile, 'utf8'), before);
  const applied = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'semantic.enabled', value: true, apply: true },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.json.applied, true);
  assert.equal(JSON.parse(await readFile(f.paths.configFile, 'utf8')).semantic.enabled, true);
  assert.equal((await calls(f.marker)).length, 2);
});

test('setting semantic.enabled to false never runs the setup check', async (t) => {
  const f = await fixture(t);
  const response = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'semantic.enabled', value: false, apply: true },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.applied, true);
  assert.deepEqual(await calls(f.marker), []);
});

test('a throwing semantic module yields 409 with an empty steps object', async (t) => {
  const f = await fixture(t);
  await rm(join(f.paths.currentDir, 'modules', 'semantic', 'src', 'index.mjs'));
  const response = await call(f.panel, {
    method: 'POST',
    path: '/api/setting',
    body: { key: 'semantic.enabled', value: true, apply: false },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.error, 'E_SEMANTIC_NOT_READY');
  assert.deepEqual(response.json.steps, {});
  assert.ok(response.json.reason);
});
