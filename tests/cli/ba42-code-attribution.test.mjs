// SPDX-License-Identifier: MIT
// BA-42: `maintain --repo` code attribution. Module-level tests: `repo:` sources and the optional `symbols:` field are
// checked against a repository working tree (stale-source, stale-symbol). Hermetic: temporary directories only, no git,
// no network, nothing is written inside the vault or the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, lstat, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FINDING_KINDS,
  KINDS,
  formatMaintenance,
  receiptCandidates,
  runMaintenance,
} from '../../packages/cli/src/maintain.mjs';

const NOW = new Date('2026-11-11T00:00:00Z');
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
const page = ({ title = 'A', sources = [], symbols, status = 'proposed', body = 'Body text.' } = {}) => {
  const lines = [
    '---',
    'type: concept',
    'generated: "2026-11-01"',
    `status: ${status}`,
    `sources: ${JSON.stringify(sources)}`,
    'verified: []',
    'stale_after: "P90D"',
    'aliases: []',
    'keywords: []',
  ];
  if (symbols !== undefined) lines.push(`symbols: ${JSON.stringify(symbols)}`);
  return `${lines.join('\n')}\n---\n\n# ${title}\n\n${body}\n`;
};
const healthy = { 'wiki/index.md': '# Wiki Index\n\n## Pages\n\n- [A](concepts/a.md)\n' };
const ofKind = (report, kind) => report.findings.filter((f) => f.kind === kind);

async function fixture(t, { vault = {}, repo = {}, outside = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'ba42-code-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vaultDir = join(base, 'vault');
  const repoDir = join(base, 'repo');
  await mkdir(vaultDir);
  await mkdir(repoDir);
  for (const [root, files] of [
    [vaultDir, { ...healthy, ...vault }],
    [repoDir, repo],
    [base, outside],
  ]) {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
  }
  return { base, vaultDir, repoDir };
}

const SOURCE_FILE = 'export function computeTotal(items) {\n  return items.length;\n}\nexport const VERSION_TAG = 1;\n';

// ---- Positive and negative cases for `repo:` sources.

test('an existing repository file is accepted, with or without a commit suffix', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        sources: ['repo:src/total.mjs', `repo:src/total.mjs@${COMMIT}`, 'repo:./src//total.mjs@abcdef1'],
      }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  assert.deepEqual(ofKind(report, 'stale-source'), []);
});

test('a missing repository file is reported as stale-source with its repository-relative path', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ sources: ['repo:src/gone.mjs@abcdef1'] }) },
    repo: { 'src/other.mjs': SOURCE_FILE },
  });
  const found = ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-source');
  assert.deepEqual(found, [
    { kind: 'stale-source', path: 'wiki/concepts/a.md', detail: 'repo file not found: src/gone.mjs' },
  ]);
});

test('a moved or renamed repository file makes the old source stale-source', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ sources: ['repo:src/old-name.mjs'] }) },
    repo: { 'lib/new-name.mjs': SOURCE_FILE },
  });
  const found = ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-source');
  assert.equal(found.length, 1);
  assert.equal(found[0].detail, 'repo file not found: src/old-name.mjs');
});

test('a directory is not a regular file and is reported as stale-source', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ sources: ['repo:src'] }) },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  assert.equal(ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-source').length, 1);
});

test('commit suffix: 7 to 64 hex digits, any case, is stripped; other @ text stays part of the path', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        sources: [
          'repo:src/total.mjs@ABCDEF1', // 7 hex, upper case: a commit suffix
          'repo:src/total.mjs@' + 'a'.repeat(64), // 64 hex: a commit suffix
          'repo:src/total.mjs@abcdef', // 6 hex: not a commit, so the path is src/total.mjs@abcdef
          'repo:src/total.mjs@main', // a branch name is not a commit, so the path is src/total.mjs@main
        ],
      }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const found = ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-source')
    .map((f) => f.detail)
    .sort();
  assert.deepEqual(found, ['repo file not found: src/total.mjs@abcdef', 'repo file not found: src/total.mjs@main']);
});

