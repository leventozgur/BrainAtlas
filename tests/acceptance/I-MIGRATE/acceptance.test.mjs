// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(root, 'packages/cli/bin/brainatlas.mjs');
const injector = join(root, 'tests/acceptance/I-MIGRATE/corrupt-copy.mjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');

async function snapshot(base) {
  const result = {};
  async function visit(path, rel) {
    let s;
    try { s = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const item = { mode: s.mode, mtime: s.mtimeMs, kind: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file' };
    if (item.kind === 'link') item.target = await readlink(path);
    if (item.kind === 'file') item.hash = digest(await readFile(path));
    if (item.kind === 'dir') item.entries = (await readdir(path)).sort();
    result[rel] = item;
    if (item.entries) for (const name of item.entries) await visit(join(path, name), `${rel}/${name}`);
  }
  await visit(base, '.');
  return result;
}
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'imigrate-'));
  t.after(async () => { await makeWritable(temp); await rm(temp, { recursive: true, force: true }); });
  const home = join(temp, 'home'), source = join(temp, 'old'), target = join(temp, 'new');
  await mkdir(home); await mkdir(source);
  for (const dir of ['wiki', 'planning', 'raw', 'inbox', 'archive']) await mkdir(join(source, dir));
  const marker = secret();
  await writeFile(join(source, 'wiki/index.md'), `---\ntitle: Index\n---\n# Index\n${marker}\n`);
  await writeFile(join(source, 'wiki/log.md'), '# Log\n');
  for (const dir of ['planning', 'inbox', 'archive']) await writeFile(join(source, dir, 'item.md'), `# ${dir}\nexample\n`);
  await writeFile(join(source, 'raw', 'binary.dat'), Buffer.from([0, 255, 128, 13, 10, 1]));
  await writeFile(join(source, 'AGENTS.md'), '# Legacy\n\n## User instructions\nRemember my custom setting.\n');
  const sentinel = join(temp, 'outside-home-sentinel'); await writeFile(sentinel, secret());
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: temp, BRAINATLAS_OFFLINE: '1', LANG: 'C', TZ: 'UTC' };
  return { temp, home, source, target, marker, sentinel, env };
}
async function makeWritable(path) {
  let s; try { s = await lstat(path); } catch { return; }
  if (s.isSymbolicLink()) return;
  await chmod(path, s.mode | 0o700);
  if (s.isDirectory()) for (const name of await readdir(path)) await makeWritable(join(path, name));
}
async function makeReadOnly(path) {
  const s = await lstat(path); if (s.isSymbolicLink()) return;
  if (s.isDirectory()) for (const name of await readdir(path)) await makeReadOnly(join(path, name));
  await chmod(path, s.mode & ~0o222);
}
function run(f, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: f.temp, env: f.env, encoding: 'utf8', timeout: 20000 });
}
function ok(r) { assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr); }
function noLeak(r, marker) { assert.ok(!`${r.stdout}\n${r.stderr}`.includes(marker), 'output contains page content'); }

 test('read-only source, copied categories, exclusions, instructions, hash and output secrecy', async t => {
  const f = await fixture(t);
  for (const dir of ['.git', '.obsidian', '.trash']) await mkdir(join(f.source, dir));
  await writeFile(join(f.source, '.git/HEAD'), 'reference\n');
  await writeFile(join(f.source, '.obsidian/workspace-mobile.json'), '{}');
  await writeFile(join(f.source, '.trash/deleted.md'), 'deleted\n');
  await symlink(f.sentinel, join(f.source, 'wiki/external.md'));
  await makeReadOnly(f.source);
  const before = await snapshot(f.source), outside = await snapshot(f.sentinel);
  const r = run(f, 'migrate', '--from', f.source, '--to', f.target, '--json'); ok(r); noLeak(r, f.marker);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(await snapshot(f.source), before);
  assert.deepEqual(await snapshot(f.sentinel), outside);
  for (const path of ['wiki/index.md', 'planning/item.md', 'raw/binary.dat', 'inbox/item.md', 'archive/item.md']) assert.deepEqual(await readFile(join(f.target, path)), await readFile(join(f.source, path)), path);
  for (const path of ['.git', '.obsidian/workspace-mobile.json', '.trash', 'wiki/external.md']) await assert.rejects(lstat(join(f.target, path)), { code: 'ENOENT' });
  for (const key of ['git', 'obsidian', 'trash', 'symlinks']) assert.ok(report.skipped[key] > 0, key);
  assert.equal(report.bodyHashMatch, true);
  const instructions = await readFile(join(f.target, 'AGENTS.md'), 'utf8');
  assert.ok(instructions.startsWith((await readFile(join(root, 'templates/policy/AGENTS.md'), 'utf8')).trimEnd()));
  assert.match(instructions, /Remember my custom setting\./);
  assert.ok(!(await readFile(join(f.target, 'wiki/log.md'), 'utf8')).includes(f.marker));
});

