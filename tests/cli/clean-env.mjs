// SPDX-License-Identifier: MIT
const KEEP = new Set(['BRAINATLAS_TEST_CLOCK_SHIFT_DAYS']);

export function cleanEnv(overrides = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => (!key.startsWith('XDG_') && !key.startsWith('BRAINATLAS_')) || KEEP.has(key)
    )
  );
  return { ...env, ...overrides };
}
