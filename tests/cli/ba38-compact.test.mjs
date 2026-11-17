// SPDX-License-Identifier: MIT
// BA-38: `brainatlas compact` moves older dated H2 sections verbatim into wiki/archive/<name>-history.md.
// Hermetic: temporary vault and HOME directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultConfig, resolvePaths } from '../../packages/core/src/index.mjs';
import { verifyNoLineLoss, planCompaction, RESERVED_LOCK_FILE_NAME } from '../../packages/cli/src/compact.mjs';
import { LOCK_FILE_NAME } from '../../packages/mcp/src/lock.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const BACK_LINK = '## Archived history';

const head = (title = 'Compaction Page') =>
  `---\ntype: concept\ntitle: ${JSON.stringify(title)}\ngenerated: "2026-11-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: "P90D"\naliases: []\nkeywords: []\n---\n\n# ${title}\n\n`;
const section = (date, label, extra = '') => `## ${date} — ${label}\n\n${label} body.\n${extra}\n`;
const linkText = (name) => `Older dated sections were moved verbatim to [[archive/${name}-history]].\n`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba38-compact-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');
  await writeFile(join(vault, 'wiki', 'log.md'), '# Log\n');
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', shell: false });
  return { base, home, vault, env, run };
}

async function write(dir, rel, text) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function snapshot(root) {
  const out = {};
  async function visit(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        out[childRel] = 'link';
        continue;
      }
      if (entry.isDirectory()) {
        out[childRel] = 'dir';
        await visit(full, childRel);
        continue;
      }
      out[childRel] = await readFile(full, 'utf8');
    }
  }
  await visit(root, '');
  return out;
}

const page6 = () =>
  head() +
  '## Key findings\n\nUndated body.\n\n' +
  section('2026-10-10', 'S1') +
  section('2026-10-01', 'S2') +
  section('2026-10-16', 'S3') +
  section('2026-10-05', 'S4') +
  section('2026-10-14', 'S5') +
  section('2026-10-12', 'S6') +
  '## See also\n\nLink.\n';

const archiveHeader = (page, name, generated) =>
  `---\ntitle: ${JSON.stringify(`History: ${name}`)}\ntype: archive\nstatus: archived\narchived_from: ${JSON.stringify(page)}\ngenerated: ${JSON.stringify(generated)}\n---\n# History: ${name}\n\n`;
const generatedOf = (archive) => {
  const match =
    /^---\ntitle: [^\n]*\ntype: archive\nstatus: archived\narchived_from: [^\n]*\ngenerated: ("(?:[^"\\]|\\.)*")\n---\n/u.exec(
      archive
    );
  assert.ok(match, 'archive frontmatter');
  return JSON.parse(match[1]);
};

test('plan lists the oldest dated sections, keeps the newest three, and writes nothing', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/x.md', page6());
  const beforeVault = await snapshot(f.vault);
  const beforeHome = await snapshot(f.home);
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--plan',
    '--keep',
    '3',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.action, 'compact');
  assert.equal(out.mode, 'plan');
  assert.equal(out.page, 'wiki/concepts/x.md');
  assert.equal(out.archive, 'wiki/archive/concepts--x-history.md');
  assert.equal(out.keep, 3);
  assert.equal(out.olderThan, null);
  assert.deepEqual(out.sections, { h2: 8, dated: 6, current: 0, kept: 3, moved: 3 });
  assert.deepEqual(
    out.moved.map((item) => item.date),
    ['2026-10-10', '2026-10-01', '2026-10-05']
  );
  assert.deepEqual(
    out.moved.map((item) => item.lines),
    [4, 4, 4]
  );
  assert.equal(out.linesMoved, 12);
  assert.equal(out.lineLoss, 0);
  assert.equal(out.written, false);
  assert.ok(out.wordsBefore > out.wordsAfter && out.wordsAfter > 0);
  assert.deepEqual(await snapshot(f.vault), beforeVault);
  assert.deepEqual(await snapshot(f.home), beforeHome);
});