test('body hash reports false when copied page is corrupted before verification', async t => {
  const f = await fixture(t);
  f.env.NODE_OPTIONS = `--import=${injector}`; f.env.TEST_CORRUPT_PATH = join(f.target, 'wiki/index.md');
  const before = await snapshot(f.source);
  const r = run(f, 'migrate', '--from', f.source, '--to', f.target, '--json'); ok(r);
  assert.notDeepEqual(await readFile(join(f.source, 'wiki/index.md')), await readFile(join(f.target, 'wiki/index.md')));
  assert.equal(JSON.parse(r.stdout).bodyHashMatch, false);
  assert.deepEqual(await snapshot(f.source), before);
});

test('migration plan writes nothing, hides content and rejects overlapping paths', async t => {
  const f = await fixture(t); const before = await snapshot(f.temp);
  const r = run(f, 'migrate', '--from', f.source, '--to', f.target, '--plan', '--json'); ok(r); noLeak(r, f.marker);
  const plan = JSON.parse(r.stdout); assert.ok(plan.files > 0 && plan.pages > 0 && Array.isArray(plan.samplePaths));
  assert.deepEqual(await snapshot(f.temp), before);
  for (const extra of [[], ['--plan']]) {
    const bad = run(f, 'migrate', '--from', f.source, '--to', join(f.source, 'nested', 'target'), ...extra);
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /E_TARGET_INVALID/); noLeak(bad, f.marker);
    assert.deepEqual(await snapshot(f.temp), before);
  }
});

test('nonempty target is rejected without any writes in normal and plan modes', async t => {
  const f = await fixture(t); await mkdir(f.target); await writeFile(join(f.target, 'keep'), 'keep\n');
  const before = await snapshot(f.temp);
  for (const extra of [[], ['--plan']]) {
    const r = run(f, 'migrate', '--from', f.source, '--to', f.target, ...extra);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /E_TARGET_NOT_EMPTY/); noLeak(r, f.marker);
    assert.deepEqual(await snapshot(f.temp), before);
  }
});

test('adopt plan scans legacy records without writes or disclosing configuration content', async t => {
  const f = await fixture(t); const configSecret = secret();
  await mkdir(join(f.home, '.claude')); await mkdir(join(f.home, '.codex'));
  await writeFile(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { 'second-brain': { command: 'node', args: [configSecret] } } }));
  await writeFile(join(f.home, '.claude/settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: configSecret }] }] } }));
  await writeFile(join(f.home, '.codex/config.toml'), `[mcp_servers.second-brain]\ncommand = "${configSecret}"\n`);
  await mkdir(join(f.home, 'legacy/wiki'), { recursive: true }); await writeFile(join(f.home, 'legacy/wiki/index.md'), `# ${f.marker}\n`);
  const before = await snapshot(f.temp);
  const r = run(f, 'adopt', '--plan', '--json'); ok(r); noLeak(r, f.marker); noLeak(r, configSecret);
  const report = JSON.parse(r.stdout);
  assert.ok(report.existingMcpServers.some(x => x.path === join(f.home, '.claude.json')));
  assert.ok(report.existingMcpServers.some(x => x.path === join(f.home, '.codex/config.toml')));
  assert.ok(report.promptHooks.some(x => x.path === join(f.home, '.claude/settings.json')));
  assert.deepEqual(await snapshot(f.temp), before);
  const bad = run(f, 'adopt', '--json'); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /E_ARGUMENT/);
  assert.deepEqual(await snapshot(f.temp), before);
});

test('help works for built-in commands and unknown commands exit 2', async t => {
  const f = await fixture(t); const before = await snapshot(f.temp);
  const help = run(f, '--help'); ok(help); assert.match(help.stdout, /migrate/);
  for (const command of ['migrate', 'adopt']) { const r = run(f, 'help', command); ok(r); assert.match(r.stdout, new RegExp(command)); }
  for (const args of [['unknown-command'], ['help', 'unknown-command']]) { const r = run(f, ...args); assert.equal(r.status, 2); }
  assert.deepEqual(await snapshot(f.temp), before);
});

test('reported body equality matches every final wiki page including the migration log', async t => {
  const f = await fixture(t);
  const r = run(f, 'migrate', '--from', f.source, '--to', f.target, '--json'); ok(r);
  const body = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  let matches = true;
  for (const name of ['index.md', 'log.md']) {
    const source = body(await readFile(join(f.source, 'wiki', name), 'utf8'));
    const target = body(await readFile(join(f.target, 'wiki', name), 'utf8'));
    if (digest(source) !== digest(target)) matches = false;
  }
  assert.equal(JSON.parse(r.stdout).bodyHashMatch, matches, 'reported equality must describe the final copied page bodies');
});
