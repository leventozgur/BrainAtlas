// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { scanText, redact } from '../../packages/core/src/safety/index.mjs';

test('one megabyte and adversarial input remain bounded', () => {
  const inputs = ['ordinary words '.repeat(70000), 'a'.repeat(1024 * 1024), 'a='.repeat(350000)];
  for (const text of inputs) {
    const start = performance.now();
    scanText(text);
    assert.ok(performance.now() - start < 200, 'scan exceeded 200 ms');
  }
});

test('BA-26 patterns stay bounded on long adversarial runs (secret and output paths)', () => {
  const inputs = [
    'a_'.repeat(50000),
    'ado_'.repeat(20000),
    'a@' + 'a.'.repeat(20000),
    'sv=2021-06-08'.repeat(5000),
    'Authorization: Bearer '.repeat(3000),
    'AccountKey='.repeat(8000),
    'TR12'.repeat(10000),
    'AKIA'.repeat(20000),
  ];
  for (const text of inputs) {
    const start = performance.now();
    scanText(text);
    redact(text, { personal: true });
    assert.ok(performance.now() - start < 1000, `slow input starting ${text.slice(0, 20)}`);
  }
});

test('scanner stays within the ReDoS and 1 MB latency limits', (t) => {
  const adversarialInputs = ['a'.repeat(100_000), 'aaaa='.repeat(20_000), '='.repeat(100_000)];
  const adversarialStart = performance.now();
  for (const text of adversarialInputs) scanText(text);
  const adversarialMs = performance.now() - adversarialStart;
  t.diagnostic(`three 100 KB adversarial scans=${adversarialMs.toFixed(2)} ms (limit < 500 ms)`);
  assert.ok(adversarialMs < 500, `100 KB adversarial scans exceeded 500 ms (${adversarialMs.toFixed(1)} ms)`);

  const largeText = 'ordinary documentation line without credentials\n'.repeat(22_000);
  assert.ok(largeText.length >= 1_000_000, 'large scan fixture is smaller than 1 MB');
  const largeStart = performance.now();
  scanText(largeText);
  const largeMs = performance.now() - largeStart;
  t.diagnostic(`1 MB scan=${largeMs.toFixed(2)} ms (limit < 200 ms)`);
  assert.ok(largeMs < 200, `1 MB scan exceeded 200 ms (${largeMs.toFixed(1)} ms)`);
});

test('fix1 ReDoS guard: adversarial query strings complete quickly (not a p95 measurement)', (t) => {
  const cases = {
    manyPairs: 'https://a.example/?' + 'a='.repeat(60000),
    longKey: '?' + 'k'.repeat(200000) + '=',
    longAmp: '&x=' + 'y'.repeat(200000),
    semiPairs: '?a=b;'.repeat(50000),
    keyNoEq: '?' + 'sifre'.repeat(30000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const start = Date.now();
    scanText(text);
    const ms = Date.now() - start;
    t.diagnostic(`${name}: ${text.length} chars, ${ms} ms`);
    assert.ok(ms < 3000, `${name} took ${ms} ms`);
  }
});
