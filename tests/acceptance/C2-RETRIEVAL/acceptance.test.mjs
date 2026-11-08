// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildIndex, createSearcher, loadPages, normalizeText, search, stem } from '../../../packages/core/src/retrieval/index.mjs';
import { runEval } from '../../../eval/run-eval.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const now = new Date('2025-01-01T00:00:00.000Z');
const page = (file, body = 'distinctive retrieval evidence', frontmatter = {}, extra = {}) => ({
  path: file, title: 'Distinctive Retrieval', aliases: [], keywords: [], headings: [], body, frontmatter, ...extra,
});
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-retrieval-acceptance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('superseded pages are excluded by status and superseded_by; active evidence still returns', () => {
  const index = buildIndex([
    page('current.md', 'migration guide current'),
    page('status-old.md', 'migration guide status old', { status: 'superseded' }),
    page('link-old.md', 'migration guide link old', { superseded_by: 'current.md' }),
  ], { now });
  const result = search(index, 'migration guide');
  assert.ok(result.results.some((item) => item.path === 'current.md'));
  assert.ok(result.results.every((item) => !['status-old.md', 'link-old.md'].includes(item.path)));
});

test('stale is false immediately before and at an absolute date threshold, then true after it', () => {
  const index = buildIndex([page('absolute.md', 'freshness evidence', { stale_after: '2025-01-03' })], { now });
  const before = search(index, 'freshness', { asOf: new Date('2025-01-02T23:59:59.999Z') });
  const exact = search(index, 'freshness', { asOf: new Date('2025-01-03T00:00:00.000Z') });
  const after = search(index, 'freshness', { asOf: new Date('2025-01-03T00:00:00.001Z') });
  assert.equal(before.results[0].stale, false);
  assert.equal(exact.results[0].stale, false);
  assert.equal(after.results[0].stale, true);
});

test('stale handles P<n>D at the full-day boundary and reports already-expired evidence', () => {
  const index = buildIndex([
    page('relative.md', 'relative freshness evidence', { generated: '2025-01-01', stale_after: 'P2D' }),
    page('expired.md', 'expired evidence', { generated: '2024-12-20', stale_after: 'P2D' }),
  ], { now });
  const exact = search(index, 'relative freshness', { asOf: new Date('2025-01-03T00:00:00.000Z') });
  const after = search(index, 'relative freshness', { asOf: new Date('2025-01-03T00:00:00.001Z') });
  assert.equal(exact.results[0].stale, false);
  assert.equal(after.results[0].stale, true);
  assert.equal(search(index, 'expired evidence', { asOf: new Date('2025-01-03T00:00:00Z') }).results[0].stale, true);
});

test('empty query abstains with an empty result instead of throwing', () => {
  const result = search(buildIndex([page('one.md')], { now }), '');
  assert.deepEqual(result.results, []);
  assert.equal(result.abstained, true);
});

test('whitespace-only query abstains with an empty result', () => {
  const result = search(buildIndex([page('one.md')], { now }), ' \t\n ');
  assert.deepEqual(result.results, []);
  assert.equal(result.abstained, true);
});

test('stopword-only query abstains with an empty result', () => {
  const result = search(buildIndex([page('one.md')], { now }), 'the and of to ve ile');
  assert.deepEqual(result.results, []);
  assert.equal(result.abstained, true);
});

test('unmatched meaningful query abstains; weak score obeys the threshold', () => {
  const index = buildIndex([page('one.md', 'evidence for retrieval')], { now });
  const unmatched = search(index, 'nonexistentconcept');
  assert.deepEqual(unmatched.results, []);
  assert.equal(unmatched.abstained, true);
  const belowThreshold = search(index, 'evidence', { abstainThreshold: 1 });
  assert.deepEqual(belowThreshold.results, []);
  assert.equal(belowThreshold.abstained, true);
});

test('Turkish and English normalization folds dotted, dotless and diacritic letters', () => {
  assert.equal(normalizeText('İstanbul'), 'istanbul');
  assert.equal(normalizeText('istanbul'), 'istanbul');
  assert.equal(normalizeText('ISTANBUL'), 'istanbul');
  assert.equal(normalizeText('Ğ Ş ı'), 'g s i');
  assert.equal(normalizeText('ÇÖÜ'), 'cou');
});

