// SPDX-License-Identifier: MIT
// Test-only NODE_OPTIONS preload: make worker retrieval exceed the hook deadline.
import fs from 'node:fs';

const originalReadFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = function slowVaultRead(path, ...args) {
  if (typeof path === 'string' && path.endsWith('.md')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5200);
  }
  return originalReadFileSync(path, ...args);
};
