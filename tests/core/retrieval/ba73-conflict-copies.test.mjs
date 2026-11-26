// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearcher, isConflictCopyPath, searchScope } from '../../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-21T10:15:00Z');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba73-conflict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
function paths(results) {
  return results.map((row) => row.path).sort();
}

test('isConflictCopyPath matches the sync engine format on the basename, case-insensitively', () => {
  assert.equal(isConflictCopyPath('wiki/a.conflict-mac-20261121T101500Z.md'), true);
  assert.equal(isConflictCopyPath('a.conflict-host_1-20261121T101500Z-2.md'), true);
  assert.equal(isConflictCopyPath('A.CONFLICT-MAC-20261121T101500Z.MD'), true);
  assert.equal(isConflictCopyPath('foo.conflict-resolution.md'), false);
  assert.equal(isConflictCopyPath('a.conflict-mac-20261121.md'), false);
  assert.equal(isConflictCopyPath('a.conflict-mac-20261121T101500Z.txt'), false);
});

test('search never returns a conflict copy and still returns a page named *.conflict-resolution.md', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'wiki/a.md', '# A\nzephyrite quorum alpha');
  write(vault, 'wiki/a.conflict-mac-20261121T101500Z.md', '# Copy\nzephyrite quorum alpha');
  write(vault, 'wiki/foo.conflict-resolution.md', '# Resolution\nxylophoneresolution notes');

  const search = (configured, stateName) => {
    const scope = searchScope(vault, configured);
    return createSearcher({
      vaultDir: scope.root,
      stateDir: path.join(dir, stateName),
      now,
      exclude: scope.exclude,
    });
  };
  for (const [configured, stateName] of [
    [undefined, 'state-default'],
    [['drafts/**'], 'state-custom'],
    [[], 'state-empty'],
  ]) {
    const searcher = search(configured, stateName);
    assert.deepEqual(paths(searcher.search('zephyrite quorum', { limit: 10, abstainThreshold: 0 }).results), ['a.md']);
    assert.deepEqual(paths(searcher.search('xylophoneresolution', { limit: 10, abstainThreshold: 0 }).results), [
      'foo.conflict-resolution.md',
    ]);
  }
});