test('stemming recognizes common inflections without damaging short words', () => {
  assert.equal(stem('yedeklerden'), 'yedek');
  assert.equal(stem('backups'), 'backup');
  for (const token of ['ki', 'su', 'is', 'xler', 'kisa']) assert.equal(stem(token), token);
});

test('Turkish inflected query retrieves the matching uninflected evidence', () => {
  const index = buildIndex([page('backup.md', 'yedek planı ve geri dönüş')], { now });
  assert.ok(search(index, 'yedeklerden').results.some((item) => item.path === 'backup.md'));
});

test('budget is respected at zero, exact-fit and truncation boundaries', () => {
  const index = buildIndex([page('budget.md', '12345')], { now });
  const zero = search(index, 'retrieval', { budgetChars: 0 });
  const exact = search(index, 'retrieval', { budgetChars: 5 });
  const short = search(index, 'retrieval', { budgetChars: 4 });
  assert.equal(zero.results[0].snippet.length, 0);
  assert.equal(zero.truncated, true);
  assert.equal(exact.results[0].snippet, '12345');
  assert.equal(exact.truncated, false);
  assert.ok(short.results.reduce((n, item) => n + item.snippet.length, 0) <= 4);
  assert.equal(short.truncated, true);
});

test('budget spans all returned snippets and limit bounds result count', () => {
  const index = buildIndex([page('a.md', 'aaaaaa'), page('b.md', 'bbbbbb')], { now });
  const result = search(index, 'retrieval', { budgetChars: 7, limit: 2 });
  assert.equal(result.results.length, 2);
  assert.ok(result.results.reduce((n, item) => n + item.snippet.length, 0) <= 7);
  assert.equal(result.truncated, true);
});

test('ranking is deterministic and breaks equal scores by path', () => {
  const pages = [page('zeta.md', 'shared evidence'), page('alpha.md', 'shared evidence')];
  const first = search(buildIndex(pages, { now }), 'shared evidence');
  const second = search(buildIndex(pages, { now }), 'shared evidence');
  assert.deepEqual(first, second);
  assert.deepEqual(first.results.map((item) => item.path), ['alpha.md', 'zeta.md']);
});

test('BM25F favors title evidence over body-only evidence and returns the contract fields', () => {
  const index = buildIndex([
    page('body.md', 'needle', {}, { title: 'Reference' }),
    page('title.md', 'unrelated body', {}, { title: 'Needle' }),
  ], { now });
  const result = search(index, 'needle');
  assert.equal(result.results[0].path, 'title.md');
  // PM update (Q-SECTION): contract v1 allows additive optional fields; the original six keys stay required.
  const resultKeys = Object.keys(result.results[0]).sort();
  for (const required of ['path', 'score', 'snippet', 'stale', 'status', 'title']) assert.ok(resultKeys.includes(required), `missing ${required}`);
  for (const key of resultKeys) assert.ok(['path', 'score', 'snippet', 'stale', 'status', 'title', 'heading', 'anchor', 'headingPath'].includes(key), `unexpected key ${key}`);
  assert.equal(result.results[0].title, 'Needle');
  assert.equal(typeof result.results[0].score, 'number');
  assert.equal(result.results[0].stale, false);
  assert.equal(result.results[0].status, null);
});

test('dev eval has the required size and minimum recall@5', () => {
  const casesFile = path.join(root, 'eval/dev/cases.json');
  const result = runEval({ corpusDir: path.join(root, 'eval/corpus'), casesFile, now });
  const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  assert.ok(result.n >= 40);
  assert.ok(cases.filter((item) => item.trToEn).length >= 10);
  assert.ok(cases.filter((item) => item.abstain || !item.relevant?.length).length >= 5);
  assert.ok(cases.filter((item) => item.excluded?.length).length >= 5);
  assert.ok(result.recallAt5 >= 0.8, `dev recall@5=${result.recallAt5}`);
});

