// SPDX-License-Identifier: MIT
// BA-00 blind acceptance (criterion f): no product changes under packages/ or modules/; changes stay in eval/ and tests/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, git } from './helpers.mjs';

const changed = () => git(['diff', '--name-only', 'main...HEAD'], ROOT).stdout.split('\n').filter(Boolean);

test('git: main ref exists and HEAD is a descendant of it', () => {
  assert.equal(git(['rev-parse', '--verify', 'main'], ROOT).status, 0);
  assert.equal(git(['merge-base', '--is-ancestor', 'main', 'HEAD'], ROOT).status, 0);
});

test('diff vs main: nothing under packages/ or modules/ (and no vendor, scripts, release, root manifests)', () => {
  const files = changed();
  const forbidden = files.filter((f) => /^(packages|modules|vendor|scripts|release)\//.test(f) || /^(package\.json|package-lock\.json)$/.test(f));
  assert.deepEqual(forbidden, []);
  assert.equal(git(['diff', '--name-only', 'main...HEAD', '--', 'packages', 'modules'], ROOT).stdout.trim(), '');
});

test('diff vs main: every changed file is under eval/ or tests/eval/', () => {
  const outside = changed().filter((f) => !/^(eval\/|tests\/eval\/)/.test(f));
  assert.deepEqual(outside, []);
});

test('working tree: no uncommitted or untracked change under packages/ or modules/', () => {
  assert.equal(git(['status', '--porcelain', '--', 'packages', 'modules'], ROOT).stdout.trim(), '');
});
