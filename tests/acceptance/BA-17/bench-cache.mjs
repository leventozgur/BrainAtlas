// SPDX-License-Identifier: MIT
// Report-only measurement (no threshold): cache file size and cold/warm searcher build time for a 2000-page vault whose
// pages sit at 20-component paths. Run sequentially, one checkout at a time, on an otherwise idle machine:
//   BA17_ROOT=<checkout> node tests/acceptance/BA-17/bench-cache.mjs
// Prints one JSON object with the median of REPS runs. Page contents are synthetic; no user data is read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadRetrieval, NOW } from './support.mjs';

const { createSearcher } = await loadRetrieval();
const PAGES = 2000, DEPTH = 20, REPS = 3;
const dirs = Array.from({ length: DEPTH - 1 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`).join('/');
const filler = 'The pipeline keeps retry state, rotates keys and records the outcome for review. '.repeat(7);

function makeVault(home) {
  const vault = path.join(home, 'vault');
  const dir = path.join(vault, dirs);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PAGES; i++) {
    const name = `item-${String(i).padStart(4, '0')}-handler-x-${i % 97}.md`;
    const rel = `${dirs}/${name}`;
    fs.writeFileSync(path.join(vault, dirs, name), `---\ntitle: Item ${i}\n---\n# Item ${i}\nE_ITEM_${i} lives in src/lib/mod-${i % 50}.mjs at v1.${i % 9}.0. Path ${rel}. ${filler}\n`);
  }
  return vault;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba17-bench-'));
try {
  const vault = makeVault(home);
  const cold = [], warm = [], sizes = [];
  let search1 = null;
  for (let r = 0; r < REPS; r++) {
    const stateDir = path.join(home, `state-${r}`);
    let t0 = performance.now();
    createSearcher({ vaultDir: vault, stateDir, now: NOW });
    cold.push(performance.now() - t0);
    const cache = path.join(stateDir, 'retrieval-index.json');
    sizes.push(fs.statSync(cache).size);
    t0 = performance.now();
    const s = createSearcher({ vaultDir: vault, stateDir, now: NOW });
    warm.push(performance.now() - t0);
    if (!search1) {
      const q = s.search('item-0013-handler-x-13.md', { limit: 5, abstainThreshold: 0, asOf: NOW });
      search1 = { reason: q.reason, top: q.results.length };
    }
  }
  console.log(JSON.stringify({
    checkout: process.env.BA17_LABEL ?? 'unlabeled',
    pages: PAGES, componentsPerPath: DEPTH, reps: REPS,
    cacheBytesMedian: median(sizes), coldBuildMsMedian: Math.round(median(cold)), warmLoadMsMedian: Math.round(median(warm)),
    sampleSearch: search1,
  }, null, 2));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
