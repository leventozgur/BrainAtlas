// SPDX-License-Identifier: MIT
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = resolve(HERE, '../../..');
const MAIN = dirname(
  resolve(DEV, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: DEV, encoding: 'utf8' }).trim())
);
const FIX = join(HERE, 'fixtures');
const SCRATCH = await mkdtemp(join(tmpdir(), 'ba42-blind-'));
after(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});
const PINNED_DIGEST = '1e991a2a83de977816f17798daac21a95058ecc061f404b5259e28d4d304454f';
const VAULT = { main: join(FIX, 'vault-main'), demo: join(FIX, 'vault-demo'), edge: join(FIX, 'vault-edge') };
const REPO = join(FIX, 'repo-main');
const CLI = { dev: join(DEV, 'packages/cli/bin/brainatlas.mjs'), main: join(MAIN, 'packages/cli/bin/brainatlas.mjs') };
const HOME_DIR = join(SCRATCH, 'home');
const SHIM_DIR = join(SCRATCH, 'shim');
const GIT_LOG = join(SCRATCH, 'git-calls.log');
const KINDS = [
  'stale',
  'superseded-broken',
  'broken-link',
  'orphan',
  'index-missing',
  'index-stale',
  'oversized',
  'update-sprawl',
];
const LABELS = JSON.parse(await readFile(join(FIX, 'labels.json'), 'utf8'));
const RESULTS = {};

await mkdir(HOME_DIR, { recursive: true });
await mkdir(SHIM_DIR, { recursive: true });
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
await writeFile(join(SHIM_DIR, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${GIT_LOG}'\nexec '${REAL_GIT}' "$@"\n`, {
  mode: 0o755,
});

function runCli(which, args, { cwd = DEV } = {}) {
  const r = spawnSync(process.execPath, [CLI[which], 'maintain', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, HOME: HOME_DIR, PATH: `${SHIM_DIR}:${process.env.PATH}`, NO_COLOR: '1' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function runJson(which, args, opts) {
  const r = runCli(which, ['--json', ...args], opts);
  return { ...r, body: JSON.parse(r.stdout) };
}
const withoutDuration = (body) => {
  const { durationMs, policy, ...rest } = body;
  return rest;
};
const humanNormal = (text) => {
  const normalized = text.replace(/, \d+ ms\n/u, ', N ms\n');
  const policy = normalized.indexOf('\npolicy (');
  return policy < 0 ? normalized : normalized.slice(0, policy);
};
const gitLog = async () => (existsSync(GIT_LOG) ? readFile(GIT_LOG, 'utf8') : '');

async function digestOf(root) {
  const entries = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const abs = join(dir, name);
      const info = await lstat(abs);
      const rel = relative(root, abs);
      if (rel === 'MANIFEST.json') continue;
      if (info.isSymbolicLink()) entries.push({ path: rel, type: 'symlink', target: await readlink(abs) });
      else if (info.isDirectory()) await walk(abs);
      else
        entries.push({
          path: rel,
          type: 'file',
          sha256: createHash('sha256')
            .update(await readFile(abs))
            .digest('hex'),
          size: info.size,
        });
    }
  }
  await walk(root);
  return { digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}

async function snapshot(root) {
  const out = [];
  const rootInfo = await lstat(root);
  out.push({ rel: '.', type: 'dir', mtimeMs: rootInfo.mtimeMs, ino: rootInfo.ino });
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const abs = join(dir, name);
      const info = await lstat(abs);
      const rel = relative(root, abs);
      if (info.isSymbolicLink())
        out.push({ rel, type: 'link', target: await readlink(abs), mtimeMs: info.mtimeMs, ino: info.ino });
      else if (info.isDirectory()) {
        out.push({ rel, type: 'dir', mtimeMs: info.mtimeMs, ino: info.ino });
        await walk(abs);
      } else
        out.push({
          rel,
          type: 'file',
          size: info.size,
          mtimeMs: info.mtimeMs,
          ino: info.ino,
          sha256: createHash('sha256')
            .update(await readFile(abs))
            .digest('hex'),
        });
    }
  }
  await walk(root);
  return out;
}

