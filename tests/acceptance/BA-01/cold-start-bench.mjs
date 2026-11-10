// SPDX-License-Identifier: MIT
// BA-01 independent cold-start measurement (not a test file; run manually).
// Usage: node cold-start-bench.mjs <mainRepoRoot> <worktreeRoot> [runsPerRound=30] [rounds=2]
// Each sample is one fresh node process running the hook shim; samples are strictly sequential.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [mainRoot, wtRoot, runsArg, roundsArg] = process.argv.slice(2);
const RUNS = Number(runsArg ?? 30);
const ROUNDS = Number(roundsArg ?? 2);
const root = await mkdtemp(join(tmpdir(), 'ba01-bench-'));
try {
  // One isolated HOME and one identical vault per implementation: separate state, retrieval cache and session ids.
  const envFor = name => {
    const home = join(root, name, 'home');
    return {
      HOME: home,
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: join(root, name, 'tmp'),
      XDG_CONFIG_HOME: join(root, name, 'config'),
      XDG_DATA_HOME: join(root, name, 'data'),
      XDG_STATE_HOME: join(root, name, 'state'),
    };
  };
  const envs = { main: envFor('main'), worktree: envFor('worktree') };
  const vaults = { main: join(root, 'main', 'vault'), worktree: join(root, 'worktree', 'vault') };
  for (const n of ['main', 'worktree']) await mkdir(envs[n].TMPDIR, { recursive: true });
  // Small vault: 5 recent pages, a log with human and machine lines, one prompt-matching page.
  const now = Date.now();
  const iso = d => new Date(now - d * 86400_000).toISOString();
  const pages = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const { defaultConfig } = await import(pathToFileURL(join(wtRoot, 'packages/core/src/config/index.mjs')).href);
  const { resolvePaths } = await import(pathToFileURL(join(wtRoot, 'packages/core/src/paths/index.mjs')).href);
  for (const n of ['main', 'worktree']) {
    const vault = vaults[n], env = envs[n];
    await mkdir(join(vault, 'wiki', 'entities'), { recursive: true });
    for (const p of pages) await writeFile(join(vault, 'wiki', 'entities', `${p}.md`), `---\ntitle: "Page ${p}"\n---\n# Page ${p}\nBody for ${p}, topic evidence.\n`);
    await writeFile(join(vault, 'wiki', 'entities', 'topic.md'), '# Topic\nTopic retrieval evidence for benchmark.\n');
    await writeFile(join(vault, 'wiki', 'index.md'), '# Index\n');
    const log = ['# Log', 'human note'];
    pages.forEach((p, i) => log.push(`- ${iso(i + 0.5)} {"action":"update-page","path":"wiki/entities/${p}.md"}`));
    log.push(`- ${iso(1)} {"action":"update-page","path":"wiki/entities/topic.md"}`);
    await writeFile(join(vault, 'wiki', 'log.md'), log.join('\n') + '\n');
    const paths = resolvePaths({ env });
    await mkdir(dirname(paths.configFile), { recursive: true });
    const config = defaultConfig('lite');
    config.vault.path = vault;
    config.retrieval.abstainThreshold = 0;
    await writeFile(paths.configFile, JSON.stringify(config));
  }

  const impls = { main: mainRoot, worktree: wtRoot };
  const events = {
    prompt: { client: 'claude', event: 'prompt', payload: i => ({ session_id: `bench-p-${i}`, prompt: 'topic' }), expect: /Topic/ },
    'session-start': { client: 'claude', event: 'session-start', payload: i => ({ session_id: `bench-s-${i}`, source: 'startup' }), expect: /Recently changed pages/ },
  };
  const results = {};
  const samples = (impl, ev, round) => {
    const out = [];
    for (let i = 0; i < RUNS; i++) {
      const spec = events[ev];
      const bin = join(impls[impl], 'packages/hooks/bin/brainatlas-hook.mjs');
      const begin = performance.now();
      const r = spawnSync(process.execPath, [bin, spec.client, spec.event], { input: JSON.stringify(spec.payload(`${impl}-${round}-${i}-${Date.now()}`)), env: envs[impl], encoding: 'utf8', timeout: 12000 });
      const ms = performance.now() - begin;
      if (r.status !== 0) throw new Error(`${impl}/${ev} exit ${r.status}`);
      if (ev === 'prompt' && !spec.expect.test(r.stdout)) throw new Error(`${impl}/${ev} no context`);
      if (ev === 'session-start' && impl === 'worktree' && !spec.expect.test(r.stdout)) throw new Error(`${impl}/${ev} no card`);
      out.push(ms);
    }
    return out;
  };
  // Reference: a bare node process with no hook work.
  const baseline = () => Array.from({ length: RUNS }, () => {
    const begin = performance.now();
    spawnSync(process.execPath, ['-e', '0'], { env: envs.main, encoding: 'utf8' });
    return performance.now() - begin;
  });
  const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
  const load = () => { const r = spawnSync('uptime', [], { encoding: 'utf8' }); return r.stdout.trim(); };
  console.log(`# load before: ${load()}`);
  for (let round = 1; round <= ROUNDS; round++) {
    for (const ev of Object.keys(events)) {
      for (const impl of ['main', 'worktree']) {
        const s = samples(impl, ev, round);
        results[`${impl}|${ev}|r${round}`] = s;
        console.log(`round ${round} ${ev.padEnd(14)} ${impl.padEnd(9)} n=${s.length} p50=${pct(s, 50).toFixed(1)} p95=${pct(s, 95).toFixed(1)} ms`);
      }
    }
    const b = baseline();
    results[`baseline|r${round}`] = b;
    console.log(`round ${round} baseline(node -e 0) n=${b.length} p50=${pct(b, 50).toFixed(1)} p95=${pct(b, 95).toFixed(1)} ms`);
  }
  console.log(`# load after: ${load()}`);
  console.log('\n| event | impl | n | p50 ms | p95 ms |');
  console.log('|---|---|---|---|---|');
  for (const ev of Object.keys(events)) for (const impl of ['main', 'worktree']) {
    const all = Object.entries(results).filter(([k]) => k.startsWith(`${impl}|${ev}|`)).flatMap(([, v]) => v);
    console.log(`| ${ev} | ${impl} | ${all.length} | ${pct(all, 50).toFixed(1)} | ${pct(all, 95).toFixed(1)} |`);
  }
  const base = Object.entries(results).filter(([k]) => k.startsWith('baseline|')).flatMap(([, v]) => v);
  console.log(`| baseline (node -e 0) | - | ${base.length} | ${pct(base, 50).toFixed(1)} | ${pct(base, 95).toFixed(1)} |`);
  for (const ev of Object.keys(events)) {
    const m = pct(Object.entries(results).filter(([k]) => k.startsWith(`main|${ev}|`)).flatMap(([, v]) => v), 50);
    const w = pct(Object.entries(results).filter(([k]) => k.startsWith(`worktree|${ev}|`)).flatMap(([, v]) => v), 50);
    console.log(`delta p50 ${ev}: ${(w - m).toFixed(1)} ms (worktree - main)`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