test('apply writes the archive, the compacted page, the back-link and exactly one log entry', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/x.md', page6());
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '3',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.mode, 'apply');
  assert.equal(out.written, true);
  assert.equal(out.lineLoss, 0);
  assert.equal(
    out.undo,
    'To undo: copy the sections listed under "moved" from wiki/archive/concepts--x-history.md back into wiki/concepts/x.md and delete its "## Archived history" section.'
  );

  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'concepts--x-history.md'), 'utf8');
  assert.match(
    archive,
    /^---\ntitle: "History: Compaction Page"\ntype: archive\nstatus: archived\narchived_from: "wiki\/concepts\/x\.md"\ngenerated: "\d{4}-\d{2}-\d{2}T[^"]+"\n---\n# History: Compaction Page\n\n/u
  );
  assert.equal(
    archive,
    archiveHeader('wiki/concepts/x.md', 'Compaction Page', generatedOf(archive)) +
      section('2026-10-10', 'S1') +
      section('2026-10-01', 'S2') +
      section('2026-10-05', 'S4').slice(0, -1)
  );

  const page = await readFile(join(f.vault, 'wiki', 'concepts', 'x.md'), 'utf8');
  const expectedPage =
    head() +
    '## Key findings\n\nUndated body.\n\n' +
    section('2026-10-16', 'S3') +
    section('2026-10-14', 'S5') +
    section('2026-10-12', 'S6') +
    '## See also\n\nLink.\n' +
    `\n${BACK_LINK}\n\n${linkText('concepts--x')}`;
  assert.equal(page, expectedPage);

  const log = await readFile(join(f.vault, 'wiki', 'log.md'), 'utf8');
  const entries = log.split('\n').filter((line) => line.includes('"action":"compact"'));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /"action":"compact","path":"wiki\/concepts\/x\.md"/u);
  assert.equal(log.includes('S1'), false);
  assert.equal(log.includes('Key findings'), false);
});

test('the text output lists the command, the counts, one line per moved section and the undo line', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/x.md', page6());
  const plan = f.run('compact', '--page', 'wiki/concepts/x.md', '--plan', '--keep', '3', '--vault', f.vault);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(
    plan.stdout.trim().split('\n')[0],
    'compact plan: wiki/concepts/x.md → wiki/archive/concepts--x-history.md'
  );
  assert.equal(plan.stdout.includes('To undo:'), false);
  const planned = JSON.parse(
    f.run('compact', '--page', 'wiki/concepts/x.md', '--plan', '--keep', '3', '--vault', f.vault, '--json').stdout
  );
  const result = f.run('compact', '--page', 'wiki/concepts/x.md', '--apply', '--keep', '3', '--vault', f.vault);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'compact apply: wiki/concepts/x.md → wiki/archive/concepts--x-history.md');
  assert.equal(
    lines[1],
    `moved 3 section(s), 12 line(s); kept 3 dated; words ${planned.wordsBefore} → ${planned.wordsAfter}`
  );
  assert.deepEqual(lines.slice(2, 5), [
    '- 2026-10-10  2026-10-10 — S1',
    '- 2026-10-01  2026-10-01 — S2',
    '- 2026-10-05  2026-10-05 — S4',
  ]);
  assert.match(lines[5], /^To undo: /u);
});

test('a second apply moves nothing and leaves the vault and HOME unchanged', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/x.md', page6());
  assert.equal(
    f.run('compact', '--page', 'wiki/concepts/x.md', '--apply', '--keep', '3', '--vault', f.vault).status,
    0
  );
  const beforeVault = await snapshot(f.vault);
  const beforeHome = await snapshot(f.home);
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '3',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.mode, 'apply');
  assert.equal(out.written, false);
  assert.deepEqual(out.moved, []);
  assert.equal(out.linesMoved, 0);
  assert.equal(out.wordsAfter, out.wordsBefore);
  assert.deepEqual(await snapshot(f.vault), beforeVault);
  assert.deepEqual(await snapshot(f.home), beforeHome);
});

test('--older-than keeps candidates on or after the date even beyond --keep', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'wiki/concepts/x.md',
    head() + section('2026-10-10', 'A') + section('2026-09-20', 'B') + section('2026-09-01', 'C')
  );
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--plan',
    '--keep',
    '1',
    '--older-than',
    '2026-09-20',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.olderThan, '2026-09-20');
  assert.deepEqual(
    out.moved.map((item) => item.date),
    ['2026-09-01']
  );
  assert.deepEqual(out.sections, { h2: 3, dated: 3, current: 0, kept: 2, moved: 1 });
});

