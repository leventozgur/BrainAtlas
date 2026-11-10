// SPDX-License-Identifier: MIT
// Shared helpers for BA-00 blind acceptance tests. Test-only; never imported by product code.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..', '..');
export const EVAL = join(ROOT, 'eval');
export const DEV = join(EVAL, 'dev');
export const CORPUS_BA = join(EVAL, 'corpus-ba');
export const PRELOAD = pathToFileURL(join(here, 'no-network-preload.mjs')).href;
export const DEFAULT_NOW = '2026-11-10T00:00:00Z';

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `ba00-${prefix}-`));
}

export function listDir(dir) {
  return readdirSync(dir);
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Run a node script in a child process. The child never inherits node:test's context variable.
 * @param {string[]} args script path (absolute) followed by its arguments
 * @param {{env?:object, cwd?:string, preload?:boolean}} [options]
 */
export function runNode(args, { env = {}, cwd = ROOT, preload = false } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const execArgs = preload ? ['--import', PRELOAD, ...args] : args;
  return spawnSync(process.execPath, execArgs, { cwd, env: childEnv, encoding: 'utf8' });
}

export function git(args, cwd = ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}
