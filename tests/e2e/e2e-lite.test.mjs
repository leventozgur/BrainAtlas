// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolvePaths, vaultId } from '../../packages/core/src/paths/index.mjs';
import { runHook } from '../../packages/hooks/src/index.mjs';
import { createServer } from '../../packages/mcp/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const liteVersion1 = '0.1.0-e2e.1';
const liteVersion2 = '0.1.0-e2e.2';
const liteForbidden = /modules\/sync-|keychain|secret-service|launchd|systemd|dropbox/i;

function syntheticSecret() {
  return ['ba', 'e2e', randomBytes(24).toString('hex')].join('-');
}

function deniedProxy() {
  const loopback = [127, 0, 0, 1].join('.');
  return ['http:', '', `${loopback}:9`].join('/');
}

function childEnvironment(home, temp, signers) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    TMPDIR: join(temp, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    BRAINATLAS_PLATFORM: 'darwin',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_ALLOWED_SIGNERS: signers,
    HTTPS_PROXY: deniedProxy(),
    npm_config_offline: 'true',
    npm_config_loglevel: 'silent',
    npm_config_cache: join(temp, 'npm-cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C'
  };
}

async function put(file, content) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function snapshot(dir, exclude = []) {
  const result = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(cause => {
      if (cause.code === 'ENOENT') return [];
      throw cause;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const rel = relative(dir, path);
      if (exclude.some(item => rel === item || rel.startsWith(`${item}/`))) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) result.push([rel, 'link', await readlink(path)]);
      else if (info.isDirectory()) {
        result.push([rel, 'dir']);
        await walk(path);
      } else {
        result.push([rel, 'file', (await readFile(path)).toString('base64'), info.mode & 0o777]);
      }
    }
  }
  await walk(dir);
  return result;
}

function collectPlanChanges(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (typeof value.file === 'string' && ('before' in value || 'after' in value)) result.push(value);
  for (const child of Object.values(value)) collectPlanChanges(child, result);
  return result;
}

async function seedMacHome(home) {
  const claudeSecret = syntheticSecret();
  const copilotSecret = syntheticSecret();
  const kiroSecret = syntheticSecret();
  const planSecret = syntheticSecret();

  await put(join(home, '.claude.json'), `${JSON.stringify({
    mcpServers: { personal: { command: 'existing-command', args: ['--keep-user-setting'], env: { ACCESS_TOKEN: claudeSecret } } },
    userPreferences: { model: 'existing-model', telemetry: false }
  }, null, 2)}\n`);
  await put(join(home, '.claude', 'settings.json'), `${JSON.stringify({
    permissions: { allow: ['Read'], deny: [] },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'existing-hook --keep' }] }] },
    userSettings: { theme: 'dark', token: claudeSecret }
  }, null, 2)}\n`);
  await put(join(home, '.claude', 'CLAUDE.md'), '# User instructions\nPreserve existing workflow settings.\n');
  await put(join(home, 'CLAUDE.md'), '# Existing home instructions\nPreserve this user-owned file.\n');

  await put(join(home, '.copilot', 'mcp-config.json'), `${JSON.stringify({
    mcpServers: { personal: { command: 'existing-command', env: { SESSION_TOKEN: planSecret } } },
    userSettings: { editor: 'existing-editor', updates: false, token: copilotSecret }
  }, null, 2)}\n`);
  await put(join(home, '.copilot', 'hooks', 'user-hook.json'), `${JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', command: 'user-owned-hook' }] } }, null, 2)}\n`);
  await put(join(home, '.copilot', 'instructions', 'user.instructions.md'), '# Existing Copilot instructions\nKeep these rules.\n');

  await put(join(home, '.kiro', 'settings', 'mcp.json'), `${JSON.stringify({
    mcpServers: { personal: { command: 'existing-command', env: { API_TOKEN: kiroSecret } } },
    userSettings: { terminal: 'existing-terminal', approvals: 'manual' }
  }, null, 2)}\n`);
  await put(join(home, '.kiro', 'hooks', 'user-hook.json'), `${JSON.stringify({ version: 'v1', hooks: [{ name: 'user-hook', enabled: true }] }, null, 2)}\n`);
  await put(join(home, '.kiro', 'steering', 'user-rules.md'), '# Existing steering\nPreserve these Kiro rules.\n');
  return { planSecret };
}