test('fenced H2 lines are not sections and a fence inside a moved section moves with it', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'wiki/concepts/x.md',
    head() +
      section('2026-10-01', 'Real', '```\n## 2026-09-01 — Not a section\ncode\n```\n') +
      '## 2026-09-02 — Second\n\n~~~\ntext\n~~~\n'
  );
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '0',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.sections.h2, 2);
  assert.equal(out.sections.dated, 2);
  assert.equal(out.sections.moved, 2);
  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'concepts--x-history.md'), 'utf8');
  assert.ok(archive.includes('## 2026-09-01 — Not a section'));
  assert.ok(archive.includes('~~~\ntext\n~~~'));
  assert.equal(archive.split('\n')[0], '---');
});

test('H3 lines move with their section and an H1 ends it', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'wiki/concepts/x.md',
    head() + '## 2026-10-01 — Dated\n\nBody.\n\n### Detail\n\nMore.\n\n# Appendix\n\nUndated.\n'
  );
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '0',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sections.moved, 1);
  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'concepts--x-history.md'), 'utf8');
  assert.ok(archive.includes('### Detail'));
  assert.equal(archive.includes('Appendix'), false);
  const page = await readFile(join(f.vault, 'wiki', 'concepts', 'x.md'), 'utf8');
  assert.ok(page.includes('# Appendix'));
});

test('current headings never move and invalid dates are not dates', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'wiki/concepts/x.md',
    head() +
      '## Current state — 2026-10-01\n\nNow.\n\n' +
      '## Güncel durum (2026-09-01)\n\nNow.\n\n' +
      '## 2026-02-30 — impossible\n\nNo.\n\n' +
      '## 12026-10-10 — overflow\n\nNo.\n\n' +
      '## 2026-09-05 — real\n\nYes.\n\n'
  );
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--plan',
    '--keep',
    '0',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.sections, { h2: 5, dated: 3, current: 2, kept: 0, moved: 1 });
  assert.deepEqual(
    out.moved.map((item) => item.heading),
    ['2026-09-05 — real']
  );
});

test('a CRLF page keeps its carriage returns and the rest of the page byte for byte', async (t) => {
  const f = await fixture(t);
  const crlf = (text) => text.replaceAll('\n', '\r\n');
  await write(
    f.vault,
    'wiki/concepts/crlf.md',
    crlf(head() + section('2026-10-01', 'Old') + section('2026-10-05', 'New') + '## Key findings\n\nUndated.\n')
  );
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/crlf.md',
    '--apply',
    '--keep',
    '1',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).moved[0].date, '2026-10-01');

  const page = await readFile(join(f.vault, 'wiki', 'concepts', 'crlf.md'), 'utf8');
  const expectedPage =
    crlf(head() + section('2026-10-05', 'New') + '## Key findings\n\nUndated.\n') +
    `\n${BACK_LINK}\n\n${linkText('concepts--crlf')}`;
  assert.equal(page, expectedPage);

  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'concepts--crlf-history.md'), 'utf8');
  const moved = archive.slice(archive.indexOf('## 2026-10-01'));
  assert.equal(moved, '## 2026-10-01 — Old\r\n\r\nOld body.\r\n\r\n');
});

test('an existing archive with the same archived_from is appended and its bytes are kept', async (t) => {
  const f = await fixture(t);
  const oldArchive = `---\ntitle: "History: Other"\ntype: archive\nstatus: archived\narchived_from: "wiki/concepts/x.md"\ngenerated: "2026-01-01T00:00:00.000Z"\n---\n# History: Other\n\n## old\n\nkept`;
  await write(f.vault, 'wiki/archive/concepts--x-history.md', oldArchive);
  await write(f.vault, 'wiki/concepts/x.md', head() + section('2026-10-01', 'A') + section('2026-10-05', 'B'));
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '1',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'concepts--x-history.md'), 'utf8');
  assert.equal(archive, `${oldArchive}\n${section('2026-10-01', 'A').slice(0, -1)}`);
});

