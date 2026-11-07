// SPDX-License-Identifier: MIT
import { readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(full);
  }
  return files;
}
const root = resolve(new URL('..', import.meta.url).pathname);
const filter = process.argv[2];
let files = (await walk(join(root, 'tests'))).sort();
if (filter) files = files.filter((file) => file.slice(root.length + 1).startsWith(filter));
if (!files.length) { console.error('No test files found'); process.exit(1); }
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