test('superseded eval targets never appear for their queries', () => {
  const corpusDir = path.join(root, 'eval/corpus');
  const index = buildIndex(loadPages(corpusDir), { now });
  for (const file of ['eval/dev/cases.json', 'eval/holdout/cases.json']) {
    const cases = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const item of cases.filter((entry) => entry.excluded?.length)) {
      const result = search(index, item.query);
      assert.ok(result.results.every((entry) => !item.excluded.includes(entry.path)), `${file}: ${item.query}`);
    }
  }
});

test('dev cases include varied natural multiword answerable queries', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, 'eval/dev/cases.json'), 'utf8'));
  const answerable = cases.filter((item) => item.relevant?.length);
  const naturalMultiword = answerable.filter((item) => item.query.trim().split(/\s+/u).length >= 3 && !/legacytoken\d/u.test(item.query));
  assert.ok(naturalMultiword.length >= 10, `natural multiword answerable cases=${naturalMultiword.length}`);
});

test('holdout is isolated from dev and the eval runner records its outcome', () => {
  const devFile = path.join(root, 'eval/dev/cases.json');
  const holdoutFile = path.join(root, 'eval/holdout/cases.json');
  assert.notEqual(path.dirname(devFile), path.dirname(holdoutFile));
  const result = runEval({ corpusDir: path.join(root, 'eval/corpus'), casesFile: holdoutFile, now });
  assert.equal(result.n, JSON.parse(fs.readFileSync(holdoutFile, 'utf8')).length);
});

test('brainatlas eval CLI runs an eval file and emits machine-readable metrics', { skip: 'PM: CLI wiring of `brainatlas eval` belongs to I-INSTALL (TRACKS.md C2 brief: runEval export only)' }, () => {
  const cli = path.join(root, 'packages/cli/bin/brainatlas.mjs');
  const proc = spawnSync(process.execPath, [cli, 'eval', '--corpus', path.join(root, 'eval/corpus'), '--cases', path.join(root, 'eval/dev/cases.json'), '--now', now.toISOString()], { cwd: root, encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const metrics = JSON.parse(proc.stdout);
  assert.ok(metrics.n >= 40);
  assert.ok(metrics.recallAt5 >= 0.8);
});

test('malformed cache silently rebuilds, and source edits invalidate a warm cache', async (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  const file = path.join(vault, 'entry.md');
  fs.writeFileSync(file, '---\ntitle: Alpha\n---\nalpha evidence');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'retrieval-index.json'), '{broken');
  const recovered = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.equal(recovered.search('alpha').results[0].title, 'Alpha');
  fs.writeFileSync(file, '---\ntitle: Bravo\n---\nbravo evidence updated');
  await recovered.refresh();
  assert.equal(recovered.search('bravo').results[0].title, 'Bravo');
  assert.deepEqual(recovered.search('alpha').results, []);
});

test('retrieval writes cache only under the configured state directory', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state'), fakeHome = path.join(dir, 'home');
  fs.mkdirSync(vault);
  fs.mkdirSync(fakeHome);
  fs.writeFileSync(path.join(vault, 'entry.md'), 'vault evidence');
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    createSearcher({ vaultDir: vault, stateDir: state, now });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.deepEqual(fs.readdirSync(vault), ['entry.md']);
  assert.deepEqual(fs.readdirSync(state), ['retrieval-index.json']);
  assert.deepEqual(fs.readdirSync(fakeHome), []);
});

test('loader ignores file, directory and root symlinks that point outside the vault', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), outsideDir = path.join(dir, 'outside-dir'), outside = path.join(dir, 'outside.md'), rootLink = path.join(dir, 'root-link');
  fs.mkdirSync(vault);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(outside, '---\ntitle: Secret Outside\n---\nsecret canary content');
  fs.writeFileSync(path.join(outsideDir, 'nested-secret.md'), 'nested canary content');
  fs.writeFileSync(path.join(vault, 'inside.md'), 'inside content');
  try {
    fs.symlinkSync(outside, path.join(vault, 'linked.md'));
    fs.symlinkSync(outsideDir, path.join(vault, 'linked-dir'));
    fs.symlinkSync(outsideDir, rootLink);
  }
  catch (error) { t.skip(`symlink unavailable: ${error.code}`); return; }
  assert.deepEqual(loadPages(vault).map((item) => item.path), ['inside.md']);
  const result = search(buildIndex(loadPages(vault), { now }), 'canary');
  assert.deepEqual(result.results, []);
  // PM correction: a symlinked vault ROOT is a legitimate user setup (root is resolved once with realpath);
  // only symlinks INSIDE the vault that escape the resolved root must be ignored.
  void rootLink;
});

