#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { absoluteVaultPath, resolvePaths, vaultStateDir } from '../../core/src/paths/index.mjs';
import { loadConfig } from '../../core/src/config/index.mjs';
import { HOOK_PROCESS_DEADLINE_MS, finishHookOutput, runHook } from '../src/index.mjs';

const [client, event, ...extra] = process.argv.slice(2);
if (
  !['claude', 'codex', 'kiro', 'copilot', 'gemini'].includes(client) ||
  !['prompt', 'session-start', 'session-end'].includes(event) ||
  extra.length
)
  process.exit(2);
const started = Date.now();
const timer = setTimeout(() => {
  process.stdout.write(client === 'kiro' ? '' : '{}', () => process.exit(0));
}, HOOK_PROCESS_DEADLINE_MS);

try {
  let stdin = '';
  for await (const chunk of process.stdin) {
    stdin += chunk;
    if (stdin.length > 1024 * 1024) throw new Error('input');
  }
  const paths = resolvePaths({ env: process.env });
  const config = await loadConfig({ paths, env: process.env });
  config.stateDir = vaultStateDir(paths, absoluteVaultPath(config.vault.path));
  const result = await runHook({ client, event, stdin, env: process.env, now: new Date(), config });
  clearTimeout(timer);
  finishHookOutput(result, started, (exitCode) => process.exit(exitCode));
} catch {
  clearTimeout(timer);
  finishHookOutput({ stdout: client === 'kiro' ? '' : '{}', exitCode: 0 }, started, (exitCode) =>
    process.exit(exitCode)
  );
}
