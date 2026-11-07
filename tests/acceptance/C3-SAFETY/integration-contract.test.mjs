// SPDX-License-Identifier: MIT
// PM: these integration checks are deferred — hooks/MCP/checkpoint/sync are implemented by H-HOOKS, M-MCP, C4-VAULT, S-ENGINE; E2E tracks re-enable them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { positiveHoldout } from './fixtures/holdout.mjs';

const safetyUrl = new URL('../../../packages/core/src/safety/index.mjs', import.meta.url).href;
const hookUrl = new URL('../../../packages/hooks/src/index.mjs', import.meta.url).href;
const mcpUrl = new URL('../../../packages/mcp/src/index.mjs', import.meta.url).href;
const checkpointUrl = new URL('../../../packages/core/src/checkpoint/index.mjs', import.meta.url).href;
const syncUrl = new URL('../../../modules/sync-engine/src/index.mjs', import.meta.url).href;

async function assertNoSecretBytes(root, secrets) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await assertNoSecretBytes(path, secrets);
    else if (entry.isFile()) {
      const contents = await readFile(path);
      assert.ok(secrets.every((secret) => !contents.includes(Buffer.from(secret))), 'checkpoint persisted a synthetic credential');
    } else {
      assert.fail('checkpoint created an unexpected filesystem entry');
    }
  }
}

function runIsolatedProbe(operation, sample, root) {
  const childSource = `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const safety = await import(${JSON.stringify(safetyUrl)});
    const logged = [];
    const logValue = (value) => { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); } };
    for (const method of ['debug', 'info', 'log', 'warn', 'error']) console[method] = (...args) => logged.push(args.map(logValue).join(' '));
    let outcome = 'resolved';
    let visible = '';
    let diagnostic = '';
    try {
      let value;
      if (input.operation === 'hook') {
        const mod = await import(${JSON.stringify(hookUrl)});
        const config = {
          schemaVersion: 1, profile: 'lite', vault: { path: input.root }, modules: [], agents: [], scope: 'global',
          retrieval: { budgetChars: 1000, abstainThreshold: 0.5 }, hooks: { mode: 'normal', deadlineMs: 4700 },
          safety: { secretFilter: true, extraDenyGlobs: [] }, okf: { level: 'warn' }, sync: { transport: null, options: {} },
          telemetry: false, readOnly: false, node: { path: process.execPath },
        };
        value = await mod.runHook({ client: 'claude', event: 'prompt', stdin: JSON.stringify({ prompt: input.sample.text }), env: { HOME: input.root }, now: new Date(0), config });
        visible = String(value?.stdout ?? '');
        if (typeof value?.stdout !== 'string' || value.exitCode !== 0 || value.stdout.length > 4002) outcome = 'bad-result';
      } else if (input.operation === 'mcp') {
        const mod = await import(${JSON.stringify(mcpUrl)});
        const config = {
          schemaVersion: 1, profile: 'lite', vault: { path: input.root }, modules: [], agents: [], scope: 'global',
          retrieval: { budgetChars: 1000, abstainThreshold: 0.5 }, hooks: { mode: 'normal', deadlineMs: 4700 },
          safety: { secretFilter: true, extraDenyGlobs: [] }, okf: { level: 'warn' }, sync: { transport: null, options: {} },
          telemetry: false, readOnly: false, node: { path: process.execPath },
        };
        value = mod.createServer({ config, paths: { dataDir: input.root, configFile: input.root + '/config.json', stateDir: input.root, installManifest: input.root + '/manifest.json' }, env: { HOME: input.root } });
        if (!value || typeof value !== 'object') outcome = 'bad-result';
      } else if (input.operation === 'checkpoint') {
        const mod = await import(${JSON.stringify(checkpointUrl)});
        value = await mod.checkpoint(input.root, input.sample.text, { paths: [], now: new Date(0) });
        visible = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      } else if (input.operation === 'sync') {
        const mod = await import(${JSON.stringify(syncUrl)});
        value = await mod.activate({ safety, env: { HOME: input.root }, payload: input.sample.text });
        visible = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
      }
    } catch (error) {
      outcome = error?.code === 'E_SECRET_DETECTED' ? 'blocked' : 'rejected';
      diagnostic = String(error?.name ?? '') + ' ' + String(error?.message ?? '') + ' ' + (JSON.stringify(error) ?? '');
    }
    const joined = [...logged, diagnostic, visible].join('\\n');
    const leak = input.sample.secrets.some((secret) => joined.includes(secret));
    process.stdout.write(JSON.stringify({ outcome, leak }) + '\\n');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, TMPDIR: root },
    input: JSON.stringify({ operation, sample, root }),
    encoding: 'utf8',
    timeout: 5000,
  });
}

function assertProbeSafe(operation, sample, root) {
  const child = runIsolatedProbe(operation, sample, root);
  assert.ok(child.status === 0 && !child.error, `${operation} isolated probe failed`);
  const captured = `${child.stdout}\n${child.stderr}`;
  assert.ok(sample.secrets.every((secret) => !captured.includes(secret)), `${operation} leaked synthetic content to process output`);
  let result;
  try { result = JSON.parse(child.stdout); } catch { assert.fail(`${operation} produced unexpected output (contents suppressed)`); }
  assert.ok(!result.leak, `${operation} leaked synthetic content through result or logs`);
  return result.outcome;
}

test.skip('hook output filters sensitive content and stays within its contract bound', async (t) => {
  const sample = positiveHoldout[1];
  const root = await mkdtemp(join(tmpdir(), 'c3-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = assertProbeSafe('hook', sample, root);
  assert.ok(['resolved'].includes(outcome), `hook contract operation was ${outcome}`);
});

test.skip('MCP server contract is available for secret-safe controlled writes', async (t) => {
  const sample = positiveHoldout[2];
  const root = await mkdtemp(join(tmpdir(), 'c3-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = assertProbeSafe('mcp', sample, root);
  assert.ok(['resolved'].includes(outcome), `MCP contract operation was ${outcome}`);
});

test.skip('checkpoint filters or rejects secret-bearing messages without persisting values', async (t) => {
  const sample = positiveHoldout[3];
  const root = await mkdtemp(join(tmpdir(), 'c3-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = assertProbeSafe('checkpoint', sample, root);
  await assertNoSecretBytes(root, sample.secrets);
  assert.ok(['resolved', 'blocked'].includes(outcome), `checkpoint contract operation was ${outcome}`);
});

test.skip('sync engine exposes an activation path with the shared safety API', async (t) => {
  const sample = positiveHoldout[4];
  const root = await mkdtemp(join(tmpdir(), 'c3-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = assertProbeSafe('sync', sample, root);
  assert.ok(['resolved'].includes(outcome), `sync contract operation was ${outcome}`);
});
