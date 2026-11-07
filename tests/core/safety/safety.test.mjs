// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { scanText, scanPath, redact } from '../../../packages/core/src/safety/index.mjs';
import { metrics } from './metrics.mjs';
const fixtures = new URL('./fixtures/', import.meta.url);

test('synthetic corpus meets recall and false-positive thresholds', async () => {
  const result = await metrics(fixtures.pathname);
  assert.ok(result.recall >= 0.95, `recall ${result.recall}`);
  assert.ok(result.falsePositiveRate <= 0.05, `false positive rate ${result.falsePositiveRate}`);
});
test('separate holdout meets recall and false-positive thresholds', async () => {
  const result = await metrics(new URL('holdout/', fixtures).pathname);
  assert.ok(result.recall >= 0.95);
  assert.ok(result.falsePositiveRate <= 0.05);
});
test('findings contain only metadata and redact overlapping findings completely', async () => {
  const text = await readFile(new URL('positive/16.txt', fixtures), 'utf8');
  const findings = scanText(text);
  assert.ok(findings.length);
  for (const finding of findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['end', 'kind', 'ruleId', 'start']);
    assert.equal(finding.kind, 'content');
    assert.ok(finding.start >= 0 && finding.end <= text.length && finding.end > finding.start);
    assert.ok(!redact(text).includes(text.slice(finding.start, finding.end)));
  }
  assert.match(redact(text), /\[REDACTED:[a-z-]+\]/);
});
test('private key block and custom rules are redacted', async () => {
  const text = await readFile(new URL('positive/18.txt', fixtures), 'utf8');
  assert.match(redact(text), /^\[REDACTED:private-key\]/);
  assert.equal(redact('custom-value', { rules: [{ id: 'custom', pattern: /custom-value/ }] }), '[REDACTED:custom]');
});
test('deny patterns match nested and normalized paths and additive globs', () => {
  for (const path of ['.env', 'dir/.ENV.local', 'dir\\.ssh\\config', './.git/config', 'dir/id_rsa.pub', 'x/SECRETS.txt', 'a/file.PEM', '.npmrc', 'credentials.json']) assert.ok(scanPath(path).length, path);
  assert.ok(scanPath('nested/private/file.txt', { extraDenyGlobs: ['private/**'] }).length);
  assert.ok(scanPath('.env', { denyGlobs: [] }).length);
  assert.deepEqual(scanPath('dir/environment.txt'), []);
});
test('one megabyte and adversarial input remain bounded', () => {
  const inputs = ['ordinary words '.repeat(70000), 'a'.repeat(1024 * 1024), ('a='.repeat(350000))];
  for (const text of inputs) {
    const start = performance.now();
    scanText(text);
    assert.ok(performance.now() - start < 200, 'scan exceeded 200 ms');
  }
});
