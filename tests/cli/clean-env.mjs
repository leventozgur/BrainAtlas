// SPDX-License-Identifier: MIT
/** Inherit ordinary process settings while isolating XDG and BrainAtlas state. */
export function cleanEnv(overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('XDG_') && !key.startsWith('BRAINATLAS_')));
  return { ...env, ...overrides };
}
