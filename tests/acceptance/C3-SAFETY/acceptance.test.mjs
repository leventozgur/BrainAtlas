// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { scanPath, scanText, redact } from '../../../packages/core/src/safety/index.mjs';
import { boundaryExamples, negativeHoldout, positiveHoldout } from './fixtures/holdout.mjs';

test('unseen synthetic holdout reports leakage and false-positive rates', (t) => {
  assert.ok(positiveHoldout.length >= 60, 'holdout must contain at least 60 positive samples');
  assert.ok(negativeHoldout.length >= 60, 'holdout must contain at least 60 negative samples');

  let detected = 0;
  let falsePositives = 0;
  for (const sample of positiveHoldout) {
    if (scanText(sample.text).length) detected++;
  }
  for (const sample of negativeHoldout) {
    if (scanText(sample.text).length) falsePositives++;
  }

  const leaked = positiveHoldout.length - detected;
  const leakRate = leaked / positiveHoldout.length;
  const falsePositiveRate = falsePositives / negativeHoldout.length;
  t.diagnostic(`holdout positives=${positiveHoldout.length}, detected=${detected}, leaked=${leaked}, leak_rate=${(100 * leakRate).toFixed(2)}%`);
  t.diagnostic(`holdout negatives=${negativeHoldout.length}, false_positives=${falsePositives}, false_positive_rate=${(100 * falsePositiveRate).toFixed(2)}%`);

  assert.ok(leakRate <= 0.196, 'holdout leakage rate exceeds the 19.6% ceiling');
  assert.equal(falsePositives, 0, 'known non-secret holdout sample was flagged');
});

test('findings contain offsets and rule IDs only; redaction removes each synthetic credential', () => {
  for (const sample of positiveHoldout) {
    const findings = scanText(sample.text);
    const serialized = JSON.stringify(findings);
    const redacted = redact(sample.text);
    assert.ok(findings.length > 0, 'positive sample was not detected');
    for (const finding of findings) {
      assert.deepEqual(Object.keys(finding).sort(), ['end', 'kind', 'ruleId', 'start']);
      assert.equal(finding.kind, 'content');
      assert.ok(Number.isInteger(finding.start) && Number.isInteger(finding.end));
      assert.ok(finding.start >= 0 && finding.end > finding.start && finding.end <= sample.text.length);
    }
    for (const secret of sample.secrets) {
      assert.ok(!serialized.includes(secret), 'finding serialization contains a matched value');
      assert.ok(!redacted.includes(secret), 'redacted output retains a synthetic credential');
    }
  }
});

test('content scanner handles rule boundaries, placeholders, custom rules, and malformed input', () => {
  assert.ok(scanText(boundaryExamples.openAiAtMinimum).length > 0, 'minimum provider token length was missed');
  assert.equal(scanText(boundaryExamples.openAiBelowMinimum).length, 0, 'below-minimum provider token was flagged');

  assert.ok(scanText(boundaryExamples.awsAtMinimum).length > 0, 'minimum access-key length was missed');
  assert.equal(scanText(boundaryExamples.awsBelowMinimum).length, 0, 'below-minimum access-key length was flagged');

  assert.equal(scanText(boundaryExamples.apiKeyPlaceholder).length, 0, 'environment placeholder was flagged');
  assert.equal(scanText('max_tokens=120000').length, 0, 'ordinary token limit was flagged');
  assert.ok(scanText(boundaryExamples.passwordAssignment).length > 0, 'explicit password assignment was missed');
  assert.equal(scanText('ordinary text', { rules: [{ id: 'empty', pattern: /(?:)/g }] }).length, 0, 'zero-width custom rule emitted a finding');

  const overlap = redact(boundaryExamples.overlapAssignment, { rules: [{ id: 'whole-assignment', pattern: /secret=[^\s]+/g }] });
  assert.equal(overlap, '[REDACTED:whole-assignment]', 'overlapping matches were not collapsed safely');

  assert.throws(() => scanText(null), TypeError);
  assert.throws(() => scanText('safe', { rules: [{ id: 'bad', pattern: 'literal' }] }), TypeError);
  assert.throws(() => scanPath(null), TypeError);
  assert.throws(() => redact(undefined), TypeError);
  assert.equal(scanText('\uD800').length, 0, 'unpaired surrogate caused an unexpected finding');

  const sample = positiveHoldout[0];
  let thrown;
  try { scanText({ malformed: sample.text }); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof TypeError, 'malformed input did not fail with TypeError');
  assert.ok(sample.secrets.every((secret) => !String(thrown).includes(secret)), 'malformed-input error leaked a value');
});

