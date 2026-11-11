// SPDX-License-Identifier: MIT
// Child process for the BA-07 load-trace test. argv[2] is a JSON request:
// {repo, vault, stateDir, home, profile, semanticEnabled, prompt}. Prints the hook stdout as JSON.
import { join } from 'node:path';

const request = JSON.parse(process.argv[2]);
const { runHook } = await import(join(request.repo, 'packages/hooks/src/index.mjs'));
const { SEMANTIC_DEFAULTS } = await import(join(request.repo, 'packages/core/src/config/index.mjs'));
const config = {
  profile: request.profile,
  modules: request.profile === 'lite' ? [] : ['*'],
  vault: { path: request.vault },
  stateDir: request.stateDir,
  hooks: { mode: 'normal', deadlineMs: 1000 },
  retrieval: { abstainThreshold: 0.35 },
  semantic: { ...SEMANTIC_DEFAULTS, enabled: request.semanticEnabled },
};
const stdin = JSON.stringify({ session_id: 'ba07-trace', prompt: request.prompt });
const { stdout } = await runHook({ client: 'claude', event: 'prompt', stdin, env: { HOME: request.home }, config, now: new Date() });
process.stdout.write(stdout);
