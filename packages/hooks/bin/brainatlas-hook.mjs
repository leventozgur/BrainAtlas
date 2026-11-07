#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { resolvePaths, vaultId } from '../../core/src/paths/index.mjs';
import { loadConfig } from '../../core/src/config/index.mjs';
import { join } from 'node:path';
import { runHook } from '../src/index.mjs';

const [client, event, ...extra] = process.argv.slice(2);
if (!['claude','codex','kiro','copilot','gemini'].includes(client) || !['prompt','session-start','session-end'].includes(event) || extra.length) process.exit(2);
// The process deadline includes configuration and stdin, even if either stalls.
const timer = setTimeout(() => { process.stdout.write(client === 'kiro' ? '' : '{}', () => process.exit(0)); }, 4700);
try {
  let stdin = '';
  for await (const chunk of process.stdin) { stdin += chunk; if (stdin.length > 1024 * 1024) throw new Error('input'); }
  const paths = resolvePaths({env:process.env});
  const config = await loadConfig({paths,env:process.env});
  config.stateDir = join(paths.stateDir, vaultId(config.vault.path));
  const result = await runHook({client,event,stdin,env:process.env,now:new Date(),config});
  clearTimeout(timer); process.stdout.write(result.stdout); process.exitCode = result.exitCode;
} catch { clearTimeout(timer); process.stdout.write(client === 'kiro' ? '' : '{}'); }
