// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = p => readFileSync(resolve(root, p), 'utf8');
const files = ['README.md', 'README.tr.md', 'CHANGELOG.md', ...readdirSync(resolve(root, 'docs/user')).filter(x => x.endsWith('.md')).map(x => `docs/user/${x}`)];
const cli = resolve(root, 'packages/cli/bin/brainatlas.mjs');
function run(args) {
  const home = mkdtempSync(join(tmpdir(), 'docs2-home-'));
  try {
    return spawnSync(process.execPath, [cli, ...args], {cwd: home, encoding:'utf8', timeout:10000, env:{PATH:process.env.PATH, HOME:home, XDG_CONFIG_HOME:join(home,'config'), XDG_DATA_HOME:join(home,'data'), XDG_STATE_HOME:join(home,'state'), NO_COLOR:'1'}});
  } finally { rmSync(home, {recursive:true, force:true}); }
}
function personal(s) { return s.replaceAll('git@github.com', '').match(/(?:\/Users\/[^\s/`]+|\/home\/[^\s/`]+|[\w.+-]+@[\w.-]+\.[a-z]{2,})/gi) || []; }
function complete(text, patterns) { return patterns.every(p => p.test(text)); }

test('CLI help covers documented quickstart options and rejects unknown topics', () => {
  const init = run(['help','init']);
  assert.equal(init.status, 0);
  assert.match(init.stdout, /--profile/);
  assert.notEqual(run(['help','invented-command']).status, 0);
  assert.match(read('README.md'), /brainatlas init [^\n]*--agents/);
  assert.match(init.stdout, /--agents/, 'documented init --agents is missing from help');
});
test('documented sync help provides usable subcommand syntax', () => {
  const doc = read('docs/user/sync.md');
  assert.match(doc, /brainatlas help sync/);
  // Module help is generated as generic [ARGS]; inspect its actual help contract in CLI source.
  const source = read('packages/cli/src/index.mjs');
  assert.equal(/usage: `brainatlas \$\{name\} \[ARGS\]`/.test(source), false, 'module help does not supply the promised exact syntax');
});
test('private SSH guide has complete security and two-host workflow', () => {
  const patterns = [/Private/i, /README/i, /Allow write access/i, /ssh -T git@github\.com/, /sync\.transport git/, /sync\.options\.remote git@github\.com:<owner>\/<repo>\.git/, /sync run/, /second host/i, /sync check --peer <stateDir>/, /no client-side encryption/i, /Dropbox/i];
  assert(complete(read('docs/user/sync.md'), patterns));
  assert(!complete('Private repository; sync run', patterns));
});
test('distribution and Gemini instructions specify required boundaries', () => {
  const install = read('docs/user/install.md');
  const patterns = [/build-release\.mjs --version <v> --out <dir>/, /SHA256SUMS\.sig/, /--allowed-signers/, /--vault PATH/, /--allow-symlinked-root/, /outside `HOME`/, /GitHub Releases/i];
  assert(complete(install, patterns)); assert(!complete('install.sh --yes', patterns));
  assert(complete(read('docs/user/agents.md'), [/BeforeAgent/, /SessionStart/, /brainatlas-context/, /brainatlas-session/, /\/hooks/]));
});
test('published documents avoid personal paths and addresses', () => {
  assert.equal(personal(['', 'Users', 'example-person', 'x'].join('/')).length, 1);
  assert.equal(personal('~/.local/share').length, 0);
  assert.deepEqual(files.flatMap(f => personal(read(f)).map(x => `${f}: ${x}`)), []);
});
test('changelog attribution points to an existing file', () => {
  const doc = read('CHANGELOG.md');
  assert.match(doc, /0\.1\.0-rc\.2[^\n]*2026-11-08/);
  const referenced = doc.match(/`(THIRD_PARTY_NOTICES[^`]*)`/)?.[1];
  assert.ok(referenced);
  assert.doesNotThrow(() => read(referenced), `missing ${referenced}`);
});
test('bad config and traversal-like keys reject without exposing synthetic secrets', () => {
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  for (const args of [['config','set','unknown.path',secret], ['config','set','../escape',secret]]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert(!(`${result.stdout}${result.stderr}`).includes(secret));
  }
});
test('link boundary fixture detects missing and dangling targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs2-links-'));
  try {
    symlinkSync('missing', join(dir, 'dangling'));
    assert.throws(() => readFileSync(join(dir, 'dangling')));
    assert.throws(() => readFileSync(join(dir, '..', 'absent-docs2-target')));
    assert.equal(read('README.md').startsWith('# BrainAtlas'), true);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