test('an existing archive for another page fails with E_CONFLICT and changes nothing', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'wiki/archive/concepts--x-history.md',
    '---\narchived_from: "wiki/concepts/other.md"\n---\n\nold\n'
  );
  await write(f.vault, 'wiki/concepts/x.md', head() + section('2026-10-01', 'A') + section('2026-10-05', 'B'));
  const before = await snapshot(f.vault);
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '1',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'E_CONFLICT');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('page path checks reject escapes, reserved pages and symlinks before any read', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/x.md', page6());
  await write(f.base, 'outside.md', page6());
  await symlink(join(f.vault, 'wiki', 'concepts', 'x.md'), join(f.vault, 'wiki', 'concepts', 'linked.md'));
  await mkdir(join(f.base, 'elsewhere'));
  await write(f.base, 'elsewhere/page.md', page6());
  await symlink(join(f.base, 'elsewhere'), join(f.vault, 'wiki', 'linked-dir'));
  await symlink(join(f.base, 'elsewhere'), join(f.vault, 'wiki', 'archive'));

  const cases = [
    ['../x.md', 'E_PATH_ESCAPE'],
    ['wiki/index.md', 'E_PATH_ESCAPE'],
    ['wiki/log.md', 'E_PATH_ESCAPE'],
    ['wiki/archive/a.md', 'E_PATH_ESCAPE'],
    ['wiki/concepts/linked.md', 'E_PATH_ESCAPE'],
    ['wiki/linked-dir/page.md', 'E_PATH_ESCAPE'],
    ['wiki/concepts/missing.md', 'E_NOT_FOUND'],
  ];
  for (const [page, code] of cases) {
    const result = f.run('compact', '--page', page, '--plan', '--vault', f.vault, '--json');
    assert.equal(result.status, 1, page);
    assert.equal(JSON.parse(result.stdout).error.code, code, page);
    assert.equal(result.stdout.includes('S1'), false);
  }
  const archive = f.run('compact', '--page', 'wiki/concepts/x.md', '--plan', '--vault', f.vault, '--json');
  assert.equal(archive.status, 1);
  assert.equal(JSON.parse(archive.stdout).error.code, 'E_PATH_ESCAPE');
});

test('argument errors fail with E_ARGUMENT', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/x.md', page6());
  const cases = [
    ['--page', 'wiki/concepts/x.md', '--vault', f.vault],
    ['--page', 'wiki/concepts/x.md', '--plan', '--apply', '--vault', f.vault],
    ['--page', 'wiki/concepts/x.md', '--plan', '--keep', '1001', '--vault', f.vault],
    ['--page', 'wiki/concepts/x.md', '--plan', '--keep', 'abc', '--vault', f.vault],
    ['--page', 'wiki/concepts/x.md', '--plan', '--keep', '-1', '--vault', f.vault],
    ['--page', 'wiki/concepts/x.md', '--plan', '--older-than', '2026-02-30', '--vault', f.vault],
    ['--page', 'wiki/concepts/x.md', '--plan', '--older-than', '2026-1-1', '--vault', f.vault],
    ['--plan', '--vault', f.vault],
  ];
  for (const args of cases) {
    const result = f.run('compact', ...args, '--json');
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(JSON.parse(result.stdout).error.code, 'E_ARGUMENT', args.join(' '));
  }
});

test('without --vault the configured vault is used', async (t) => {
  const f = await fixture(t);
  const paths = resolvePaths({ platform: 'linux', env: f.env });
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(config));
  await write(f.vault, 'wiki/concepts/x.md', page6());
  const result = f.run('compact', '--page', 'wiki/concepts/x.md', '--plan', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).moved.length, 3);
});

test('forty dated sections keep the original line multiset and page order across page and archive', async (t) => {
  const f = await fixture(t);
  const sections = [];
  for (let index = 0; index < 40; index++) {
    const day = new Date(Date.UTC(2026, 11, 31));
    day.setUTCDate(day.getUTCDate() - index);
    sections.push(section(day.toISOString().slice(0, 10), `Day ${index}`));
  }
  const original = head() + sections.join('');
  await write(f.vault, 'wiki/concepts/x.md', original);
  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '12',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.sections.moved, 28);
  assert.equal(out.lineLoss, 0);

  const page = await readFile(join(f.vault, 'wiki', 'concepts', 'x.md'), 'utf8');
  const suffix = `\n${BACK_LINK}\n\n${linkText('concepts--x')}`;
  assert.ok(page.endsWith(suffix));
  const pagePart = page.slice(0, page.length - suffix.length);
  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'concepts--x-history.md'), 'utf8');
  const archivePart = archive.slice(
    archiveHeader('wiki/concepts/x.md', 'Compaction Page', generatedOf(archive)).length
  );

  const originalLines = original.split('\n');
  const rebuilt = [...pagePart.split('\n'), ...archivePart.split('\n')];
  assert.deepEqual(rebuilt, originalLines);
  const counts = (lines) => lines.reduce((map, line) => ({ ...map, [line]: (map[line] ?? 0) + 1 }), {});
  assert.deepEqual(counts(rebuilt), counts(originalLines));
});

