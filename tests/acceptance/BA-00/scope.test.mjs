// SPDX-License-Identifier: MIT
// BA-00 blind acceptance (criterion f): no product changes under packages/ or modules/; changes stay in eval/ and tests/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, git } from './helpers.mjs';

const changed = () => git(['diff', '--name-only', 'main...HEAD'], ROOT).stdout.split('\n').filter(Boolean);

// PM fix (2026-11-11): these checks describe the BA-00 track branch only; on main, other tracks and CI they are skipped.
const ONLY_ON_TRACK = { skip: git(['rev-parse', '--abbrev-ref', 'HEAD'], ROOT).stdout.trim() !== 'track/BA-00' };

test('git: main ref exists and HEAD is a descendant of it', ONLY_ON_TRACK, () => {
  assert.equal(git(['rev-parse', '--verify', 'main'], ROOT).status, 0);
  assert.equal(git(['merge-base', '--is-ancestor', 'main', 'HEAD'], ROOT).status, 0);
});

test('diff vs main: nothing under packages/ or modules/ (and no vendor, scripts, release, root manifests)', ONLY_ON_TRACK, () => {
  const files = changed();
  const forbidden = files.filter((f) => /^(packages|modules|vendor|scripts|release)\//.test(f) || /^(package\.json|package-lock\.json)$/.test(f));
  assert.deepEqual(forbidden, []);
  assert.equal(git(['diff', '--name-only', 'main...HEAD', '--', 'packages', 'modules'], ROOT).stdout.trim(), '');
});

// PM fix (2026-11-11): the track's own acceptance directory is in scope, and this track-specific diff check only
// applies on track/BA-00 (after merge, other tracks legitimately change packages/ relative to main).
test('diff vs main: every changed file is under eval/ or tests/eval/', ONLY_ON_TRACK, () => {
  const outside = changed().filter((f) => !/^(eval\/|tests\/eval\/|tests\/acceptance\/BA-00\/)/.test(f));
  assert.deepEqual(outside, []);
});

test('working tree: no uncommitted or untracked change under packages/ or modules/', ONLY_ON_TRACK, () => {
  assert.equal(git(['status', '--porcelain', '--', 'packages', 'modules'], ROOT).stdout.trim(), '');
});
