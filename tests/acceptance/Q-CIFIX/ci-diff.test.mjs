// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// The baseline lives in git history. CI checks out with depth 1, so the commit may be absent;
// the comparison is then skipped (it still runs in any full clone).
function baselineWorkflow() {
  try {
    return execFileSync('git', ['show', 'fce43aa:.github/workflows/ci.yml'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
}

const baseline = baselineWorkflow();

test('CI workflow differs from the pre-fix baseline only by fail-fast false', {
  skip: baseline === null ? 'baseline commit fce43aa not available (shallow clone)' : false
}, async () => {
  const current = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const expected = baseline.replace('    strategy:\n', '    strategy:\n      fail-fast: false\n');
  assert.notEqual(expected, baseline, 'the baseline must contain the expected matrix strategy');
  assert.ok(current === expected, 'CI workflow should contain only the fail-fast false insertion');
});
