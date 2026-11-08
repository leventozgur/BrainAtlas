// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { resolvePaths } from '../../../packages/core/src/paths/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nativeMcp = join(root, 'packages/mcp/bin/brainatlas-mcp.mjs');
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
const platformOverrideExpression = 'platform: env.BRAINATLAS_PLATFORM || process.platform';

function oppositeSupportedPlatform() {
  assert.ok(['darwin', 'linux'].includes(process.platform), 'the acceptance host must be macOS or Linux');
  return process.platform === 'darwin' ? 'linux' : 'darwin';
}

async function makeFixture(temp, platform) {
  const home = join(temp, 'fake-home');
  const vault = join(home, 'vault');
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
    XDG_DATA_HOME: join(home, 'xdg-data'),
    XDG_STATE_HOME: join(home, 'xdg-state'),
    PATH: process.env.PATH || '/usr/bin:/bin',
    BRAINATLAS_OFFLINE: '1'
  };
  if (platform !== undefined) env.BRAINATLAS_PLATFORM = platform;
  await cp(join(root, 'demo-vault'), vault, { recursive: true });
  const config = defaultConfig('lite');
  config.readOnly = true;
  config.vault.path = vault;
  const paths = resolvePaths({ env, platform: platform || process.platform });
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(config));
  return { home, vault, env, paths };
}

async function checkMcpConfig(binary, fixture, { allowLegacyStartupFailure = false } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binary],
    cwd: root,
    env: fixture.env,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'q-cifix-platform-acceptance', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'wiki_status', arguments: {} });
    return result;
  } catch (error) {
    if (allowLegacyStartupFailure && error?.name === 'McpError' && error?.code === -32000) {
      return { startupFailed: true, message: error.message };
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function mcpVariant(temp, name, source) {
  return (async () => {
    const variant = join(temp, name);
    await mkdir(join(variant, 'src'), { recursive: true });
    await mkdir(join(variant, 'bin'), { recursive: true });
    await writeFile(join(variant, 'src/index.mjs'), source);
    await cp(join(root, 'packages/mcp/bin/brainatlas-mcp.mjs'), join(variant, 'bin/brainatlas-mcp.mjs'));
    await symlink(join(root, 'node_modules'), join(variant, 'node_modules'), 'dir');
    return join(variant, 'bin/brainatlas-mcp.mjs');
  })();
}

test('MCP honors an opposite-platform override; the pre-fix platform selection fails the same probe', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'q-cifix-platform-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const override = oppositeSupportedPlatform();
  const fixture = await makeFixture(temp, override);

  const current = await checkMcpConfig(nativeMcp, fixture);
  assert.ok(current.isError !== true, 'MCP should load the override-selected config and Wiki');
  const status = JSON.parse(current.content[0].text);
  assert.ok(status.readOnly === true && status.pageCount > 0, 'MCP should use the configured fake vault');
  const cliResult = spawnSync(process.execPath, [cli, 'config', 'get', 'vault.path', '--json'], {
    cwd: root,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.ok(!cliResult.error && cliResult.status === 0, 'CLI should load config with the same platform override');
  assert.ok(JSON.parse(cliResult.stdout.trim()) === fixture.vault, 'CLI should read the override-selected config');

  const source = await readFile(join(root, 'packages/mcp/src/index.mjs'), 'utf8');
  assert.ok(source.includes(platformOverrideExpression), 'MCP must retain the CLI-compatible platform expression');
  const legacySource = source.replace(platformOverrideExpression, 'platform: process.platform');
  assert.notEqual(legacySource, source, 'the one-line pre-fix mutation must be applicable');
  const legacyBinary = await mcpVariant(temp, 'legacy-mcp', legacySource);
  const legacyResult = await checkMcpConfig(legacyBinary, fixture, { allowLegacyStartupFailure: true });
  const legacyFailed = legacyResult.startupFailed === true || legacyResult.isError === true;
  assert.ok(legacyFailed, 'the pre-fix MCP must fail when it searches the native platform path');
  const legacyMessage = legacyResult.startupFailed ? legacyResult.message : legacyResult.content[0].text;
  assert.ok(legacyMessage.includes('Connection closed') || legacyMessage.includes('E_VAULT_MISSING'));
  assert.equal(legacyMessage.includes(fixture.home), false, 'the failure must not reveal fake HOME');
});

test('unset and empty BRAINATLAS_PLATFORM preserve native resolution in MCP and CLI', async t => {
  for (const setting of ['unset', 'empty']) {
    const temp = await mkdtemp(join(tmpdir(), `q-cifix-${setting}-`));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const fixture = await makeFixture(temp, process.platform);
    if (setting === 'unset') delete fixture.env.BRAINATLAS_PLATFORM;
    else fixture.env.BRAINATLAS_PLATFORM = '';

    const result = await checkMcpConfig(nativeMcp, fixture);
    assert.ok(result.isError !== true, `MCP should load native config when override is ${setting}`);
    const status = JSON.parse(result.content[0].text);
    assert.ok(status.readOnly === true && status.pageCount > 0, `MCP native behavior should survive ${setting} override`);

    const cliResult = spawnSync(
      process.execPath,
      [cli, 'config', 'get', 'vault.path', '--json'],
      { cwd: root, env: fixture.env, encoding: 'utf8', timeout: 10_000 }
    );
    assert.ok(!cliResult.error && cliResult.status === 0, `CLI should resolve the same native config when override is ${setting}`);
    assert.ok(JSON.parse(cliResult.stdout.trim()) === fixture.vault, 'CLI should read the fake vault from native config');
  }
});

test('unsupported and malformed platform values fail with bounded path errors', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'q-cifix-invalid-platform-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'fake-home');
  const env = { HOME: home, BRAINATLAS_PLATFORM: 'win32' };
  assert.throws(() => resolvePaths({ env, platform: env.BRAINATLAS_PLATFORM }), error => error.code === 'E_PLATFORM');
  assert.throws(() => resolvePaths({ env: { HOME: home }, platform: ' ' }), error => error.code === 'E_PLATFORM');
  assert.throws(() => resolvePaths({ env: {}, platform: 'linux' }), error => error.code === 'E_NO_HOME');

  const result = spawnSync(process.execPath, [nativeMcp], {
    cwd: root,
    env: { ...env, PATH: process.env.PATH || '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.ok(!result.error && result.status !== 0, 'MCP should exit cleanly for an unsupported platform');
  assert.ok(result.stderr.includes('BrainAtlas MCP failed to start.'), 'MCP should report a bounded startup error');
  assert.ok(!result.stderr.includes(home), 'MCP startup diagnostics must not reveal HOME');
});