async function buildAndSignArtifacts(temp, home, signers) {
  const env = childEnvironment(home, temp, signers);
  const output = join(temp, 'release-output');
  await mkdir(output, { recursive: true });
  const artifacts = new Map();
  for (const version of [liteVersion1, liteVersion2]) {
    for (const profile of ['lite', 'full']) {
      const built = spawnSync('npm', ['run', 'build:release', '--', '--version', version, '--profile', profile, '--out', output], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 120_000
      });
      if (built.error || built.status !== 0) return { artifacts, failed: true };
      artifacts.set(`${version}-${profile}`, join(output, `brainatlas-${version}-${profile}.tgz`));
    }
  }

  const key = join(temp, 'temporary-release-key');
  const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { cwd: root, env, encoding: 'utf8' });
  if (generated.error || generated.status !== 0) return { artifacts, failed: true };
  const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
  await writeFile(signers, `brainatlas-release ${publicKey}\n`);
  const signed = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'brainatlas-release', join(output, 'SHA256SUMS')], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  return { artifacts, failed: Boolean(signed.error || signed.status !== 0), output };
}

async function installedLiteIsPure(releaseDir) {
  try {
    await lstat(join(releaseDir, 'modules'));
    return false;
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  for (const rootName of ['packages', 'vendor/llmwiki-core', 'templates']) {
    const base = join(releaseDir, rootName);
    async function inspect(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(cause => {
        if (cause.code === 'ENOENT') return [];
        throw cause;
      })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (liteForbidden.test(path.slice(releaseDir.length))) return false;
          if (!(await inspect(path))) return false;
        } else if (entry.isFile()) {
          if (liteForbidden.test(path.slice(releaseDir.length))) return false;
          if (liteForbidden.test((await readFile(path)).toString('utf8'))) return false;
        }
      }
      return true;
    }
    if (!(await inspect(base))) return false;
  }
  const manifest = await readFile(join(releaseDir, 'release-manifest.json'), 'utf8');
  return !liteForbidden.test(manifest);
}

async function containsAnyText(dir, values) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(cause => {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await containsAnyText(path, values)) return true;
    } else if (entry.isFile()) {
      const content = await readFile(path, 'utf8');
      if (values.some(value => content.includes(value))) return true;
    }
  }
  return false;
}

