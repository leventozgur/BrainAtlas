// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve('.');
const coreRoot = path.join(root, 'packages/core/src');

async function moduleFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await moduleFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(absolute);
  }
  return found;
}

test('core static and transitive imports do not reach modules/semantic', async () => {
  const sources = await moduleFiles(coreRoot);
  const semanticRef = /(?:modules\/semantic|@brainatlas\/module-semantic|semantic\/src)/u;
  for (const file of sources) {
    const source = await readFile(file, 'utf8');
    assert.ok(!semanticRef.test(source), `${path.relative(root, file)} references the semantic module`);
  }

  const visited = new Set();
  const pending = [path.join(coreRoot, 'index.mjs')];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/gu)].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      assert.ok(!resolved.includes(`${path.sep}modules${path.sep}semantic${path.sep}`));
      if (resolved.endsWith('.mjs')) pending.push(resolved);
    }
  }
  assert.ok(visited.size > 1);
});

test('default Lite and Full core startup stays semantic-off and makes no network call', async (t) => {
  const isolatedHome = await mkdtemp(path.join(tmpdir(), 'q-semeval-home-'));
  t.after(() => rm(isolatedHome, { recursive: true, force: true }));
  const coreUrl = pathToFileURL(path.join(coreRoot, 'index.mjs')).href;
  const source = `
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('network must stay unused'); };
    const core = await import(${JSON.stringify(coreUrl)});
    const full = core.defaultConfig('full');
    const lite = core.defaultConfig('lite');
    const result = core.search(core.buildIndex([{path:'local.md',title:'Local',aliases:[],keywords:[],headings:[],body:'local text',frontmatter:{}}]), 'local');
    if (calls !== 0 || full.semantic?.enabled === true || lite.modules.length !== 0 || result.results[0]?.path !== 'local.md') process.exit(8);
    process.stdout.write(JSON.stringify({calls, liteModules:lite.modules.length, result:result.results.length}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: isolatedHome, TMPDIR: isolatedHome } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { calls: 0, liteModules: 0, result: 1 });
  assert.equal(child.stderr, '');
});
