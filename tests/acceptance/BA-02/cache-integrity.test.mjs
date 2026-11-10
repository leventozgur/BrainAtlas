// SPDX-License-Identifier: MIT
// BA-02 blind acceptance: stat fingerprint, no-read freshness check, forged/corrupt on-disk cache, symlinks, races.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSearcher, buildIndex, loadPages, search } from '../../../packages/core/src/retrieval/index.mjs';

const ASOF = new Date('2026-02-01T00:00:00Z');
const OPTS = { limit: 5, abstainThreshold: 0, asOf: ASOF };
const QUERIES = ['alpha', 'bravo charlie', 'zephyr', 'quokka', 'wombat', 'delta echo', 'legacy', 'secret token'];
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]])) : v));

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const home = tmpdir(t);
  const vault = path.join(home, 'vault'), wiki = path.join(vault, 'wiki'), stateDir = path.join(home, 'state');
  fs.mkdirSync(wiki, { recursive: true }); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'alpha.md'), '---\ntitle: Alpha\n---\n# Alpha\nalpha bravo charlie notes\n');
  fs.writeFileSync(path.join(wiki, 'delta.md'), '# Delta\ndelta echo foxtrot\n');
  fs.writeFileSync(path.join(wiki, 'legacy.md'), '---\ntitle: Old\nstatus: superseded\nsuperseded_by: wiki/alpha.md\n---\n# Old\nlegacy zephyr\n');
  const outside = tmpdir(t);
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Secret\nsecret token quokka\n');
  return { home, vault, wiki, stateDir, outside, cache: path.join(stateDir, 'retrieval-index.json') };
}
// Reference: a clean build with no cache (what a fresh install returns).
function reference(vault) {
  const index = buildIndex(loadPages(vault), { now: ASOF });
  return QUERIES.map((q) => canon(search(index, q, OPTS)));
}
function viaSearcher(vault, stateDir) {
  const s = createSearcher({ vaultDir: vault, stateDir, now: ASOF });
  return QUERIES.map((q) => canon(s.search(q, OPTS)));
}

test('refreshIfChanged reads no Markdown file and no file content when nothing changed', async (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const realRead = fs.readFileSync;
  const calls = [];
  fs.readFileSync = function (file, ...rest) { calls.push(String(file)); return realRead.call(this, file, ...rest); };
  t.after(() => { fs.readFileSync = realRead; });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(s.refreshIfChanged());
  fs.readFileSync = realRead;
  assert.deepEqual(results, [false, false, false, false, false]);
  assert.deepEqual(calls.filter((c) => c.endsWith('.md')), []);
  assert.equal(calls.length, 0, `unexpected reads: ${calls.length}`);
});

test('add, edit, delete and rename outside the process are seen by refreshIfChanged', async (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const hits = (q) => s.search(q, OPTS).results.map((r) => r.path);
  assert.deepEqual(hits('zephyr'), []);
  fs.writeFileSync(path.join(f.wiki, 'new.md'), '# New\nzephyr appears\n');
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(hits('zephyr'), ['new.md']);
  fs.writeFileSync(path.join(f.wiki, 'new.md'), '# New\nquokka replaces it\n');
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(hits('zephyr'), []);
  assert.deepEqual(hits('quokka'), ['new.md']);
  fs.renameSync(path.join(f.wiki, 'new.md'), path.join(f.wiki, 'renamed.md'));
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(hits('quokka'), ['renamed.md']);
  fs.rmSync(path.join(f.wiki, 'renamed.md'));
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(hits('quokka'), []);
  assert.equal(s.refreshIfChanged(), false);
});

test('same-size rewrite with the original mtime restored (utimes) is still detected', async (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  const file = path.join(f.wiki, 'delta.md');
  const before = fs.lstatSync(file, { bigint: true });
  const oldText = fs.readFileSync(file, 'utf8');
  const newText = oldText.replace('foxtrot', 'wombats'); // 'foxtrot' and 'wombats' are both 7 bytes
  assert.equal(newText.length, oldText.length);
  fs.writeFileSync(file, newText);
  // Node's utimes cannot restore nanoseconds; python's os.utime(ns=) can. Fall back to Node when python3 is absent.
  let exact = false;
  try {
    execFileSync('python3', ['-c', 'import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))', file, before.atimeNs.toString(), before.mtimeNs.toString()]);
    exact = true;
  } catch { fs.utimesSync(file, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9); }
  const after = fs.lstatSync(file, { bigint: true });
  assert.equal(after.size, before.size, 'test precondition: same size');
  if (exact) assert.equal(after.mtimeNs, before.mtimeNs, 'test precondition: mtime restored to the nanosecond');
  console.log(`same-size utimes rewrite: exact ns mtime restore=${after.mtimeNs === before.mtimeNs} ctime changed=${after.ctimeNs !== before.ctimeNs} ino same=${after.ino === before.ino}`);
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(s.search('wombats', OPTS).results.map((r) => r.path), ['delta.md']);
});

test('symlinked pages and directories are never indexed or read through', async (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.outside, 'secret.md'), path.join(f.wiki, 'link-page.md'));
  fs.symlinkSync(f.outside, path.join(f.wiki, 'link-dir'));
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  assert.deepEqual(s.search('secret token', OPTS).results.map((r) => r.path), []);
  assert.deepEqual(s.snapshot().pages.map((p) => p.path).sort(), ['alpha.md', 'delta.md', 'legacy.md']);
  // Symlink created after the fingerprint: still not indexed on the next refresh.
  fs.symlinkSync(path.join(f.outside, 'secret.md'), path.join(f.wiki, 'late-link.md'));
  s.refreshIfChanged();
  assert.deepEqual(s.search('secret token', OPTS).results.map((r) => r.path), []);
  assert.ok(!JSON.stringify(s.snapshot().pages).includes('quokka'), 'symlink target content must not appear in the snapshot');
});

