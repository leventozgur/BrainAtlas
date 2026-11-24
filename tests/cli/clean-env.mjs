// SPDX-License-Identifier: MIT
// Keep the opt-in clock shift so spawned CLI processes read the same shifted clock as the test.
const KEEP = new Set(['BRAINATLAS_TEST_CLOCK_SHIFT_DAYS']);

/** Inherit ordinary process settings while isolating XDG and BrainAtlas state. */
export function cleanEnv(overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => (!key.startsWith('XDG_') && !key.startsWith('BRAINATLAS_')) || KEEP.has(key)
    )
  );
  return { ...env, ...overrides };
}
