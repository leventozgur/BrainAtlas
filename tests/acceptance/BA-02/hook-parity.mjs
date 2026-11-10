// SPDX-License-Identifier: MIT
// BA-02 hook-path parity: runHook output on a deterministic synthetic vault, no network.
// usage: node hook-parity.mjs <repoRoot> [pages=2000] [prompts=20]
// Prints one JSON line: per-prompt injected paths plus a digest of the full stdout envelopes.
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [rootArg, pagesArg = '2000', promptsArg = '20'] = process.argv.slice(2);
if (!rootArg) { console.error('usage'); process.exit(2); }
const root = resolve(rootArg);
const { runHook } = await import(join(root, 'packages/hooks/src/index.mjs'));
const { writeSyntheticCorpus } = await import(join(root, 'eval/lib/synthetic-corpus.mjs'));
const n = Number(pagesArg), prompts = Math.max(20, Number(promptsArg));
const now = new Date('2026-01-15T00:00:00Z');
const base = mkdtempSync(join(tmpdir(), 'ba02-hook-'));
try {
  const vault = join(base, 'vault'), stateDir = join(base, 'hook-state');
  mkdirSync(vault); mkdirSync(stateDir);
  const { queries } = writeSyntheticCorpus(vault, { pages: n, seed: 1, queryCount: prompts });
  const config = { vault: { path: resolve(vault) }, stateDir, hooks: { mode: 'normal', deadlineMs: 4700 }, retrieval: { abstainThreshold: 0 } };
  const digest = createHash('sha256');
  const rows = [];
  for (let i = 0; i < prompts; i++) {
    const stdin = JSON.stringify({ prompt: queries[i % queries.length] });
    const out = await runHook({ client: 'claude', event: 'prompt', stdin, env: {}, config, now });
    digest.update(`${out.exitCode}\n${out.stdout}\n`);
    const paths = [...out.stdout.matchAll(/\(([^()\s]+\.md)\)/g)].map((m) => m[1]);
    rows.push({ prompt: i, paths });
  }
  console.log(JSON.stringify({ root, pages: n, prompts, envelopeDigest: digest.digest('hex').slice(0, 16), rows }));
} finally {
  rmSync(base, { recursive: true, force: true });
}
