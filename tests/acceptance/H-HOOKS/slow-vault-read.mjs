// SPDX-License-Identifier: MIT
import fs from 'node:fs';

const originalReadFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = function slowVaultRead(path, ...args) {
  if (typeof path === 'string' && path.endsWith('.md')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5200);
  }
  return originalReadFileSync(path, ...args);
};