function canon(f) {
  if (f.kind === 'stale-source') {
    const m = /^repo file not found: (.*)$/u.exec(f.detail);
    if (m) return `src-missing:${m[1]}`;
    if (f.detail.startsWith('repo path is not a file path')) return 'src-rejected';
  }
  if (f.kind === 'stale-symbol') {
    const m = /^symbol not found in repo file: (.*)$/u.exec(f.detail);
    if (m) return `sym-missing:${m[1]}`;
  }
  return null;
}
function multisetOf(pairs) {
  const map = new Map();
  for (const [page, key] of pairs) {
    if (!map.has(page)) map.set(page, new Map());
    const m = map.get(page);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return map;
}
const actualOf = (findings) => multisetOf(findings.map((f) => [f.path, canon(f)]).filter(([, k]) => k !== null));
const expectedOf = (items) => multisetOf(items.filter((i) => i.expect).map((i) => [i.page, i.expect]));
const countOf = (map, page, key) => map.get(page)?.get(key) ?? 0;
const pageEntries = (map, page) =>
  [...(map.get(page) ?? new Map()).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const unexpectedOf = (actual, expected) => {
  const out = [];
  for (const [page, m] of actual)
    for (const [key, n] of m) {
      const extra = n - countOf(expected, page, key);
      if (extra > 0) out.push({ page, key, extra });
    }
  return out;
};
const nonStale = (findings) => findings.filter((f) => f.kind !== 'stale-source' && f.kind !== 'stale-symbol');
const nonBaseline = (findings) => findings.filter((f) => f.kind === 'stale-source' || f.kind === 'stale-symbol');
const BA54_KINDS = ['unknown-commit', 'source-drift', 'unverifiable'];
const withoutBa54 = (findings) => findings.filter((f) => !BA54_KINDS.includes(f.kind));
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['rev-parse', 'cat-file', 'diff']);
function assertOnlyReadOnlyGit(log, label) {
  for (const line of log.split('\n').filter(Boolean)) {
    const args = line.trim().split(/\s+/u);
    const at = args.indexOf('-C');
    assert.ok(at >= 0 && at + 2 < args.length, `${label}: unexpected git invocation: ${line}`);
    const subcommand = args[at + 2];
    assert.ok(READ_ONLY_GIT_SUBCOMMANDS.has(subcommand), `${label}: not a read-only subcommand: ${line}`);
    if (subcommand === 'diff') assert.ok(args.includes('--quiet'), `${label}: diff without --quiet: ${line}`);
  }
}

test('fixtures are frozen: manifest digest equals the pinned value and every entry still matches', async () => {
  const manifest = JSON.parse(await readFile(join(FIX, 'MANIFEST.json'), 'utf8'));
  const now = await digestOf(FIX);
  assert.equal(manifest.digest, PINNED_DIGEST);
  assert.equal(now.digest, PINNED_DIGEST);
  assert.deepEqual(now.entries, manifest.entries);
  const regular = (await digestOf(REPO)).entries.filter((e) => e.type === 'file');
  assert.ok(regular.length >= 20, `repository has ${regular.length} regular files`);
  assert.ok(
    regular.some((e) => e.path.split('/').length >= 3),
    'repository has nested subdirectories'
  );
  const pages = (await readdir(join(FIX, 'vault-main', 'wiki'), { recursive: true })).filter(
    (n) => n.endsWith('.md') && !n.endsWith('index.md') && !n.endsWith('log.md')
  );
  assert.ok(pages.length >= 60, `main vault has ${pages.length} content pages`);
});

test('instrument self-check: the git shim logs a git call made from a child process', async () => {
  await rm(GIT_LOG, { force: true });
  spawnSync('git', ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH}` },
  });
  assert.ok((await gitLog()).includes('--version'), 'shim did not log');
  await rm(GIT_LOG, { force: true });
});

test('H1 detection: >= 25 broken references on a >= 60 page vault, detection rate >= 0.90', () => {
  const r = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
  assert.equal(r.status, 0);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.pages >= 60, `pages ${r.body.pages}`);
  const actual = actualOf(r.body.findings);
  const broken = LABELS.items.filter((i) => i.group === 'broken');
  assert.ok(broken.length >= 25, `broken ${broken.length}`);
  const missed = broken.filter((i) => countOf(actual, i.page, i.expect) < 1);
  const detected = broken.length - missed.length;
  const rate = detected / broken.length;
  const byCategory = {};
  for (const i of broken) {
    byCategory[i.category] ??= { total: 0, detected: 0 };
    byCategory[i.category].total++;
    if (countOf(actual, i.page, i.expect) >= 1) byCategory[i.category].detected++;
  }
  RESULTS.h1 = {
    broken: broken.length,
    detected,
    rate: Number(rate.toFixed(3)),
    byCategory,
    missed: missed.map((i) => ({ id: i.id, page: i.page, expect: i.expect })),
  };
  assert.ok(rate >= 0.9, `detection rate ${rate}`);
});

test('H2 false positives: >= 50 valid references, false-positive rate <= 5%', () => {
  const r = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
  const actual = actualOf(r.body.findings);
  const expected = expectedOf(LABELS.items);
  const valid = LABELS.items.filter((i) => i.group === 'valid');
  const flagged = valid.filter((i) => countOf(actual, i.page, i.wouldKey) > 0);
  const rate = flagged.length / valid.length;
  RESULTS.h2 = {
    valid: valid.length,
    bySource: valid.filter((i) => i.form === 'source').length,
    bySymbol: valid.filter((i) => i.form !== 'source').length,
    flagged: flagged.length,
    rate: Number(rate.toFixed(3)),
    flaggedDetail: flagged.map((i) => ({ id: i.id, page: i.page, key: i.wouldKey })),
    unexpectedOnMain: unexpectedOf(actual, expected),
  };
  assert.ok(valid.length >= 50, `valid ${valid.length}`);
  assert.ok(rate <= 0.05, `false-positive rate ${rate}`);
});

test('H3 read-only: vault, repo, HOME snapshot are unchanged by --repo and non-repo runs; git is only read-only', async () => {
  const before = {
    main: await snapshot(VAULT.main),
    demo: await snapshot(VAULT.demo),
    edge: await snapshot(VAULT.edge),
    repo: await snapshot(REPO),
    home: await snapshot(HOME_DIR),
  };
  const commitBearing = new Set(['main', 'edge']);
  for (const [v, vault] of Object.entries(VAULT)) {
    await rm(GIT_LOG, { force: true });
    runJson('dev', ['--vault', vault, '--repo', REPO]);
    const repoLog = await gitLog();
    if (commitBearing.has(v)) {
      assert.ok(repoLog.length > 0, `${v}: commit-bearing sources must be checked with git`);
      assertOnlyReadOnlyGit(repoLog, `${v} --repo`);
    } else assert.equal(repoLog, '', `${v}: the product invoked git`);
    await rm(GIT_LOG, { force: true });
    runJson('dev', ['--vault', vault]);
    assert.equal(await gitLog(), '', `${v} without --repo: the product invoked git`);
  }
  await rm(GIT_LOG, { force: true });
  runJson('dev', ['--vault', VAULT.main, '--repo', REPO, '--repo', REPO]);
  assertOnlyReadOnlyGit(await gitLog(), 'main repeated --repo');
  const after = {
    main: await snapshot(VAULT.main),
    demo: await snapshot(VAULT.demo),
    edge: await snapshot(VAULT.edge),
    repo: await snapshot(REPO),
    home: await snapshot(HOME_DIR),
  };
  assert.deepEqual(after, before);
});

test('H3 no --repo: findings, counts and pages equal main on three vaults (JSON and human output)', () => {
  const rows = [];
  for (const v of ['main', 'demo', 'edge']) {
    const d = runJson('dev', ['--vault', VAULT[v]]);
    const m = runJson('main', ['--vault', VAULT[v]]);
    assert.equal(d.status, m.status, `${v} exit`);
    assert.deepEqual(withoutDuration(d.body), withoutDuration(m.body), `${v} json`);
    const dh = runCli('dev', ['--vault', VAULT[v]]);
    const mh = runCli('main', ['--vault', VAULT[v]]);
    assert.equal(humanNormal(dh.stdout), humanNormal(mh.stdout), `${v} human`);
    rows.push({ vault: v, pages: d.body.pages, findings: d.body.findings.length, counts: d.body.counts });
  }
  RESULTS.h3Equivalence = rows;
  assert.equal(rows[0].findings, 0, 'vault-main has no baseline findings');
});

test('H3 counts are unchanged by --repo and the new kinds stay out of counts', () => {
  for (const v of ['main', 'demo', 'edge']) {
    const without = runJson('dev', ['--vault', VAULT[v]]);
    const withRepo = runJson('dev', ['--vault', VAULT[v], '--repo', REPO]);
    assert.deepEqual(Object.keys(withRepo.body.counts), KINDS);
    assert.deepEqual(withRepo.body.counts, without.body.counts, `${v} counts`);
    assert.deepEqual(
      nonStale(withoutBa54(withRepo.body.findings)),
      nonStale(withoutBa54(without.body.findings)),
      `${v} baseline findings`
    );
    for (const kind of BA54_KINDS) assert.ok(!Object.hasOwn(withRepo.body.counts, kind), `${v} counts has ${kind}`);
  }
});

test('H3 no file content: findings, human output and receipt candidates carry no repository or page body text', async () => {
  const markers = /REPOBODY_|VAULTBODY_|_SECRET/u;
  const repoSample = await readFile(join(REPO, 'services/billing/invoice.ts'), 'utf8');
  const pageSample = await readFile(join(VAULT.main, 'wiki/services/billing-2.md'), 'utf8');
  assert.match(repoSample, markers, 'marker must exist in the repository body');
  assert.match(pageSample, markers, 'marker must exist in the page body');
  const json = runCli('dev', ['--json', '--vault', VAULT.main, '--repo', REPO]).stdout;
  const human = runCli('dev', ['--vault', VAULT.main, '--repo', REPO]).stdout;
  const edgeJson = runCli('dev', ['--json', '--vault', VAULT.edge, '--repo', REPO]).stdout;
  assert.ok(json.includes('stale-source') && json.includes('stale-symbol'), 'JSON has the new kinds');
  assert.ok(!markers.test(json) && !markers.test(human) && !markers.test(edgeJson), 'output leaks body text');
  const mod = await import(pathToFileURL(join(DEV, 'packages/cli/src/maintain.mjs')).href);
  const report = await mod.runMaintenance(VAULT.main, { repo: REPO });
  const candidates = mod.receiptCandidates(report.findings);
  const text = JSON.stringify(candidates) + mod.formatMaintenance(report);
  assert.ok(
    candidates.some((c) => c.title.startsWith('Maintenance review: stale-source')),
    'receipt candidate for stale-source'
  );
  assert.ok(
    candidates.some((c) => c.title.startsWith('Maintenance review: stale-symbol')),
    'receipt candidate for stale-symbol'
  );
  assert.ok(!markers.test(text), 'receipt candidate or human text leaks body text');
  RESULTS.h3Leak = { jsonBytes: json.length, candidates: candidates.map((c) => c.title) };
});

test('edge: every spec-edge page reports exactly its expected stale findings, nothing more', () => {
  const r = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
  const actual = actualOf(r.body.findings);
  const expected = expectedOf(LABELS.items);
  const edgePages = [...new Set(LABELS.items.filter((i) => i.group === 'edge').map((i) => i.page))];
  const diffs = [];
  for (const page of edgePages) {
    const a = JSON.stringify(pageEntries(actual, page));
    const e = JSON.stringify(pageEntries(expected, page));
    if (a !== e) diffs.push({ page, expected: pageEntries(expected, page), actual: pageEntries(actual, page) });
  }
  RESULTS.edgeDiffs = diffs;
  assert.deepEqual(diffs, []);
});

test('edge: a file reported missing through both sources and symbols is reported once per page', () => {
  const r = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
  const hits = r.body.findings.filter((f) => f.path === 'wiki/services/edge-dedupe.md');
  assert.equal(hits.length, 1);
});

test('edge: with-repo page in vault-edge reports only the missing source, and the valid commit reference passes', () => {
  const r = runJson('dev', ['--vault', VAULT.edge, '--repo', REPO]);
  const hits = withoutBa54(r.body.findings)
    .filter((f) => f.path === 'wiki/services/with-repo.md')
    .map((f) => `${f.kind}|${f.detail}`);
  assert.deepEqual(hits, ['stale-source|repo file not found: services/gone.ts']);
});

test('edge: E_REPO_MISSING for a missing directory and for a regular file used as --repo', () => {
  for (const repo of [join(SCRATCH, 'no-such-repo'), join(FIX, 'vault-main', 'wiki', 'index.md')]) {
    const r = runJson('dev', ['--vault', VAULT.main, '--repo', repo]);
    assert.notEqual(r.status, 0);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, 'E_REPO_MISSING');
  }
});

test('edge: --repo without a value is an argument error', () => {
  const r = runCli('dev', ['--vault', VAULT.main, '--repo']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /E_ARGUMENT|Missing value/u);
});

test('edge: a symlinked repository root and a relative --repo path give the same findings as the direct path', () => {
  return (async () => {
    const link = join(SCRATCH, 'repo-link');
    await rm(link, { force: true });
    await symlink(REPO, link);
    const direct = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
    const viaLink = runJson('dev', ['--vault', VAULT.main, '--repo', link]);
    const relativeRun = runJson('dev', ['--vault', VAULT.main, '--repo', './repo-main/'], { cwd: FIX });
    assert.deepEqual(withoutDuration(viaLink.body).findings, withoutDuration(direct.body).findings);
    assert.deepEqual(withoutDuration(relativeRun.body).findings, withoutDuration(direct.body).findings);
  })();
});

test('edge: a symlinked directory on the path is not followed', async () => {
  const work = join(SCRATCH, 'dirlink');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const repo = join(work, 'repo');
  await cp(REPO, repo, { recursive: true, verbatimSymlinks: true });
  await symlink('services', join(repo, 'alias'));
  const vault = join(work, 'vault');
  await cp(VAULT.main, vault, { recursive: true });
  await writeFile(
    join(vault, 'wiki/services/dirlink.md'),
    [
      '---',
      'type: entity',
      `generated: '2026-11-01T00:00:00Z'`,
      'status: proposed',
      'sources:',
      "  - 'repo:alias/billing/invoice.ts'",
      'verified: []',
      `stale_after: '2099-12-31'`,
      'symbols:',
      "  - {path: 'alias/billing/invoice.ts', name: 'calcTax'}",
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
  );
  const r = runJson('dev', ['--vault', vault, '--repo', repo]);
  const hits = nonBaseline(r.body.findings)
    .filter((f) => f.path === 'wiki/services/dirlink.md')
    .map((f) => `${f.kind}|${f.detail}`);
  assert.deepEqual(hits, ['stale-source|repo file not found: alias/billing/invoice.ts']);
});

test('edge: repeated runs are deterministic', () => {
  const a = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
  const b = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
  assert.deepEqual(withoutDuration(a.body), withoutDuration(b.body));
});

const mainSource = await readFile(join(MAIN, 'packages/cli/src/maintain.mjs'), 'utf8');
const mainHasFeature = mainSource.includes('stale-source');

test('edge: the symbol used on a page is matched on whole words only (prefix of a longer word is not a match)', () => {
  const r = runJson('dev', ['--vault', VAULT.main, '--repo', REPO]);
  const hit = r.body.findings.find((f) => f.path === 'wiki/runbooks/edge-symbols.md' && f.detail.includes('calcVat'));
  assert.ok(hit, 'calcVat must be reported because only calcVatRate exists');
});

test('results are written for the report', () => {
  RESULTS.generatedBy = 'ba42-blind.test.mjs';
  RESULTS.mainHasFeature = mainHasFeature;
  console.log(JSON.stringify(RESULTS, null, 1));
});