test('a path that leaves the repository is rejected without echoing it, and a file outside the repository is not read', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        sources: [
          'repo:../secret.txt',
          'repo:src/../../secret.txt',
          'repo:/etc/hosts',
          'repo:C:\\Users\\x\\a.mjs',
          'repo:src\\total.mjs',
          'repo:',
          'repo:src/total.mjs/',
        ],
      }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
    outside: { 'secret.txt': 'TOP-SECRET-LINE' },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  const found = ofKind(report, 'stale-source');
  assert.equal(found.length, 7);
  for (const item of found) {
    assert.equal(item.detail, 'repo path is not a file path inside the repository');
    assert.doesNotMatch(item.detail, /secret|etc\/hosts|C:|Users/u);
  }
  assert.doesNotMatch(JSON.stringify(report), /TOP-SECRET/u);
});

test('a symlinked file or a symlinked directory inside the repository is not followed', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({ sources: ['repo:link.mjs', 'repo:linkdir/inner.mjs', 'repo:src/real.mjs'] }),
    },
    repo: { 'src/real.mjs': SOURCE_FILE, 'src/inner.mjs': SOURCE_FILE },
  });
  await symlink(join(repoDir, 'src', 'real.mjs'), join(repoDir, 'link.mjs'));
  await symlink(join(repoDir, 'src'), join(repoDir, 'linkdir'));
  const found = ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-source')
    .map((f) => f.detail)
    .sort();
  assert.deepEqual(found, ['repo file not found: link.mjs', 'repo file not found: linkdir/inner.mjs']);
});

test('a missing repository file named by both sources and symbols is reported once per page', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ sources: ['repo:src/gone.mjs'], symbols: ['src/gone.mjs#computeTotal'] }) },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  assert.equal(ofKind(report, 'stale-source').length, 1);
  assert.deepEqual(ofKind(report, 'stale-symbol'), []);
});

// ---- Positive and negative cases for `symbols:`.

test('present symbols are accepted in both the object and the "path#name" forms', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        symbols: [{ path: 'src/total.mjs', name: 'computeTotal' }, 'src/total.mjs#VERSION_TAG'],
      }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  assert.deepEqual(ofKind(report, 'stale-symbol'), []);
  assert.deepEqual(ofKind(report, 'stale-source'), []);
});

test('a symbol name missing from its repository file is reported as stale-symbol', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        symbols: [{ path: 'src/total.mjs', name: 'renamedFunction' }, 'src/total.mjs#removedThing'],
      }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const found = ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-symbol')
    .map((f) => f.detail)
    .sort();
  assert.deepEqual(found, [
    'symbol not found in repo file: src/total.mjs#removedThing',
    'symbol not found in repo file: src/total.mjs#renamedFunction',
  ]);
});

test('a symbol matches only as a whole word, not as part of a longer identifier', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ symbols: ['src/words.mjs#Foo', 'src/words.mjs#Bar', 'src/words.mjs#Baz'] }) },
    repo: { 'src/words.mjs': 'const FooBar = 1;\nconst Bar_ = 2;\nconst Baz = 3;\n' },
  });
  const found = ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-symbol').map(
    (f) => f.detail
  );
  assert.deepEqual(found, [
    'symbol not found in repo file: src/words.mjs#Bar',
    'symbol not found in repo file: src/words.mjs#Foo',
  ]);
});

test('a symbol name is matched as plain text, never as a regular expression', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ symbols: ['src/re.mjs#a.*', 'src/re.mjs#(a+)+$', 'src/re.mjs#a.c'] }) },
    repo: { 'src/re.mjs': 'const aXYZ = 1;\nconst abc = 2;\n' },
  });
  const found = ofKind(await runMaintenance(vaultDir, { now: NOW, repo: repoDir }), 'stale-symbol')
    .map((f) => f.detail)
    .sort();
  assert.deepEqual(found, [
    'symbol not found in repo file: src/re.mjs#(a+)+$',
    'symbol not found in repo file: src/re.mjs#a.*',
    'symbol not found in repo file: src/re.mjs#a.c',
  ]);
});

test('a symbol whose file is missing is reported as stale-source, not stale-symbol', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ symbols: [{ path: 'src/moved.mjs', name: 'computeTotal' }] }) },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  assert.deepEqual(
    ofKind(report, 'stale-source').map((f) => f.detail),
    ['repo file not found: src/moved.mjs']
  );
  assert.deepEqual(ofKind(report, 'stale-symbol'), []);
});