test('help lists compact with its usage and description', async (t) => {
  const f = await fixture(t);
  const all = f.run('--help', '--json');
  assert.equal(all.status, 0, all.stderr);
  const command = JSON.parse(all.stdout).commands.find((item) => item.name === 'compact');
  assert.ok(command);
  assert.match(command.usage, /^brainatlas compact --page wiki\/<path>\.md \(--plan \| --apply\)/u);
  const detail = f.run('help', 'compact');
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /wiki\/archive\/<name>-history\.md/u);
});

test('reserved pages are rejected case-insensitively', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/x.md', page6());
  for (const page of [
    'wiki/LOG.md',
    'wiki/Index.md',
    'wiki/Archive/a.md',
    'wiki/Archive/concepts/x.md',
    'wiki/Concepts/../LOG.md',
  ]) {
    const result = f.run('compact', '--page', page, '--plan', '--vault', f.vault, '--json');
    assert.equal(result.status, 1, page);
    assert.equal(JSON.parse(result.stdout).error.code, 'E_PATH_ESCAPE', page);
  }
});

test('a back-link line with trailing spaces or a carriage return is never duplicated', async (t) => {
  const f = await fixture(t);
  const trailing = head() + section('2026-10-01', 'Old') + '## Archived history  \n\nOld link.\n';
  await write(f.vault, 'wiki/concepts/spaces.md', trailing);
  const spaced = f.run(
    'compact',
    '--page',
    'wiki/concepts/spaces.md',
    '--apply',
    '--keep',
    '0',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(spaced.status, 0, spaced.stderr);
  const spacedPage = await readFile(join(f.vault, 'wiki', 'concepts', 'spaces.md'), 'utf8');
  assert.equal(spacedPage.split('Archived history').length - 1, 1);
  assert.ok(spacedPage.endsWith('## Archived history  \n\nOld link.\n'));

  const crlf = (text) => text.replaceAll('\n', '\r\n');
  await write(
    f.vault,
    'wiki/concepts/cr.md',
    crlf(head() + section('2026-10-01', 'Old') + '## Archived history\n\nOld link.\n')
  );
  const carried = f.run(
    'compact',
    '--page',
    'wiki/concepts/cr.md',
    '--apply',
    '--keep',
    '0',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(carried.status, 0, carried.stderr);
  const crPage = await readFile(join(f.vault, 'wiki', 'concepts', 'cr.md'), 'utf8');
  assert.equal(crPage.split('Archived history').length - 1, 1);
  assert.ok(crPage.endsWith('## Archived history\r\n\r\nOld link.\r\n'));
});

test('the self-check rebuilds the original lines and rejects a lost, extra or reordered line', () => {
  const lines = ['---', 'title: x', '---', '', '## 2026-10-01 — A', '', 'a', '', '## 2026-10-05 — B', '', 'b', ''];
  const moved = [{ start: 4, end: 8 }];
  const suffix = '\n## Archived history\n\nlink\n';
  const kept = [...lines.slice(0, 4), ...lines.slice(8)];
  const code = /self-check/u;
  assert.equal(verifyNoLineLoss(lines, moved, `${kept.join('\n')}${suffix}`, true, suffix), undefined);
  assert.throws(
    () => verifyNoLineLoss(lines, moved, `${kept.filter((_, index) => index !== 3).join('\n')}${suffix}`, true, suffix),
    (error) => error.code === 'E_INTERNAL' && code.test(error.message)
  );
  assert.throws(
    () => verifyNoLineLoss(lines, moved, `${kept.join('\n')}extra${suffix}`, true, suffix),
    (error) => error.code === 'E_INTERNAL'
  );
  const reordered = [kept[0], kept[1], kept[2], kept[3], kept[5], kept[4], kept[6], kept[7]];
  assert.throws(
    () => verifyNoLineLoss(lines, moved, `${reordered.join('\n')}${suffix}`, true, suffix),
    (error) => error.code === 'E_INTERNAL'
  );
  assert.throws(
    () => verifyNoLineLoss(lines, moved, `${kept.join('\n')}${lines[4]}\n${suffix}`, true, suffix),
    (error) => error.code === 'E_INTERNAL'
  );
});

test('a page whose every line is moved compacts to a back-link-only page', async (t) => {
  const f = await fixture(t);
  const original = (section('2026-10-01', 'Old') + section('2026-10-05', 'New')).trimEnd();
  await write(f.vault, 'wiki/bare.md', original);
  const planned = f.run('compact', '--page', 'wiki/bare.md', '--plan', '--keep', '0', '--vault', f.vault, '--json');
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).sections.moved, 2);

  const result = f.run('compact', '--page', 'wiki/bare.md', '--apply', '--keep', '0', '--vault', f.vault, '--json');
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.written, true);
  assert.equal(out.lineLoss, 0);
  assert.equal(out.sections.kept, 0);

  assert.equal(await readFile(join(f.vault, 'wiki', 'bare.md'), 'utf8'), `\n\n${BACK_LINK}\n\n${linkText('bare')}`);
  const archive = await readFile(join(f.vault, 'wiki', 'archive', 'bare-history.md'), 'utf8');
  assert.equal(
    archive,
    archiveHeader('wiki/bare.md', 'bare', generatedOf(archive)) +
      section('2026-10-01', 'Old').slice(0, -1) +
      '\n' +
      section('2026-10-05', 'New').slice(0, -1)
  );

  const again = f.run('compact', '--page', 'wiki/bare.md', '--apply', '--keep', '0', '--vault', f.vault, '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).written, false);
});

