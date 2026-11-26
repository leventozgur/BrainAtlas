// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  defaultConfig,
  secretFilterEnabled,
  setConfigValue,
  validateConfig,
} from '../../../packages/core/src/config/index.mjs';
import { checkpoint } from '../../../packages/core/src/checkpoint/index.mjs';
import { redact } from '../../../packages/core/src/safety/index.mjs';
import { applyFix } from '../../../packages/cli/src/maintain-fix.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'sk-ant-api03-QWERTYUIOPASDFGHJKLZXCVBNM';

test('only the custom profile can disable the secret filter', () => {
  for (const profile of ['lite', 'full']) {
    assert.throws(() => setConfigValue(defaultConfig(profile), 'safety.secretFilter', false), {
      code: 'E_LOCKED_KEY',
    });
    const cfg = defaultConfig(profile);
    cfg.safety.secretFilter = false;
    assert.ok(validateConfig(cfg).errors.some((item) => item.code === 'E_LOCKED_KEY'));
  }
  const custom = setConfigValue(defaultConfig('custom'), 'safety.secretFilter', false);
  assert.equal(custom.safety.secretFilter, false);
  assert.equal(secretFilterEnabled(custom), false);
  assert.equal(secretFilterEnabled(defaultConfig('custom')), true);
  assert.equal(secretFilterEnabled({}), true);
  assert.throws(() => setConfigValue(custom, 'profile', 'full'));
  assert.equal(setConfigValue(custom, 'safety.secretFilter', true).safety.secretFilter, true);
  assert.equal(redact(`key ${SECRET}`).includes(SECRET), false);
});

test('checkpoint refuses secret-like staged content even when called with { secretFilter: false }', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ba-optout-checkpoint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: join(dir, '.home'),
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.data'),
    XDG_STATE_HOME: join(dir, '.state'),
  };
  await mkdir(env.HOME, { recursive: true });
  await mkdir(join(dir, 'wiki'), { recursive: true });
  await writeFile(join(dir, 'wiki/page.md'), `key ${SECRET}\n`);
  assert.equal(spawnSync('git', ['init', '--quiet', dir], { env }).status, 0);
  const runCommand = async (cmd, args, options) => {
    const r = spawnSync(cmd, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', shell: false });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
  };
  const scanned = [];
  const safety = {
    scanPath: (p) => (scanned.push(`path:${p}`), []),
    scanText: () => (scanned.push('text'), [{ ruleId: 'anthropic' }]),
  };
  const lint = async () => ({ errorCount: 0 });
  await assert.rejects(checkpoint(dir, 'refused', { runCommand, safety, env, lint, secretFilter: false }), {
    code: 'E_SECRET_DETECTED',
  });
  assert.deepEqual(scanned, ['path:wiki/page.md', 'text']);
});

test('maintain --fix indexes a secret-like title only when the filter is off', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ba-optout-fix-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'wiki/concepts'), { recursive: true });
  await writeFile(join(base, 'wiki/index.md'), '# Wiki Index\n\n## Concepts\n');
  await writeFile(
    join(base, 'wiki/concepts/leak.md'),
    `---\ntype: concept\nstatus: confirmed\ntitle: ${JSON.stringify(SECRET)}\n---\n\n# Notes\n`
  );
  const now = new Date('2026-11-21T00:00:00Z');
  const filtered = await applyFix(base, { now });
  assert.ok(filtered.unfixed.some((item) => item.reason === 'secret-filter'));
  assert.equal((await readFile(join(base, 'wiki/index.md'), 'utf8')).includes('leak.md'), false);
  const optedOut = await applyFix(base, { now, secretFilter: false });
  assert.equal(
    optedOut.unfixed.some((item) => item.reason === 'secret-filter'),
    false
  );
  assert.equal((await readFile(join(base, 'wiki/index.md'), 'utf8')).includes('leak.md'), true);
});

test('MCP writes secret-like content when the custom profile opts out, but path deny rules still apply', async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), 'ba-optout-mcp-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const vault = resolve(home, 'vault');
  await cp(resolve(root, 'demo-vault'), vault, { recursive: true });
  const config = defaultConfig('custom');
  config.vault.path = vault;
  config.safety.secretFilter = false;
  const configFile = resolve(home, 'config.json');
  await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'packages/mcp/bin/brainatlas-mcp.mjs')],
    cwd: root,
    env: { HOME: home, BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'secret-filter-optout-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  const written = await client.callTool({
    name: 'wiki_write_page',
    arguments: { path: 'entities/opt-out.md', content: `---\ntype: entity\n---\nkey ${SECRET}` },
  });
  assert.notEqual(written.isError, true, written.content?.[0]?.text);
  assert.match(await readFile(join(vault, 'wiki/entities/opt-out.md'), 'utf8'), /sk-ant-api03/);
  const denied = await client.callTool({
    name: 'wiki_write_page',
    arguments: { path: 'entities/server.pem', content: 'plain text' },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /E_SECRET_DETECTED/);
});