test('malformed symbols entries are silently ignored, and no other finding is produced for them', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        symbols: [
          42,
          null,
          true,
          ['src/total.mjs', 'computeTotal'],
          'nohash',
          '#computeTotal',
          'src/total.mjs#',
          { path: 'src/total.mjs' },
          { name: 'computeTotal' },
          { path: 3, name: 'computeTotal' },
          { path: 'src/total.mjs', name: '' },
          { path: 'src/total.mjs', name: 'line\nbreak' },
          { path: 'src/total.mjs', name: 'x'.repeat(201) },
          { path: '   ', name: 'computeTotal' },
        ],
      }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  assert.deepEqual(ofKind(report, 'stale-symbol'), []);
  assert.deepEqual(ofKind(report, 'stale-source'), []);
});

test('a symbols field that is not a list is ignored', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ symbols: 'src/total.mjs#missing' }) },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  assert.deepEqual(ofKind(report, 'stale-symbol'), []);
});

// ---- Without --repo: no repository is read, and existing behaviour is unchanged.

test('without repo, broken code references produce no stale-source or stale-symbol findings', async (t) => {
  const { vaultDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ sources: ['repo:src/gone.mjs'], symbols: ['src/gone.mjs#missing'] }) },
  });
  const report = await runMaintenance(vaultDir, { now: NOW });
  assert.deepEqual(ofKind(report, 'stale-source'), []);
  assert.deepEqual(ofKind(report, 'stale-symbol'), []);
});

test('without repo, the findings and counts match the pre-BA-42 golden output', async (t) => {
  const { vaultDir } = await fixture(t, {
    vault: {
      'wiki/index.md':
        '# Wiki Index\n\n## Pages\n\n- [A](concepts/a.md)\n- [S](concepts/stale.md)\n- [Long](concepts/long.md)\n',
      'wiki/concepts/a.md': page({
        body: 'Links [[B]] and [[Nope]] and [x](missing.md) and [y](long.md).',
        sources: [`repo:src/x.mjs@abcdef1`],
      }),
      'wiki/concepts/stale.md': page({ title: 'Stale', body: 'Old.' }).replace(
        'stale_after: "P90D"',
        'stale_after: "2026-11-05"'
      ),
      'wiki/concepts/b.md': page({ title: 'B', status: 'superseded', body: 'Old text.' }).replace(
        'status: superseded',
        'status: superseded\nsuperseded_by: wiki/concepts/c.md'
      ),
      'wiki/concepts/orphan.md': page({ title: 'Orphan', body: 'Nobody links here.' }),
      'wiki/concepts/long.md': page({ title: 'Long', body: 'lorem '.repeat(3001) }),
    },
  });
  const report = await runMaintenance(vaultDir, { now: NOW });
  const { durationMs, policy, ...stable } = report;
  assert.equal(typeof durationMs, 'number');
  assert.equal(policy.changes[0].action, 'create');
  assert.deepEqual(stable, {
    ok: true,
    findings: [
      {
        kind: 'broken-link',
        path: 'wiki/concepts/a.md',
        detail: 'markdown target not found: wiki/concepts/missing.md',
      },
      { kind: 'broken-link', path: 'wiki/concepts/a.md', detail: 'wikilink target not found: "Nope"' },
      { kind: 'superseded-broken', path: 'wiki/concepts/b.md', detail: 'superseded_by target is missing' },
      { kind: 'index-missing', path: 'wiki/concepts/b.md', detail: 'page is not listed in the index' },
      { kind: 'oversized', path: 'wiki/concepts/long.md', detail: 'body has 3003 words (limit 3000)' },
      { kind: 'orphan', path: 'wiki/concepts/orphan.md', detail: 'no page links to it and it is not in the index' },
      { kind: 'index-missing', path: 'wiki/concepts/orphan.md', detail: 'page is not listed in the index' },
      { kind: 'stale', path: 'wiki/concepts/stale.md', detail: 'stale_after 2026-11-05 has passed' },
    ],
    counts: {
      stale: 1,
      'superseded-broken': 1,
      'broken-link': 2,
      orphan: 1,
      'index-missing': 2,
      'index-stale': 0,
      oversized: 1,
      'update-sprawl': 0,
    },
    pages: 5,
  });
});