test('direct page paths cannot escape the vault through ../', () => {
  const direct = search(buildIndex([page('../outside.md', 'traversal canary')], { now }), 'traversal');
  assert.ok(direct.results.every((item) => !item.path.startsWith('../')));
});

test('cached page paths cannot escape the vault through ../', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'inside.md'), '---\ntitle: Inside\n---\ntraversal canary');
  createSearcher({ vaultDir: vault, stateDir: state, now });
  const cacheFile = path.join(state, 'retrieval-index.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache.index.docs[0].page.path = '../outside.md';
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const reopened = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.ok(reopened.search('traversal').results.every((item) => !item.path.startsWith('../')));
});

test('missing vault, malformed frontmatter and corrupt index produce typed sanitized errors', (t) => {
  const dir = temp(t), missing = path.join(dir, 'missing'), malformed = path.join(dir, 'malformed');
  assert.throws(() => loadPages(missing), { code: 'E_VAULT_MISSING' });
  fs.mkdirSync(malformed);
  fs.writeFileSync(path.join(malformed, 'bad.md'), '---\ntitle: [secret-canary\n---\nbody');
  assert.throws(() => loadPages(malformed), (error) => error.code === 'E_INVALID_INPUT' && !error.message.includes('secret-canary'));
  assert.throws(() => search({}, 'query'), { code: 'E_INDEX_CORRUPT' });
});

test('invalid options and non-text input fail without echoing sensitive values', () => {
  const index = buildIndex([page('one.md')], { now });
  assert.throws(() => search(index, 'secret-canary', { limit: -1 }), (error) => error.code === 'E_INVALID_INPUT' && !error.message.includes('secret-canary'));
  assert.throws(() => search(index, 42), { code: 'E_QUERY_INVALID' });
  assert.throws(() => buildIndex({}), { code: 'E_INVALID_INPUT' });
});

test('search emits no query or snippet logs and eval metrics omit query/body text', () => {
  const secret = 'secret-canary-84917';
  const index = buildIndex([page('secret.md', `${secret} private body`)], { now });
  const logged = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  try {
    for (const key of Object.keys(originals)) console[key] = (...args) => logged.push(args.join(' '));
    search(index, secret);
  } finally {
    for (const [key, fn] of Object.entries(originals)) console[key] = fn;
  }
  assert.deepEqual(logged, []);
  const metrics = runEval({ corpusDir: path.join(root, 'eval/corpus'), casesFile: path.join(root, 'eval/dev/cases.json'), now });
  assert.equal(JSON.stringify(metrics).includes(secret), false);
});

test('missing or invalid option boundaries are rejected', () => {
  const index = buildIndex([page('one.md')], { now });
  for (const options of [{ limit: -1 }, { limit: 1.5 }, { budgetChars: -1 }, { budgetChars: NaN }, { abstainThreshold: 1.01 }, { asOf: '2025-01-01' }]) {
    assert.throws(() => search(index, 'retrieval', options), { code: 'E_INVALID_INPUT' });
  }
  assert.deepEqual(search(index, 'retrieval', { limit: 0 }).results, []);
});

test('warm query median stays below 300 ms on a 2000-page synthetic vault', (t) => {
  const dir = temp(t), vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(vault, `${String(i).padStart(4, '0')}.md`), `---\ntitle: Topic ${i}\n---\nSynthetic common content number ${i}.`);
  const searcher = createSearcher({ vaultDir: vault, stateDir: state, now });
  for (let i = 0; i < 2; i++) searcher.search('topic 1234');
  const timings = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    searcher.search('topic 1234');
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  t.diagnostic(`Warm 2000-page query median: ${median.toFixed(2)} ms`);
  assert.ok(median < 300, `median ${median.toFixed(2)} ms`);
});
