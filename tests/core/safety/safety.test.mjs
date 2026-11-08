// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { scanText, scanPath, redact, fingerprintSafetyFinding, isSafetyFindingAllowed } from '../../../packages/core/src/safety/index.mjs';
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
test('path deny table blocks sensitive names but permits Markdown slugs containing secret', () => {
  const denied = [
    '.env', '.env.local', '.envbackup', 'dir/.ENV.local', 'dir\\.ssh\\config', './.git/config',
    'dir/id_rsa.pub', 'secret.md', 'nested/secrets.md', 'secret.txt', 'secrets.json', 'secrets.data.json',
    'x/file.secret', 'x/file.secrets', 'client_secret_notes.md', 'a/file.PEM', 'a/file.key', 'bundle.p12',
    '.npmrc', 'credentials.json', 'nested/credentials-prod.json',
  ];
  for (const path of denied) assert.equal(scanPath(path).length > 0, true, `expected path to be denied: ${path}`);
  const allowed = [
    'wiki/concepts/team-secret-rotation-notes-v0.md', 'wiki/concepts/client-secret.md',
    'wiki/concepts/secret-notes.md', 'wiki/concepts/secrets-of-memory.md', 'wiki/concepts/secret.v0.md',
    'docs/readme.md', 'dir/environment.txt',
  ];
  for (const path of allowed) assert.deepEqual(scanPath(path), [], `expected path to be allowed: ${path}`);
  assert.ok(scanPath('nested/private/file.txt', { extraDenyGlobs: ['private/**'] }).length);
  assert.ok(scanPath('.env', { denyGlobs: [] }).length);
});
test('fingerprints identify content bytes and path findings without exposing matched text', () => {
  const original = 'title\nsecret: "S-ALLOW-original-9XyZaBcDeFgH"\n';
  const finding = scanText(original).find(row => row.ruleId === 'secret-assignment');
  assert.ok(finding);
  const fingerprint = fingerprintSafetyFinding('wiki/concepts/entry.md', original, finding);
  assert.deepEqual(Object.keys(fingerprint).sort(), ['path', 'ruleId', 'sha256']);
  assert.equal(isSafetyFindingAllowed('wiki/concepts/entry.md', original, finding, [fingerprint]), true);
  const changed = `${original}secret: "S-ALLOW-new-37QwErTyUiOpL"\n`;
  const changedFinding = scanText(changed).at(-1);
  assert.equal(isSafetyFindingAllowed('wiki/concepts/entry.md', changed, changedFinding, [fingerprint]), false);
  const pathFinding = scanPath('secret.md')[0];
  const pathFingerprint = fingerprintSafetyFinding('secret.md', '', pathFinding);
  assert.deepEqual(pathFingerprint, { path: 'secret.md', ruleId: 'denied-path' });
  assert.equal(isSafetyFindingAllowed('secret.md', '', pathFinding, [pathFingerprint]), true);
});
test('one megabyte and adversarial input remain bounded', () => {
  const inputs = ['ordinary words '.repeat(70000), 'a'.repeat(1024 * 1024), ('a='.repeat(350000))];
  for (const text of inputs) {
    const start = performance.now();
    scanText(text);
    assert.ok(performance.now() - start < 200, 'scan exceeded 200 ms');
  }
});
