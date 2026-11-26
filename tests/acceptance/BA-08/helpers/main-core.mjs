// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAIN_COMMIT = '6cac7a7';
const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../../..');

export async function loadMainRetrieval() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba08-main-'));
  const tarFile = path.join(dir, 'main.tar');
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(tree);
  try {
    execFileSync(
      'git',
      ['-C', repoRoot, 'archive', '--format=tar', '-o', tarFile, MAIN_COMMIT, 'package.json', 'packages/core/src'],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    execFileSync('tar', ['-xf', tarFile, '-C', tree], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    const retrieval = await import(pathToFileURL(path.join(tree, 'packages/core/src/retrieval/index.mjs')).href);
    return { retrieval, dir };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Cannot load main ${MAIN_COMMIT} retrieval module: ${error.code ?? 'error'}`, { cause: error });
  }
}

export function dispose(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function loadWorktreeRetrieval() {
  const root = process.env.BA08_PRODUCT_ROOT || repoRoot;
  return import(pathToFileURL(path.join(root, 'packages/core/src/retrieval/index.mjs')).href);
}
