// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');

export function mainRoot() {
  if (process.env.BA26_MAIN) return path.resolve(process.env.BA26_MAIN);
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: HERE, encoding: 'utf8' }).trim();
  return path.dirname(path.resolve(HERE, common));
}
