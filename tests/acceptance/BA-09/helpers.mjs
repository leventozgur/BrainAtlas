// SPDX-License-Identifier: MIT
// BA-09 independent acceptance helpers (test-only). The candidate is the worktree retrieval module. The reference is main
// commit 111732b, extracted at test time with `git archive` into a private temporary directory; no checkout, branch change
// or repository write happens, and no golden file is stored.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAIN_COMMIT = '111732b';
const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');
export const NOW = new Date('2026-11-10T00:00:00Z');

export async function loadCandidate() {
  return import(pathToFileURL(path.join(repoRoot, 'packages/core/src/retrieval/index.mjs')).href);
}

/** Extracts packages/core/src of MAIN_COMMIT and imports its retrieval module. Call `dispose()` when done. */
export async function loadMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba09-main-'));
  const tarFile = path.join(dir, 'main.tar');
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  try {
    execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', '-o', tarFile, MAIN_COMMIT, 'package.json', 'packages/core/src'], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('tar', ['-xf', tarFile, '-C', tree], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    const retrieval = await import(pathToFileURL(path.join(tree, 'packages/core/src/retrieval/index.mjs')).href);
    return { retrieval, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Cannot load main ${MAIN_COMMIT} retrieval module: ${error.code ?? 'error'}`);
  }
}

/** Writes {relative path: content} into a fresh temporary vault and returns its directory. */
export function makeVault(files, prefix = 'ba09-vault-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeVault(dir, files);
  return dir;
}

export function writeVault(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Provenance record block (list item form) with overrides; each value is raw YAML text. */
export function record({ date = '"2026-11-01"', evidence = '"review note"', scope = '"production-like"', source = '"raw/a-evidence.md"' } = {}) {
  return `verified:\n  - date: ${date}\n    evidence: ${evidence}\n    scope: ${scope}\n    source: ${source}\n`;
}

/** A page with optional raw frontmatter lines (already YAML) and a body. */
export function page({ title = 'Probe', fm = '', body = 'zephyr quorum ledger reconciliation.' } = {}) {
  return `---\ntitle: "${title}"\n${fm}---\n${body}\n`;
}

export const pathsOf = (results) => results.map((r) => r.path);
