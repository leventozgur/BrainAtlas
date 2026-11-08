// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function signRelease(key, checksums) {
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'brainatlas-release', checksums], { stdio: 'ignore' });
  return `${checksums}.sig`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 4) throw new Error('Usage: sign.mjs <key> <SHA256SUMS>'); signRelease(process.argv[2], process.argv[3]); }
  catch { console.error('E_SIGNATURE: Could not sign checksums.'); process.exitCode = 1; }
}
