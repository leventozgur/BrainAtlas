// SPDX-License-Identifier: MIT
// BA-26 blind acceptance, hypotheses 1 and 2 (capture and false positives). Black-box: calls the product safety module
// only. Labels come from labels.json, frozen before the first product run; thresholds are fixed by the brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtures, labelsOf, digestOf } from './gen.mjs';

const WT = fileURLToPath(new URL('../../../', import.meta.url));
const safety = await import(pathToFileURL(WT + 'packages/core/src/safety/index.mjs').href);
const frozen = JSON.parse(readFileSync(new URL('./labels.json', import.meta.url), 'utf8'));
const { positives, contacts, cleanItems } = fixtures();

test('fixtures are identical to the frozen labels (no label drift)', () => {
  assert.equal(digestOf(labelsOf([...positives, ...contacts, ...cleanItems])), frozen.digest);
  assert.ok(positives.length >= 50, 'at least 50 positives');
  assert.ok(cleanItems.length >= 200, 'at least 200 hard-clean pieces');
});

test('H1 capture: scanText finds each positive with its expected rule (rate >= 0.95)', (t) => {
  const misses = [];
  let hits = 0;
  const byCat = {};
  const leaks = [];
  for (const it of positives) {
    const findings = safety.scanText(it.text);
    const ok = findings.some((f) => f.ruleId === it.expected);
    byCat[it.cat] ??= { n: 0, hit: 0 };
    byCat[it.cat].n++;
    if (ok) { hits++; byCat[it.cat].hit++; } else misses.push(`${it.id} fmt=${it.fmt} expected=${it.expected} got=[${findings.map((f) => f.ruleId)}]`);
    // Redaction of the same content must not keep a raw matched value (BA-16 rule: redact before any cut).
    const redacted = safety.redact(it.text);
    for (const f of findings) {
      const raw = it.text.slice(f.start, f.end);
      if (raw && redacted.includes(raw)) leaks.push(`${it.id} ${f.ruleId}`);
    }
  }
  const rate = hits / positives.length;
  t.diagnostic(`H1 scanText positives: ${hits}/${positives.length} = ${rate.toFixed(4)}`);
  for (const [cat, v] of Object.entries(byCat)) t.diagnostic(`  ${cat}: ${v.hit}/${v.n}`);
  for (const m of misses) t.diagnostic(`  miss ${m}`);
  assert.deepEqual(leaks, [], 'raw matched values survived redact()');
  assert.ok(rate >= 0.95, `capture rate ${rate.toFixed(4)} < 0.95`);
});

test('H1b contact redaction: redact(personal) removes every e-mail and TR phone (rate >= 0.95)', (t) => {
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const phoneRe = /(?:\+90|0)[ -]?\(?5[0-9]{2}\)?[ -]?[0-9]{3}[ -]?[0-9]{2}[ -]?[0-9]{2}/;
  const misses = [];
  let hits = 0;
  for (const it of contacts) {
    const out = safety.redact(it.text, { personal: true });
    const marker = out.includes(`[REDACTED:${it.expected}]`);
    const residue = emailRe.test(out) || phoneRe.test(out);
    if (marker && !residue) hits++;
    else misses.push(`${it.id} fmt=${it.fmt} marker=${marker} residue=${residue}`);
  }
  const rate = hits / contacts.length;
  t.diagnostic(`H1b contact redaction: ${hits}/${contacts.length} = ${rate.toFixed(4)}`);
  for (const m of misses) t.diagnostic(`  miss ${m}`);
  // Without the personal option, contact data is not a scanText finding (write path does not block it).
  const noOpt = contacts.filter((it) => safety.scanText(it.text).length > 0).length;
  t.diagnostic(`H1b scanText findings on contact items (must be 0 for write path): ${noOpt}`);
  assert.ok(rate >= 0.95, `contact redaction rate ${rate.toFixed(4)} < 0.95`);
});

test('H2 false positives: hard-clean pieces with any scanText finding (rate <= 0.02)', (t) => {
  const flagged = [];
  for (const it of cleanItems) {
    const findings = safety.scanText(it.text);
    if (findings.length) flagged.push(`${it.id} [${findings.map((f) => f.ruleId).join(',')}]`);
  }
  const rate = flagged.length / cleanItems.length;
  const byCat = {};
  for (const it of cleanItems) byCat[it.cat] ??= { n: 0, fp: 0 };
  for (const f of flagged) {
    const id = f.split(' ')[0];
    const it = cleanItems.find((x) => x.id === id);
    byCat[it.cat].fp++;
  }
  for (const it of cleanItems) byCat[it.cat].n++;
  t.diagnostic(`H2 hard-clean pieces: ${cleanItems.length}, flagged: ${flagged.length}, rate ${rate.toFixed(4)}`);
  for (const [cat, v] of Object.entries(byCat)) t.diagnostic(`  ${cat}: ${v.fp}/${v.n}`);
  for (const f of flagged) t.diagnostic(`  flagged ${f}`);
  assert.ok(rate <= 0.02, `false-positive rate ${rate.toFixed(4)} > 0.02`);
});

test('H2b clean pieces through redact(personal): contact markers only where the text has contact data', (t) => {
  // Observation for the parity and hook-output reviews; the brief's threshold is H2 above.
  let markers = 0;
  for (const it of cleanItems) if (/\[REDACTED:/.test(safety.redact(it.text, { personal: true }))) markers++;
  t.diagnostic(`H2b clean pieces with any REDACTED marker under personal redact: ${markers}`);
});
