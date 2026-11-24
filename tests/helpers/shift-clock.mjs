// SPDX-License-Identifier: MIT
// Opt-in preload: run the test suite as if it were BRAINATLAS_TEST_CLOCK_SHIFT_DAYS days later.
// Shifted clocks are propagated to spawned child processes through NODE_OPTIONS.
import { fileURLToPath } from 'node:url';

const shiftDays = Number(process.env.BRAINATLAS_TEST_CLOCK_SHIFT_DAYS);
const DAY = 24 * 60 * 60 * 1000;
const ACTIVE = Number.isFinite(shiftDays) && shiftDays !== 0;

if (ACTIVE) {
  const offset = shiftDays * DAY;
  const RealDate = Date;
  const shiftedNow = () => RealDate.now() + offset;
  // A class cannot shadow Date() called as a function (it throws without `new`), so proxy the
  // real constructor: only the zero-argument form is shifted and Date() still returns a string.
  const ShiftedDate = new Proxy(RealDate, {
    apply() {
      return new RealDate(shiftedNow()).toString();
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [shiftedNow()] : args, newTarget);
    },
    get(target, property, receiver) {
      if (property === 'now') return shiftedNow;
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = ShiftedDate;

  const preload = `--import ${import.meta.url}`;
  const current = process.env.NODE_OPTIONS || '';
  if (!hasPreload(current)) {
    process.env.NODE_OPTIONS = [current, preload].filter(Boolean).join(' ');
  }
}

/** Whether NODE_OPTIONS already loads this preload, whether it names the path or the file URL. */
function hasPreload(value) {
  return value.includes(import.meta.url) || value.includes(fileURLToPath(import.meta.url));
}

/** Carry the clock shift into a hand-built child env, since such envs bypass process.env inheritance. */
export function clockShiftEnv(env = {}) {
  if (!ACTIVE) return env;
  const preload = `--import ${import.meta.url}`;
  const existing = env.NODE_OPTIONS || '';
  return {
    ...env,
    NODE_OPTIONS: hasPreload(existing) ? existing : [existing, preload].filter(Boolean).join(' '),
    BRAINATLAS_TEST_CLOCK_SHIFT_DAYS: String(shiftDays),
  };
}