test('path scanner denies sensitive paths across separators and case, with traversal and extra globs', () => {
  const denied = [
    '.env', './.env.local', 'a\\b\\id_rsa', 'CREDENTIALS.json', '.git/config', '.ssh/known_hosts',
    'CONFIG/.ENV', 'A\\B\\ID_ED25519', 'nested/credentials.backup', '../.env', 'sub/../../.ssh/id_rsa',
  ];
  for (const path of denied) {
    const findings = scanPath(path);
    assert.ok(findings.length > 0, 'sensitive path was allowed');
    for (const finding of findings) {
      assert.deepEqual(finding, { ruleId: 'denied-path', kind: 'path', start: 0, end: path.length });
    }
  }
  for (const path of ['docs/readme.md', 'src/config/example.json', 'notes/tokens.md']) {
    assert.equal(scanPath(path).length, 0, 'ordinary path was denied');
  }

  const extra = scanPath('private/cache7.json', { extraDenyGlobs: ['private/**/cache?.json'] });
  assert.ok(extra.length > 0, 'extraDenyGlobs was ignored');
  assert.equal(scanPath('private/cache77.json', { extraDenyGlobs: ['private/**/cache?.json'] }).length, 0, 'extra glob wildcard boundary was too broad');
  assert.throws(() => scanPath('safe.txt', { extraDenyGlobs: [null] }), TypeError);
});

test('scanner output and errors do not log secrets or touch HOME, symlink targets, or outside files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'c3-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolatedHome = join(root, 'home');
  const sandbox = join(root, 'sandbox');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(isolatedHome), mkdir(sandbox), mkdir(outside)]);
  const outsideFile = join(outside, 'sentinel.txt');
  await writeFile(outsideFile, 'synthetic sentinel remains unchanged\n', 'utf8');
  await symlink(outside, join(sandbox, 'linked-outside'));

  const sample = positiveHoldout.find((item) => item.secrets.length > 0);
  const childScript = [
    `import { readFileSync } from 'node:fs';`,
    `const api = await import(${JSON.stringify(new URL('../../../packages/core/src/safety/index.mjs', import.meta.url).href)});`,
    `const sample = JSON.parse(readFileSync(0, 'utf8'));`,
    `const findings = api.scanText(sample.text);`,
    `const redacted = api.redact(sample.text);`,
    `api.scanPath('../.env'); api.scanPath('linked-outside/sentinel.txt');`,
    `process.stdout.write(JSON.stringify({ findings, redacted }) + '\\n');`,
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: sandbox,
    env: { PATH: process.env.PATH ?? '', HOME: isolatedHome, USERPROFILE: isolatedHome, XDG_CONFIG_HOME: isolatedHome, TMPDIR: root },
    input: JSON.stringify(sample),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.status, 0, 'isolated scanner process failed');
  assert.ok(!child.error, 'isolated scanner process reported an error');
  let result;
  try { result = JSON.parse(child.stdout); } catch { assert.fail('scanner output was not valid structured JSON (contents suppressed)'); }
  const allOutput = `${child.stdout}\n${child.stderr}`;
  assert.ok(sample.secrets.every((secret) => !allOutput.includes(secret)), 'synthetic secret appeared in process output or logs');
  assert.ok(sample.secrets.every((secret) => !JSON.stringify(result.findings).includes(secret)), 'structured findings contain a matched value');
  assert.ok(sample.secrets.every((secret) => !result.redacted.includes(secret)), 'child redaction retained a matched value');
  assert.deepEqual(await readdir(isolatedHome), [], 'scanner created a file in isolated HOME');
  assert.equal(await readFile(outsideFile, 'utf8'), 'synthetic sentinel remains unchanged\n', 'scanner modified an outside sentinel');
  assert.ok((await readdir(sandbox)).includes('linked-outside'), 'test symlink disappeared unexpectedly');
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