test('the self-check handles an empty kept body and still verifies the moved block and the back-link', () => {
  const lines = ['## 2026-10-01 — A', '', 'a', '', '## 2026-10-05 — B', '', 'b'];
  const moved = [{ start: 0, end: 7 }];
  const suffix = `\n${BACK_LINK}\n\nlink\n`;
  assert.equal(verifyNoLineLoss(lines, moved, `\n${suffix}`, true, suffix), undefined);
  assert.throws(
    () => verifyNoLineLoss(lines, moved, `\n${suffix}extra`, true, suffix),
    (error) => error.code === 'E_INTERNAL'
  );
  assert.throws(
    () => verifyNoLineLoss(lines, moved, '\nno back-link', true, suffix),
    (error) => error.code === 'E_INTERNAL'
  );
  assert.throws(
    () => verifyNoLineLoss(lines, moved, '\n\ntoo much kept', true, suffix),
    (error) => error.code === 'E_INTERNAL'
  );
  assert.throws(
    () => verifyNoLineLoss(lines, [{ start: 0, end: 6 }], `\n${suffix}`, true, suffix),
    (error) => error.code === 'E_INTERNAL'
  );
});

test('the reserved lock file name matches the MCP write lock module', () => {
  assert.equal(RESERVED_LOCK_FILE_NAME, LOCK_FILE_NAME);
});

test('an archive that already ends with the moved block is not appended to a second time', async (t) => {
  const f = await fixture(t);
  const original = head() + section('2026-10-01', 'Old') + section('2026-10-05', 'New');
  await write(f.vault, 'wiki/concepts/x.md', original);
  const archive =
    archiveHeader('wiki/concepts/x.md', 'Compaction Page', '2026-01-01T00:00:00.000Z') +
    section('2026-10-01', 'Old').slice(0, -1);
  await write(f.vault, 'wiki/archive/concepts--x-history.md', archive);

  const result = f.run(
    'compact',
    '--page',
    'wiki/concepts/x.md',
    '--apply',
    '--keep',
    '1',
    '--vault',
    f.vault,
    '--json'
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.written, true);
  assert.equal(out.linesMoved, 4);
  assert.equal(await readFile(join(f.vault, 'wiki', 'archive', 'concepts--x-history.md'), 'utf8'), archive);
  assert.equal(
    await readFile(join(f.vault, 'wiki', 'concepts', 'x.md'), 'utf8'),
    head() + section('2026-10-05', 'New') + `\n${BACK_LINK}\n\n${linkText('concepts--x')}`
  );
  const log = await readFile(join(f.vault, 'wiki', 'log.md'), 'utf8');
  assert.equal(log.split('\n').filter((line) => line.includes('"action":"compact"')).length, 1);
});

test('library callers get E_ARGUMENT for bad options before the page path is checked', async () => {
  const bad = { page: '../x.md' };
  await assert.rejects(
    planCompaction('/nonexistent-vault', { ...bad, keep: 5000 }),
    (error) => error.code === 'E_ARGUMENT'
  );
  await assert.rejects(
    planCompaction('/nonexistent-vault', { ...bad, keep: 1.5 }),
    (error) => error.code === 'E_ARGUMENT'
  );
  await assert.rejects(
    planCompaction('/nonexistent-vault', { ...bad, olderThan: '2026-02-30' }),
    (error) => error.code === 'E_ARGUMENT'
  );
  await assert.rejects(planCompaction('/nonexistent-vault', bad), (error) => error.code === 'E_PATH_ESCAPE');
});
