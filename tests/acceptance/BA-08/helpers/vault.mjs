// SPDX-License-Identifier: MIT
// Temporary vault helpers for the BA-08 acceptance tests. Every directory lives under the OS temporary directory and is
// removed by the test that created it; HOME is redirected for the lifetime of a test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isolateHome(prefix) {
  const saved = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  process.env.HOME = home;
  return () => {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  };
}

/** Creates {dir, vault, state} with the given files (relative path -> content). Removed when the test ends. */
export function makeVault(t, files, prefix = 'ba08') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault');
  const state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.mkdirSync(state);
  writeFiles(vault, files);
  return { dir, vault, state, cache: path.join(state, 'retrieval-index.json') };
}

export function writeFiles(vault, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(vault, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
}

/** Sorted neighbour paths of a page in an index built by buildIndex; null when the page is not indexed. */
export function neighbourPaths(index, file) {
  const id = index.docs.findIndex(d => d.page.path === file);
  if (id < 0) return null;
  return (index.links[id] || []).map(n => index.docs[n].page.path).sort();
}
