// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCommentViolations } from '../../scripts/check-comments.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts/check-comments.mjs');
const temp = () => mkdtemp(join(tmpdir(), 'ba-check-comments-'));

test('file arguments report comments, JSDoc prose, parse errors and missing files', async () => {
  const dir = await temp();
  try {
    const bad = join(dir, 'bad.mjs');
    await writeFile(bad, '// SPDX-License-Identifier: MIT\nexport const a = 1; // bad\n');
    const good = join(dir, 'good.mjs');
    await writeFile(
      good,
      '// SPDX-License-Identifier: MIT\n/**\n * @param {string} x\n * @returns {number}\n */\nexport const f = (x) => x.length;\n'
    );
    const prose = join(dir, 'prose.mjs');
    await writeFile(prose, '/**\n * explains\n * @type {any}\n */\nexport const b = 1;\n');
    const broken = join(dir, 'broken.mjs');
    await writeFile(broken, 'const = ;\n');
    const missing = join(dir, 'missing.mjs');
    assert.deepEqual(findCommentViolations(dir, [bad, good, prose, broken, missing]), [
      { file: bad, line: 2 },
      { file: prose, line: 2 },
      { file: broken, line: 1, problem: 'parse error' },
      { file: missing, line: 1, problem: 'file not found' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('command line prints file:line for findings and file:line problem for errors', async () => {
  const dir = await temp();
  try {
    const bad = join(dir, 'bad.mjs');
    await writeFile(bad, '// SPDX-License-Identifier: MIT\n// bad\n');
    const broken = join(dir, 'broken.mjs');
    await writeFile(broken, 'const = ;\n');
    const missing = join(dir, 'missing.mjs');
    const result = spawnSync(process.execPath, [script, bad, broken, missing], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `${bad}:2\n${broken}:1 parse error\n${missing}:1 file not found\n`);
    const good = join(dir, 'good.mjs');
    await writeFile(good, '// SPDX-License-Identifier: MIT\nexport const a = 1;\n');
    const clean = spawnSync(process.execPath, [script, good], { encoding: 'utf8' });
    assert.equal(clean.status, 0);
    assert.equal(clean.stdout, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tracked scan skips nested vendor and node_modules paths and missing index entries', async () => {
  const dir = await temp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'nested', 'vendor'), { recursive: true });
    await mkdir(join(dir, 'nested', 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'src', 'bad.mjs'), '// bad\n');
    await writeFile(join(dir, 'nested', 'vendor', 'one.mjs'), '// bad\n');
    await writeFile(join(dir, 'nested', 'node_modules', 'two.mjs'), '// bad\n');
    await writeFile(join(dir, 'gone.mjs'), 'export const gone = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    await unlink(join(dir, 'gone.mjs'));
    assert.deepEqual(findCommentViolations(dir), [{ file: 'src/bad.mjs', line: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('command line runs from a root path with spaces and unicode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ba check comments ünï-'));
  try {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await copyFile(script, join(dir, 'scripts', 'check-comments.mjs'));
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'));
    const bad = join(dir, 'bad file.mjs');
    await writeFile(bad, '// bad\n');
    const result = spawnSync(process.execPath, [join(dir, 'scripts', 'check-comments.mjs'), bad], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `${bad}:1\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
