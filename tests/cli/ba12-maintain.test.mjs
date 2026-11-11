// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMaintenance, receiptCandidates } from '../../packages/cli/src/maintain.mjs';
import { cleanEnv } from './clean-env.mjs';

const NOW = new Date('2026-11-11T00:00:00Z');

async function vaultWith(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'ba12-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  }
  return dir;
}
const page = ({ title = 'Page', generated = '2026-11-01', stale = 'P90D', status = 'confirmed', extra = '', body = '' } = {}) =>
  `---\ntype: concept\ngenerated: "${generated}"\nstatus: ${status}\nsources: []\nverified: []\nstale_after: "${stale}"\naliases: []\nkeywords: []\n${extra}---\n\n# ${title}\n\n${body}\n`;
const index = (...entries) => `# Wiki Index\n\n## Pages\n\n${entries.map(e => `- [${e[0]}](${e[1]})`).join('\n')}\n`;
const kinds = report => report.findings.map(f => `${f.kind}:${f.path}`);
const of = (report, kind) => report.findings.filter(f => f.kind === kind);

test('a clean vault yields zero findings', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'entities/a.md'], ['B', 'concepts/b.md']),
    'wiki/entities/a.md': page({ title: 'A', body: 'Links to [[B]] and to [b](../concepts/b.md).' }),
    'wiki/concepts/b.md': page({ title: 'B', body: 'Back to [[A]].' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.equal(report.ok, true);
  assert.equal(report.pages, 2);
  assert.deepEqual(report.findings, []);
  assert.equal(Object.values(report.counts).reduce((a, b) => a + b, 0), 0);
  assert.equal(typeof report.durationMs, 'number');
});

test('stale: expired duration and date are reported, unexpired and future dates are not', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['Old', 'concepts/old.md'], ['Fresh', 'concepts/fresh.md'], ['Future', 'concepts/future.md'], ['Week', 'concepts/week.md']),
    'wiki/concepts/old.md': page({ generated: '2026-01-01', stale: 'P30D', title: 'Old' }),
    'wiki/concepts/fresh.md': page({ generated: '2026-11-01', stale: 'P90D', title: 'Fresh' }),
    'wiki/concepts/future.md': page({ generated: '2026-01-01', stale: '2027-01-01', title: 'Future' }),
    'wiki/concepts/week.md': page({ generated: '2026-10-01', stale: 'P2W', title: 'Week' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(of(report, 'stale').map(f => f.path), ['wiki/concepts/old.md', 'wiki/concepts/week.md']);
});

test('superseded-broken: missing target, superseded target, and loops', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['M', 'concepts/missing.md'], ['S', 'concepts/s.md'], ['T', 'concepts/t.md'], ['L1', 'concepts/l1.md'], ['L2', 'concepts/l2.md'], ['Ok', 'concepts/ok.md']),
    'wiki/concepts/missing.md': page({ status: 'superseded', extra: 'superseded_by: "wiki/concepts/none.md"\n' }),
    'wiki/concepts/s.md': page({ status: 'superseded', extra: 'superseded_by: "wiki/concepts/t.md"\n' }),
    'wiki/concepts/t.md': page({ status: 'superseded', extra: 'superseded_by: "wiki/concepts/ok.md"\n' }),
    'wiki/concepts/l1.md': page({ status: 'superseded', extra: 'superseded_by: "wiki/concepts/l2.md"\n' }),
    'wiki/concepts/l2.md': page({ status: 'superseded', extra: 'superseded_by: "wiki/concepts/l1.md"\n' }),
    'wiki/concepts/ok.md': page({ status: 'confirmed' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  const found = Object.fromEntries(of(report, 'superseded-broken').map(f => [f.path, f.detail]));
  assert.match(found['wiki/concepts/missing.md'], /missing/);
  assert.match(found['wiki/concepts/s.md'], /itself superseded/);
  assert.match(found['wiki/concepts/l1.md'], /loops/);
  assert.match(found['wiki/concepts/l2.md'], /loops/);
  assert.equal(found['wiki/concepts/ok.md'], undefined);
  assert.equal(found['wiki/concepts/t.md'], undefined);
});

test('superseded_by pointing to a valid, non-superseded replacement is clean', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['Old', 'concepts/old.md'], ['New', 'concepts/new.md']),
    'wiki/concepts/old.md': page({ status: 'superseded', extra: 'superseded_by: "wiki/concepts/new.md"\n' }),
    'wiki/concepts/new.md': page({ title: 'New' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(of(report, 'superseded-broken'), []);
  assert.deepEqual(of(report, 'orphan'), []);
});

