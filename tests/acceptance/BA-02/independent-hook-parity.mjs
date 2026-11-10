// SPDX-License-Identifier: MIT
// BA-02 independent parity check (not a node:test file): runHook prompt results on a 2000-page synthetic vault.
// usage: node independent-hook-parity.mjs <repoRoot> <workDir>
// Prints one JSON line per prompt: the hook stdout and exit code, so two repo roots can be diffed byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '../../..');
const repo = path.resolve(process.argv[2]);
const work = path.resolve(process.argv[3]);
const N = 2000, SEED = 1, PROMPTS = 20;
const now = new Date('2026-11-10T00:00:00Z');

const { runHook } = await import(pathToFileURL(path.join(repo, 'packages/hooks/src/index.mjs')).href);
const corpus = await import(pathToFileURL(path.join(WT, 'eval/lib/synthetic-corpus.mjs')).href);

const vault = path.join(work, 'vault');
const stateDir = path.join(work, 'hook-state');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(stateDir, { recursive: true });
const { queries } = corpus.writeSyntheticCorpus(vault, { pages: N, seed: SEED, queryCount: 30 });
const config = { vault: { path: vault }, stateDir, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } };
for (let i = 0; i < PROMPTS; i++) {
  const stdin = JSON.stringify({ session_id: `parity-${i}`, prompt: queries[i % queries.length] });
  const out = await runHook({ client: 'claude', event: 'prompt', stdin, env: {}, config, now });
  console.log(JSON.stringify({ i, exitCode: out.exitCode, stdout: out.stdout }));
}