test('the cache lives under stateDir and nothing is written into the vault', async (t) => {
  const f = fixture(t);
  const listVault = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p + (e.isFile() ? ':' + fs.readFileSync(p, 'utf8').length : '')); if (e.isDirectory()) walk(p); } }; walk(f.vault); return out.sort(); };
  const before = listVault();
  createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF }).search('alpha', OPTS);
  assert.deepEqual(listVault(), before);
  assert.ok(fs.existsSync(f.cache), 'cache written under stateDir');
  assert.ok(!f.cache.startsWith(f.vault + path.sep));
});

// Forged or corrupt caches. The key is copied from the real cache so only the payload is wrong.
const flat = (d) => d.index.postings[Object.keys(d.index.postings)[0]];
const forged = {
  'truncated JSON': { raw: (raw) => raw.slice(0, Math.floor(raw.length / 2)) },
  'not JSON': { raw: () => 'not json' },
  'empty object': { raw: () => '{}' },
  'wrong key': { mutate: (d) => ({ ...d, key: 'x'.repeat(64) }) },
  'index version 2': { mutate: (d) => ({ ...d, index: { ...d.index, version: 2 } }) },
  'legacy shape (no schema key)': { mutate: (d) => ({ key: createHash('sha256').update('legacy').digest('hex'), index: d.index }) },
  'posting length not multiple of 5': { mutate: (d) => { flat(d).push(0); return d; } },
  'negative doc id': { mutate: (d) => { flat(d)[0] = -1; return d; } },
  'fractional doc id': { mutate: (d) => { flat(d)[0] = 0.5; return d; } },
  'doc id out of range': { mutate: (d) => { flat(d)[0] = d.index.docs.length; return d; } },
  'string count': { mutate: (d) => { flat(d)[1] = '3'; return d; } },
  'null count': { mutate: (d) => { flat(d)[1] = null; return d; } },
  'Infinity count (1e999 literal)': { raw: (raw) => raw.replace(/("postings":\{"[^"]+":\[\d+,)\d+/, '$1' + '1e999') },
  'null average': { mutate: (d) => { d.index.averages[0] = null; return d; } },
  'string doc length': { mutate: (d) => { d.index.docs[0].lengths[0] = 'x'; return d; } },
  '__proto__ term name (inert)': { mutate: (d) => { d.index.postings.__proto__ = [0, 0, 0, 0, 0]; return d; } },
  'huge but finite count (1e308)': { mutate: (d) => { flat(d)[1] = 1e308; return d; } },
  'body is not a string': { mutate: (d) => { d.index.docs[0].page.body = 42; return d; } },
  'duplicate posting entry': { mutate: (d) => { const k = Object.keys(d.index.postings)[0]; d.index.postings[k].push(...d.index.postings[k].slice(0, 5)); return d; } },
  'ghost page not on disk (matching key)': { mutate: (d) => { d.index.docs.push({ page: { path: 'ghost.md', title: 'Ghost', body: 'quokka ghost', frontmatter: {} }, lengths: [1, 2, 0, 1] }); d.index.averages = d.index.averages.map((a) => a); return d; } },
  'path traversal in docs (matching key)': { mutate: (d) => { d.index.docs[0].page.path = '../escape.md'; return d; } },
};

for (const [name, spec] of Object.entries(forged)) {
  test(`forged cache "${name}" falls back to a safe rebuild with fresh-build results`, async (t) => {
    const f = fixture(t);
    createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF }); // writes a valid cache
    const raw = fs.readFileSync(f.cache, 'utf8');
    const data = JSON.parse(raw);
    let next;
    if (spec.raw) next = spec.raw(raw);
    else next = JSON.stringify(spec.mutate(JSON.parse(raw)));
    fs.writeFileSync(f.cache, next);
    const expected = reference(f.wiki);
    let got;
    try { got = viaSearcher(f.wiki, f.stateDir); }
    catch (error) { assert.fail(`search threw on forged cache: ${error.code ?? error.name}: ${error.message}`); }
    assert.deepEqual(got, expected);
    assert.ok(data.key, 'sanity: real cache has a key');
  });
}

test('a file removed or renamed between stat and read does not crash the searcher', async (t) => {
  const f = fixture(t);
  const s = createSearcher({ vaultDir: f.wiki, stateDir: f.stateDir, now: ASOF });
  fs.rmSync(path.join(f.wiki, 'delta.md'));
  fs.renameSync(path.join(f.wiki, 'alpha.md'), path.join(f.wiki, 'alpha2.md'));
  // Simulate the race: a file vanishes after the walk but before it is read during the rebuild.
  const realRead = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function (file, ...rest) {
    if (!injected && String(file).endsWith('alpha2.md')) { injected = true; const e = new Error('gone'); e.code = 'ENOENT'; throw e; }
    return realRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });
  let firstError = null;
  try { s.refreshIfChanged(); } catch (error) { firstError = error; }
  fs.readFileSync = realRead;
  console.log(`race: first refresh ${firstError ? 'threw ' + firstError.code : 'succeeded'}`);
  // The process must survive and the next refresh must converge to the fresh state.
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(QUERIES.map((q) => canon(s.search(q, OPTS))), reference(f.wiki));
});