test('broken-link: wikilinks resolve by name, alias, label and section; unknown and ambiguous names are reported', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'entities/a.md'], ['B', 'concepts/b.md'], ['D1', 'a/dup.md'], ['D2', 'b/dup.md'], ['Alt', 'concepts/alt.md']),
    'wiki/entities/a.md': page({ title: 'A', body: '[[b|label]] [[b#sec]] [[alt name]] [[nowhere]] [[dup]]' }),
    'wiki/concepts/b.md': page({ title: 'B' }),
    'wiki/concepts/alt.md': `---\ntype: concept\ngenerated: "2026-11-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: "P90D"\naliases:\n  - "Alt Name"\nkeywords: []\n---\n\n# Alt\n`,
    'wiki/a/dup.md': page({ title: 'Dup one' }),
    'wiki/b/dup.md': page({ title: 'Dup two' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  const broken = of(report, 'broken-link');
  assert.equal(broken.length, 2, JSON.stringify(broken));
  assert.ok(broken.some(f => /not found: "nowhere"/.test(f.detail)));
  assert.ok(broken.some(f => /ambiguous: "dup"/.test(f.detail)));
});

test('broken-link: Markdown links resolve from the page folder; code is skipped; links leaving the vault are ignored', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md'], ['B', 'concepts/b.md']),
    'wiki/concepts/a.md': page({
      title: 'A',
      body: [
        'Good [b](b.md#anchor) and [ext](https://example.org/x.md) and [img](pic.png).',
        'Bad [gone](gone.md) and [up](../../../outside.md).',
        '```',
        '[[code-only]] [x](code-only.md)',
        '```',
        'Inline `[[inline-only]]` is code.',
      ].join('\n'),
    }),
    'wiki/concepts/b.md': page({ title: 'B' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  const broken = of(report, 'broken-link');
  assert.equal(broken.length, 1, JSON.stringify(broken));
  assert.match(broken[0].detail, /markdown target not found: wiki\/concepts\/gone\.md/);
});

test('orphan: unlinked and unindexed pages are reported; indexed or linked pages are not', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['Indexed', 'concepts/indexed.md'], ['Linked', 'concepts/linked.md']),
    'wiki/concepts/indexed.md': page({ title: 'Indexed' }),
    'wiki/concepts/linked.md': page({ title: 'Linked' }),
    'wiki/concepts/lonely.md': page({ title: 'Lonely' }),
    'wiki/concepts/host.md': page({ title: 'Host', body: 'See [[Linked]].' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(of(report, 'orphan').map(f => f.path), ['wiki/concepts/host.md', 'wiki/concepts/lonely.md']);
});

test('index-missing: unlisted pages, and a whole missing index is one finding', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A' }),
    'wiki/concepts/b.md': page({ title: 'B', body: '[[A]]' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(of(report, 'index-missing').map(f => f.path), ['wiki/concepts/b.md']);

  const bare = await vaultWith(t, { 'wiki/concepts/only.md': page({ title: 'Only' }) });
  const missing = await runMaintenance(bare, { now: NOW });
  assert.deepEqual(of(missing, 'index-missing').map(f => f.path), ['wiki/index.md']);
});

test('index-stale: missing targets are reported; anchors, escaped parentheses, angle brackets, fences and external links are read as the MCP index does', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': [
      '# Wiki Index', '',
      '## Concepts', '',
      '- [Anchored](concepts/a.md#section)',
      '- [Escaped](concepts/paren\\(1\\).md)',
      '- [Spaced](<concepts/b c.md>)',
      '- [External](https://example.org/z.md)',
      '- [Gone](concepts/gone.md)',
      '```',
      '- [Fenced](concepts/fenced-only.md)',
      '```',
      '',
    ].join('\n'),
    'wiki/concepts/a.md': page({ title: 'A' }),
    'wiki/concepts/paren(1).md': page({ title: 'Paren' }),
    'wiki/concepts/b c.md': page({ title: 'Spaced' }),
    'wiki/concepts/fenced-only.md': page({ title: 'Fenced' }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(of(report, 'index-stale').map(f => f.detail), ['entry target not found: concepts/gone.md']);
  assert.deepEqual(of(report, 'index-missing').map(f => f.path), ['wiki/concepts/fenced-only.md']);
});

test('oversized: more than 3000 body words is reported, 3000 is not', async t => {
  // The heading line is part of the body and "# Big" counts as two words: 2999 + 2 = 3001 (over), 2998 + 2 = 3000 (at limit).
  const big = Array.from({ length: 2999 }, () => 'word').join(' ');
  const ok = Array.from({ length: 2998 }, () => 'word').join(' ');
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['Big', 'concepts/big.md'], ['Ok', 'concepts/ok.md']),
    'wiki/concepts/big.md': page({ title: 'Big', body: big }),
    'wiki/concepts/ok.md': page({ title: 'Ok', body: ok }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(of(report, 'oversized').map(f => f.path), ['wiki/concepts/big.md']);
});

test('update-sprawl: six dated Update or Güncelleme headings are reported, five and undated headings are not', async t => {
  const dated = n => Array.from({ length: n }, (_, i) => `## Update 2026-01-0${i + 1}\n\ntext`).join('\n\n');
  const mixed = '## Güncelleme 2026-02-01\n\n## Update no date\n\n## Update 2026-03-01\n\n## Update 2026-03-02\n\n## Update 2026-03-03\n\n## Update 2026-03-04\n\n## Update 2026-03-05\n';
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['Sprawl', 'concepts/sprawl.md'], ['Five', 'concepts/five.md'], ['Mixed', 'concepts/mixed.md']),
    'wiki/concepts/sprawl.md': page({ title: 'Sprawl', body: dated(6) }),
    'wiki/concepts/five.md': page({ title: 'Five', body: dated(5) }),
    'wiki/concepts/mixed.md': page({ title: 'Mixed', body: mixed }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(of(report, 'update-sprawl').map(f => f.path), ['wiki/concepts/mixed.md', 'wiki/concepts/sprawl.md']);
});

test('symlinked pages and directories are not followed', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'ba12-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'stale.md'), page({ generated: '2020-01-01', stale: 'P1D', title: 'Outside' }));
  await mkdir(join(outside, 'dir'));
  await writeFile(join(outside, 'dir', 'deep.md'), page({ generated: '2020-01-01', stale: 'P1D', title: 'Deep' }));
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A' }),
  });
  await symlink(join(outside, 'stale.md'), join(dir, 'wiki', 'concepts', 'link.md'));
  await symlink(join(outside, 'dir'), join(dir, 'wiki', 'linkdir'));
  const report = await runMaintenance(dir, { now: NOW });
  assert.equal(report.pages, 1);
  assert.deepEqual(report.findings, []);
});