test('counts keeps exactly the BA-12 keys with and without repo, and the new kinds are listed as finding kinds only', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ sources: ['repo:src/gone.mjs'], symbols: ['src/total.mjs#nope'] }) },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const expectedKeys = [
    'broken-link',
    'index-missing',
    'index-stale',
    'orphan',
    'oversized',
    'stale',
    'superseded-broken',
    'update-sprawl',
  ];
  const withRepo = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  const without = await runMaintenance(vaultDir, { now: NOW });
  assert.deepEqual(Object.keys(withRepo.counts).sort(), expectedKeys);
  assert.deepEqual(Object.keys(without.counts).sort(), expectedKeys);
  assert.deepEqual(KINDS.slice().sort(), expectedKeys);
  assert.ok(FINDING_KINDS.includes('stale-source'));
  assert.ok(FINDING_KINDS.includes('stale-symbol'));
  assert.equal(withRepo.counts['stale-source'], undefined);
  assert.equal(withRepo.counts['stale-symbol'], undefined);
  assert.equal(ofKind(withRepo, 'stale-source').length, 1);
  assert.equal(ofKind(withRepo, 'stale-symbol').length, 1);
});

test('a repository where every reference resolves gives the same findings as no repo at all', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        sources: ['repo:src/total.mjs'],
        symbols: ['src/total.mjs#computeTotal'],
        body: 'Links [[B]].',
      }),
      'wiki/concepts/b.md': page({ title: 'B', body: 'x' }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const withRepo = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  const without = await runMaintenance(vaultDir, { now: NOW });
  assert.deepEqual(withRepo.findings, without.findings);
  assert.deepEqual(withRepo.counts, without.counts);
});

// ---- Repository errors, read-only behaviour and receipts.

test('a missing repository directory or a file given as the repository is E_REPO_MISSING', async (t) => {
  const { vaultDir, base } = await fixture(t, { vault: { 'wiki/concepts/a.md': page({ sources: ['repo:x.mjs'] }) } });
  await writeFile(join(base, 'plain.txt'), 'not a directory');
  for (const repo of [join(base, 'absent'), join(base, 'plain.txt')]) {
    await assert.rejects(
      runMaintenance(vaultDir, { now: NOW, repo }),
      (err) => err.code === 'E_REPO_MISSING' && !String(err.message).includes(base)
    );
  }
});

async function tree(root) {
  const out = [];
  async function visit(rel) {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const info = await lstat(join(root, child));
      out.push([
        child,
        info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file',
        info.size,
        info.mtimeMs,
        info.isFile() ? await readFile(join(root, child), 'utf8') : null,
      ]);
      if (info.isDirectory()) await visit(child);
    }
  }
  await visit('');
  return JSON.stringify(out.sort());
}

test('runMaintenance with repo leaves the vault and the repository byte-identical', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: {
      'wiki/concepts/a.md': page({
        sources: ['repo:src/gone.mjs', 'repo:src/total.mjs'],
        symbols: ['src/total.mjs#nope'],
      }),
    },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const beforeVault = await tree(vaultDir);
  const beforeRepo = await tree(repoDir);
  await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  assert.equal(await tree(vaultDir), beforeVault);
  assert.equal(await tree(repoDir), beforeRepo);
});

test('the human output and the receipt candidates name the new kinds by path, with no file content', async (t) => {
  const { vaultDir, repoDir } = await fixture(t, {
    vault: { 'wiki/concepts/a.md': page({ sources: ['repo:src/gone.mjs'], symbols: ['src/total.mjs#secretNameX'] }) },
    repo: { 'src/total.mjs': SOURCE_FILE },
  });
  const report = await runMaintenance(vaultDir, { now: NOW, repo: repoDir });
  const text = formatMaintenance(report);
  assert.match(text, /stale-source \(1\)/u);
  assert.match(text, /stale-symbol \(1\)/u);
  assert.match(text, /wiki\/concepts\/a\.md: repo file not found: src\/gone\.mjs/u);
  assert.doesNotMatch(text, /computeTotal|items\.length|VERSION_TAG/u);
  const candidates = receiptCandidates(report.findings);
  const kinds = candidates.map((c) => c.title);
  assert.ok(kinds.includes('Maintenance review: stale-source (1)'));
  assert.ok(kinds.includes('Maintenance review: stale-symbol (1)'));
  assert.equal(JSON.stringify(candidates).includes(repoDir), false);
  assert.equal(JSON.stringify(candidates).includes(vaultDir), false);
});
