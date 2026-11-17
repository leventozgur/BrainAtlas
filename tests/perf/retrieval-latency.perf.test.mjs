// SPDX-License-Identifier: MIT
// Performance suite: warm retrieval latency on 2,000-page synthetic vaults. These tests compare a measured
// median with a fixed budget, so they run only in the `perf` CI job (`npm run test:perf`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createSearcher } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2025-01-01T00:00:00.000Z');

function temp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('warm query median on 2000-page vault is under 300 ms', (t) => {
  const dir = temp(t, 'core-retrieval-acceptance-'),
    vault = path.join(dir, 'vault'),
    state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  for (let i = 0; i < 2000; i++)
    fs.writeFileSync(
      path.join(vault, `${i}.md`),
      `---\ntitle: Topic ${i}\n---\n# Topic ${i}\nSynthetic common content ${i}.`
    );
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    searcher.search('topic 1234');
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  t.diagnostic(`Warm query median: ${timings[2].toFixed(2)} ms`);
  assert.ok(timings[2] < 300, `median ${timings[2]} ms`);
});

test('warm query median stays below 300 ms on a 2000-page synthetic vault', (t) => {
  const dir = temp(t, 'c2-retrieval-acceptance-'),
    vault = path.join(dir, 'vault'),
    state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  for (let i = 0; i < 2000; i++)
    fs.writeFileSync(
      path.join(vault, `${String(i).padStart(4, '0')}.md`),
      `---\ntitle: Topic ${i}\n---\nSynthetic common content number ${i}.`
    );
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  for (let i = 0; i < 2; i++) searcher.search('topic 1234');
  const timings = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    searcher.search('topic 1234');
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  t.diagnostic(`Warm 2000-page query median: ${median.toFixed(2)} ms`);
  assert.ok(median < 300, `median ${median.toFixed(2)} ms`);
});

test('2000-page warm queries stay under 300 ms with section selection enabled', (t) => {
  const dir = temp(t, 'q-section-acceptance-'),
    vault = path.join(dir, 'vault'),
    state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  for (let i = 0; i < 2000; i++) {
    fs.writeFileSync(
      path.join(vault, `${String(i).padStart(4, '0')}.md`),
      `---\ntitle: Topic ${i}\n---\n# Overview\ncommon synthetic evidence ${i}\n## Detail\nquerytarget ${i}`
    );
  }
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  for (let i = 0; i < 2; i++) searcher.search('querytarget 1234');
  const timings = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    searcher.search('querytarget 1234');
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  t.diagnostic(`Q-SECTION warm 2000-page median: ${median.toFixed(2)} ms`);
  assert.ok(median < 300, `median ${median.toFixed(2)} ms`);
});