test('findings carry counts and paths only, never page body text', async t => {
  const secret = 'SECRET-BODY-TOKEN-7731';
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A', generated: '2020-01-01', stale: 'P1D', body: `${secret} [[nowhere-page]]` }),
  });
  const report = await runMaintenance(dir, { now: NOW });
  assert.ok(report.findings.length >= 2);
  assert.ok(!JSON.stringify(report).includes(secret));
  for (const f of report.findings) assert.deepEqual(Object.keys(f).sort(), ['detail', 'kind', 'path']);
});

test('receipt candidates: one per finding kind, with paths and no content', () => {
  const candidates = receiptCandidates([
    { kind: 'stale', path: 'wiki/a.md', detail: 'x' },
    { kind: 'stale', path: 'wiki/b.md', detail: 'y' },
    { kind: 'orphan', path: 'wiki/c.md', detail: 'z' },
  ]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0].sources, ['wiki/a.md', 'wiki/b.md']);
  assert.deepEqual(receiptCandidates([]), []);
});

test('a missing vault is a coded error', async () => {
  await assert.rejects(runMaintenance(join(tmpdir(), 'ba12-does-not-exist-xyz')), { code: 'E_VAULT_MISSING' });
});

async function snapshot(dir) {
  const out = [];
  async function visit(rel) {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const info = await lstat(join(dir, child));
      if (info.isDirectory()) { out.push(`d ${child} ${info.mtimeMs}`); await visit(child); }
      else out.push(`f ${child} ${info.size} ${info.mtimeMs} ${createHash('sha256').update(await readFile(join(dir, child))).digest('hex')}`);
    }
  }
  await visit('');
  return out.sort();
}

test('CLI: report mode writes nothing, --json is one object, and errors use the JSON error shape', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ba12-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A', generated: '2020-01-01', stale: 'P1D' }),
    'wiki/concepts/b.md': page({ title: 'B' }),
  });
  const env = cleanEnv({ HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1' });
  const run = (...args) => spawnSync(process.execPath, [resolve('packages/cli/bin/brainatlas.mjs'), ...args], { env, encoding: 'utf8', shell: false });
  const before = [await snapshot(dir), await snapshot(home)];
  const json = run('maintain', '--vault', dir, '--json');
  const text = run('maintain', '--vault', dir);
  const after = [await snapshot(dir), await snapshot(home)];
  assert.deepEqual(after, before, 'report mode must not write any file');
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed).sort(), ['counts', 'durationMs', 'findings', 'ok', 'pages']);
  assert.equal(parsed.pages, 2);
  assert.ok(parsed.findings.some(f => f.kind === 'stale' && f.path === 'wiki/concepts/a.md'));
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^BrainAtlas maintenance report \(read-only\)/);
  assert.ok(!json.stdout.includes(dir) && !text.stdout.includes(dir));

  const missing = run('maintain', '--vault', join(home, 'nope'), '--json');
  assert.equal(missing.status, 1);
  const error = JSON.parse(missing.stdout);
  assert.deepEqual(error, { ok: false, error: { code: 'E_VAULT_MISSING', message: 'Vault is missing or not a directory.' } });

  const help = run('help', 'maintain');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /brainatlas maintain \[--json\] \[--vault PATH\] \[--queue\]/);
});