async function callInstalledMcp(cli, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env, cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'e2e-check', version: '1.0.0' });
  let connected = false;
  let stage = 'connect';
  try {
    await client.connect(transport);
    connected = true;
    stage = 'query';
    const query = await client.callTool({ name: 'wiki_query', arguments: { query: 'offline approval context lane evidence', limit: 5 } });
    const queryResult = query.content?.[0]?.text ? JSON.parse(query.content[0].text) : {};
    const secret = syntheticSecret();
    stage = 'write';
    const write = await client.callTool({
      name: 'wiki_write_page',
      arguments: {
        path: 'concepts/write-safety-probe.md',
        content: `---\ntitle: Write safety probe\n---\npassword: ${secret}\n`
      }
    });
    const responseText = JSON.stringify(write);
    return {
      querySucceeded: !query.isError && Array.isArray(queryResult.results) && queryResult.results.length > 0,
      queryFailed: query.isError === true,
      queryCount: Array.isArray(queryResult.results) ? queryResult.results.length : -1,
      writeRefused: write.isError === true && responseText.includes('E_SECRET_DETECTED') && !responseText.includes(secret),
      writeFailed: write.isError !== true,
      writeResponseLeakedSecret: responseText.includes(secret)
    };
  } catch (cause) {
    const known = ['Error', 'McpError', 'AbortError', 'AggregateError'].includes(cause?.name) ? cause.name : 'Other';
    const message = cause?.message === 'MCP error -32000: Connection closed' ? 'connection-closed' : 'operation-failed';
    return { clientFailed: true, connected, clientErrorKind: known, clientErrorStage: stage, clientErrorMessage: message };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runSourceSafetyProbes({ temp, home, vault, env, pageSecret, pageContent }) {
  const promptText = 'Which offline approval context lane evidence applies?';
  const hookStateDir = join(temp, 'source-hook-state');
  const config = {
    schemaVersion: 1,
    profile: 'lite',
    vault: { path: vault },
    modules: [],
    agents: [],
    scope: 'global',
    retrieval: { budgetChars: 4000, abstainThreshold: 0 },
    hooks: { mode: 'normal', deadlineMs: 4700 },
    safety: { secretFilter: true, extraDenyGlobs: [] },
    okf: { level: 'warn' },
    sync: { transport: null, options: {} },
    telemetry: false,
    readOnly: false,
    node: { path: process.execPath },
    stateDir: hookStateDir
  };
  const hook = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: 'source-safety-session', prompt: promptText }),
    env: { HOME: home },
    now: new Date('2026-01-01T00:00:00.000Z'),
    config
  });
  const hookSafe = hook.exitCode === 0 && hook.stdout.includes('Offline approval context lane') && !hook.stdout.includes(pageSecret);
  const hookLogsSafe = !(await containsAnyText(join(hookStateDir, 'metrics'), [pageSecret, promptText, pageContent]));

  const paths = {
    dataDir: join(temp, 'source-mcp-data'),
    configFile: join(temp, 'source-mcp-config.json'),
    stateDir: join(temp, 'source-mcp-state'),
    installManifest: join(temp, 'source-mcp-manifest.json')
  };
  const server = createServer({ config, paths, env: { HOME: home } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'e2e-safety-check', version: '1.0.0' });
  let writeSafe = false;
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const writeSecret = syntheticSecret();
    const result = await client.callTool({
      name: 'wiki_write_page',
      arguments: {
        path: 'concepts/source-safety-probe.md',
        content: `---\ntitle: Source safety probe\n---\npassword: ${writeSecret}\n`
      }
    });
    const response = JSON.stringify(result);
    const targetExists = await lstat(join(vault, 'wiki', 'concepts', 'source-safety-probe.md')).then(() => true).catch(() => false);
    writeSafe = result.isError === true && response.includes('E_SECRET_DETECTED') && !response.includes(writeSecret) && !targetExists;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
  return { hookSafe, hookLogsSafe, writeSafe };
}

