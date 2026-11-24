// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PRELOAD = fileURLToPath(new URL('./shift-clock.mjs', import.meta.url));
const PRELOAD_URL = new URL('./shift-clock.mjs', import.meta.url).href;
const DAY = 24 * 60 * 60 * 1000;
const FIXED = 1700000000000;

test('shift-clock preload shifts Date() and new Date(), keeps Date(value) and statics intact', () => {
  const script = `
    const fixed = ${FIXED};
    // performance.timeOrigin is the real epoch and is not affected by the Date patch.
    const realNow = performance.timeOrigin + performance.now();
    const zero = new Date();
    const call = Date();
    const shifted = Date.now();
    const parsed = Date.parse('2023-11-14T22:13:20.000Z');
    const utc = Date.UTC(2023, 10, 14, 22, 13, 20);
    const iso = new Date(fixed).toISOString();
    process.stdout.write(JSON.stringify({
      realNow,
      zero: zero.getTime(),
      shifted,
      call,
      parsed,
      utc,
      iso,
      nodeOptions: process.env.NODE_OPTIONS || '',
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      BRAINATLAS_TEST_CLOCK_SHIFT_DAYS: '1',
      NODE_OPTIONS: `--import ${PRELOAD}`,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.ok(Math.abs(out.shifted - out.realNow - DAY) < 5000, 'Date.now() is shifted by one day');
  assert.ok(Math.abs(out.zero - out.realNow - DAY) < 5000, 'new Date() is shifted by one day');
  assert.equal(typeof out.call, 'string', 'Date() as a function still returns a string');
  assert.equal(out.parsed, FIXED, 'Date.parse is untouched');
  assert.equal(out.utc, FIXED, 'Date.UTC is untouched');
  assert.equal(out.iso, '2023-11-14T22:13:20.000Z', 'new Date(value) is untouched');
  assert.match(out.nodeOptions, /shift-clock\.mjs/, 'NODE_OPTIONS is propagated to children');
});

test('clockShiftEnv appends the preload to an existing NODE_OPTIONS without duplicating it', () => {
  const script = `
    const { clockShiftEnv } = await import(${JSON.stringify(PRELOAD_URL)});
    const withExisting = clockShiftEnv({ NODE_OPTIONS: '--max-old-space-size=64' });
    const twice = clockShiftEnv({ NODE_OPTIONS: withExisting.NODE_OPTIONS });
    const pathVariant = clockShiftEnv({ NODE_OPTIONS: '--import ' + ${JSON.stringify(PRELOAD)} });
    process.stdout.write(JSON.stringify({ withExisting, twice, pathVariant }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, BRAINATLAS_TEST_CLOCK_SHIFT_DAYS: '1', NODE_OPTIONS: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.withExisting.NODE_OPTIONS, `--max-old-space-size=64 --import ${PRELOAD_URL}`);
  assert.equal(out.withExisting.BRAINATLAS_TEST_CLOCK_SHIFT_DAYS, '1');
  assert.equal(out.twice.NODE_OPTIONS, out.withExisting.NODE_OPTIONS, 'the preload is not duplicated');
  assert.equal(out.pathVariant.NODE_OPTIONS, `--import ${PRELOAD}`, 'a path-form preload is not duplicated');
});