test('company Mac Lite lifecycle works offline and restores the fake HOME', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ba-e2e-lite-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'fake-home-macos');
  const vault = join(home, 'BrainAtlas');
  const signers = join(temp, 'allowed-signers');
  await mkdir(join(temp, 'tmp'), { recursive: true });
  await mkdir(join(home, 'Library', 'Application Support'), { recursive: true });
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  const seeded = await seedMacHome(home);
  const env = childEnvironment(home, temp, signers);
  await put(join(vault, 'wiki', 'index.md'), '# Wiki Index\n\n## Entries\n');
  await put(join(vault, 'wiki', 'log.md'), '# Wiki Log\n');

  const built = await buildAndSignArtifacts(temp, home, signers);
  const issues = [];
  if (built.failed) issues.push('release-build-or-sign');
  const beforeHome = await snapshot(home, ['BrainAtlas']);
  const agentFiles = [
    '.claude.json', '.claude/settings.json', '.claude/CLAUDE.md', 'CLAUDE.md',
    '.copilot/mcp-config.json', '.copilot/hooks/user-hook.json', '.copilot/instructions/user.instructions.md',
    '.kiro/settings/mcp.json', '.kiro/hooks/user-hook.json', '.kiro/steering/user-rules.md'
  ];
  const beforeAgents = await Promise.all(agentFiles.map(async rel => [rel, await readFile(join(home, rel))]));

  if (!built.failed) {
    const install = spawnSync('sh', [join(root, 'install.sh'), '--from', built.artifacts.get(`${liteVersion1}-lite`), '--yes'], {
      cwd: root, env, encoding: 'utf8', timeout: 60_000
    });
    if (install.error || install.status !== 0) issues.push('offline-install');

    const paths = resolvePaths({ platform: 'darwin', env });
    const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });

    if (install.status === 0) {
      const plan = run('init', '--plan', '--profile', 'lite', '--agents', 'copilot-vscode', '--yes');
      let planBeforeLeaked = false;
      let planAfterLeaked = false;
      let planTargetFound = false;
      if (!plan.error && plan.status === 0) {
        try {
          const rendered = JSON.parse(plan.stdout);
          const planChanges = collectPlanChanges(rendered);
          const target = planChanges.find(change => change.file.endsWith('.copilot/mcp-config.json'));
          planTargetFound = Boolean(target);
          planBeforeLeaked = typeof target?.before === 'string' && target.before.includes(seeded.planSecret);
          planAfterLeaked = typeof target?.after === 'string' && target.after.includes(seeded.planSecret);
          if (!planTargetFound) {
            if (Array.isArray(rendered.warnings) && rendered.warnings.some(warning => warning === 'Adapter copilot-vscode is unavailable.')) issues.push('cli-plan-adapter-unavailable');
            if (planChanges.length > 0) issues.push('cli-plan-change-shape');
          }
        } catch { issues.push('init-plan-output-invalid'); }
      } else issues.push('init-plan-command');

      // Run the same CLI plan path from the source tree so adapter snapshots are
      // still checked when a release omits the adapter's workspace dependency.
      const sourcePlan = spawnSync(process.execPath, [join(root, 'packages', 'cli', 'bin', 'brainatlas.mjs'), 'init', '--plan', '--profile', 'lite', '--agents', 'copilot-vscode', '--yes'], {
        cwd: root, env, encoding: 'utf8', timeout: 30_000
      });
      if (!sourcePlan.error && sourcePlan.status === 0) {
        try {
          const rendered = JSON.parse(sourcePlan.stdout);
          const target = collectPlanChanges(rendered).find(change => change.file.endsWith('.copilot/mcp-config.json'));
          if (!target) issues.push('source-cli-plan-copilot-target-missing');
          if (typeof target?.before === 'string' && target.before.includes(seeded.planSecret)) planBeforeLeaked = true;
          if (typeof target?.after === 'string' && target.after.includes(seeded.planSecret)) planAfterLeaked = true;
        } catch { issues.push('source-cli-plan-output-invalid'); }
      } else issues.push('source-cli-plan-command');

      const initialized = run('init', '--profile', 'lite', '--agents', 'claude-code,copilot-vscode,kiro', '--yes');
      if (initialized.error || initialized.status !== 0) issues.push('init-agents');
      else {
        try {
          const initResult = JSON.parse(initialized.stdout);
          if (initResult.warnings?.some(warning => /^Adapter (?:claude-code|copilot-vscode|kiro) is unavailable\.$/.test(warning))) issues.push('installed-agent-adapters-unavailable');
        } catch { issues.push('init-agent-output-invalid'); }
      }
      if (!planTargetFound) issues.push('cli-plan-copilot-target-missing');

      const releaseDir = join(paths.currentDir);
      if (!(await installedLiteIsPure(releaseDir).catch(() => false))) issues.push('lite-purity');
      if (await readlink(paths.currentDir).catch(() => null) !== `releases/${liteVersion1}`) issues.push('installed-current-link');

      const evidenceSecret = syntheticSecret();
      const evidencePage = `---\ntitle: Offline approval context lane\ntags: [offline, approval]\n---\n# Offline approval context lane\nThe context lane uses offline approval evidence for a safe update workflow.\npassword: ${evidenceSecret}\n`;
      await put(join(vault, 'wiki', 'concepts', 'offline-approval.md'), evidencePage);

      if (initialized.status === 0) {
        const mcpOutcome = await callInstalledMcp(cli, env).catch(() => null);
        if (!mcpOutcome?.querySucceeded) issues.push('mcp-wiki-query');
        if (mcpOutcome?.clientFailed) issues.push('mcp-stdio-client-failed');
        if (mcpOutcome?.clientErrorKind) issues.push(`mcp-client-error-${mcpOutcome.clientErrorKind}`);
        if (mcpOutcome?.clientErrorStage) issues.push(`mcp-${mcpOutcome.clientErrorStage}-${mcpOutcome.clientErrorMessage}`);
        if (mcpOutcome?.queryFailed) issues.push('mcp-query-returned-error');
        if (mcpOutcome?.queryCount === 0) issues.push('mcp-query-empty');
        if (!mcpOutcome?.writeRefused) issues.push('mcp-secret-write-refusal');
        if (mcpOutcome?.writeFailed) issues.push('mcp-secret-write-not-error');
        if (mcpOutcome?.writeResponseLeakedSecret) issues.push('mcp-error-redaction');

        const promptText = 'Which offline approval context lane evidence applies?';
        const hook = spawnSync(process.execPath, [cli, 'hook', 'claude', 'prompt'], {
          cwd: root,
          env,
          input: JSON.stringify({ session_id: 'e2e-session', prompt: promptText }),
          encoding: 'utf8',
          timeout: 15_000
        });
        const hookOutput = `${hook.stdout || ''}${hook.stderr || ''}`;
        if (hook.error || hook.status !== 0 || !hook.stdout?.includes('Offline approval context lane')) issues.push('hook-context');
        if (!hook.stdout?.trim()) issues.push('hook-empty-output');
        if (hook.stdout?.trim() === '{}') issues.push('hook-returned-empty-envelope');
        const hookCode = hook.stderr?.match(/\bE_[A-Z_]+\b/)?.[0];
        if (hookCode) issues.push(`hook-cli-${hookCode}`);
        if (hookOutput.includes(evidenceSecret)) issues.push('hook-output-redaction');
        if (hookOutput.includes(promptText) || hookOutput.includes(evidencePage)) issues.push('hook-output-content-leak');

        const pathsWithState = resolvePaths({ platform: 'darwin', env });
        const hookState = join(pathsWithState.stateDir, vaultId(vault));
        if (await containsAnyText(join(hookState, 'metrics'), [evidenceSecret, promptText, evidencePage]).catch(() => false)) issues.push('hook-metric-content-leak');

        const sourceSafety = await runSourceSafetyProbes({ temp, home, vault, env, pageSecret: evidenceSecret, pageContent: evidencePage }).catch(() => null);
        if (!sourceSafety?.hookSafe) issues.push('source-hook-output-redaction');
        if (!sourceSafety?.hookLogsSafe) issues.push('source-hook-log-redaction');
        if (!sourceSafety?.writeSafe) issues.push('source-mcp-secret-write-refusal');

        const updated = run('update', '--from', built.artifacts.get(`${liteVersion2}-lite`), '--json');
        if (updated.error || updated.status !== 0) issues.push('update');
        if (await readlink(paths.currentDir).catch(() => null) !== `releases/${liteVersion2}`) issues.push('updated-current-link');

        const moduleAdded = run('module', 'add', 'okf-strict', '--from', built.artifacts.get(`${liteVersion2}-full`), '--json');
        if (moduleAdded.error || moduleAdded.status !== 0) issues.push('module-add-okf-strict');
        else {
          const modulePath = join(paths.currentDir, 'modules', 'okf-strict');
          try { await lstat(modulePath); } catch { issues.push('module-install-tree'); }
        }

        const rolledBack = run('rollback', '--json');
        if (rolledBack.error || rolledBack.status !== 0) issues.push('rollback');
        if (await readlink(paths.currentDir).catch(() => null) !== `releases/${liteVersion1}`) issues.push('rollback-current-link');

        await rm(join(vault, 'wiki', 'concepts', 'write-safety-probe.md'), { force: true });
        const uninstall = run('uninstall', '--json');
        if (uninstall.error || uninstall.status !== 0) issues.push('uninstall');
        const afterAgents = await Promise.all(agentFiles.map(async rel => [rel, await readFile(join(home, rel)).catch(() => null)]));
        if (!isDeepStrictEqual(beforeAgents, afterAgents)) issues.push('agent-config-byte-restore');
        const afterHome = await snapshot(home, ['BrainAtlas']);
        if (!isDeepStrictEqual(beforeHome, afterHome)) issues.push('fake-home-zero-diff');
        if (await readFile(join(vault, 'wiki', 'concepts', 'offline-approval.md'), 'utf8').catch(() => null) !== evidencePage) issues.push('vault-preserved');

      }

      if (planBeforeLeaked) issues.push('cli-plan-before-secret-redaction');
      if (planAfterLeaked) issues.push('cli-plan-after-secret-redaction');
      if (planTargetFound && plan.stdout?.includes(seeded.planSecret) && !planBeforeLeaked && !planAfterLeaked) issues.push('cli-plan-secret-output-unclassified');
    }
  }
  assert.deepEqual(issues, [], 'Lite E2E acceptance checks failed; see issue identifiers in this assertion.');
});
