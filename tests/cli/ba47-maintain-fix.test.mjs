// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyFix, formatFix, planFix } from '../../packages/cli/src/maintain-fix.mjs';
import { cleanEnv } from './clean-env.mjs';

const NOW = new Date('2026-11-17T00:00:00Z');
const cli = resolve(new URL('../../packages/cli/bin/brainatlas.mjs', import.meta.url).pathname);

async function vaultWith(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'ba47-vault-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  }
  return dir;
}

const page = ({ title, extra = '', body = '' }) =>
  `---\ntype: concept\nstatus: confirmed\n${title ? `title: ${JSON.stringify(title)}\n` : ''}${extra}---\n\n${title ? `# ${title}\n\n` : ''}${body}\n`;
const index = (...entries) => `# Wiki Index\n\n## Concepts\n\n${entries.map(([t, p]) => `- [${t}](${p})`).join('\n')}\n`;
const kinds = (result, kind) => result.changes.filter(change => change.kind === kind);

test('plan writes nothing and reports appended index lines with their new line numbers', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['B', 'concepts/b.md']),
    'wiki/concepts/b.md': page({ title: 'B' }),
    'wiki/concepts/a.md': page({ title: 'Alpha', extra: 'summary: "A short summary."\n' }),
    'wiki/log.md': '# Log\n',
  });
  const before = await readFile(join(dir, 'wiki/index.md'), 'utf8');
  const result = await planFix(dir, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'plan');
  assert.equal(result.written, false);
  assert.equal((await readFile(join(dir, 'wiki/index.md'), 'utf8')), before);
  assert.equal(existsSync(join(dir, 'wiki', '.brainatlas-write.lock')), false);
  assert.equal(result.counts['index-missing'], 1);
  const [change] = kinds(result, 'index-missing');
  assert.equal(change.path, 'wiki/index.md');
  assert.equal(change.line, 6);
  assert.equal(change.before, null);
  assert.equal(change.after, '- [Alpha](concepts/a.md) — A short summary.');
  assert.deepEqual(result.changes.map(item => [item.path, item.line]), [['wiki/index.md', 6]]);
});

test('index insertion follows the folder section, falls back to Unsorted, and uses title, heading or file name', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n\n- [B](concepts/b.md)\n\n## Entities\n\n- [E](entities/e.md)\n',
    'wiki/concepts/b.md': page({ title: 'B' }),
    'wiki/concepts/a.md': page({ title: 'Alpha' }),
    'wiki/entities/e.md': page({ title: 'E' }),
    'wiki/entities/f.md': page({ title: '' , body: '# Heading Only Title' }),
    'wiki/queries/q.md': page({ title: 'Query page' }),
    'wiki/entities/long.md': page({ title: 'Long', extra: 'description: "x"\n' }).replace('description: "x"', `description: "${'y'.repeat(200)}"`),
  });
  const result = await planFix(dir, { now: NOW });
  const applied = await applyFix(dir, { now: NOW });
  assert.equal(applied.changes.length, result.changes.length);
  const text = await readFile(join(dir, 'wiki/index.md'), 'utf8');
  assert.match(text, /## Concepts\n\n- \[B\]\(concepts\/b\.md\)\n- \[Alpha\]\(concepts\/a\.md\)\n/);
  assert.match(text, /## Entities\n\n- \[E\]\(entities\/e\.md\)\n- \[Heading Only Title\]\(entities\/f\.md\)\n- \[Long\]\(entities\/long\.md\) — y+…\n/);
  assert.match(text, /## Unsorted \(maintain --fix\)\n- \[Query page\]\(queries\/q\.md\)\n/);
  const summaryLine = text.split('\n').find(line => line.includes('(entities/long.md)'));
  assert.equal(summaryLine.split(' — ')[1].length, 160);
});

test('a missing index is reported as index-absent and nothing is written', async t => {
  const dir = await vaultWith(t, { 'wiki/concepts/a.md': page({ title: 'A' }) });
  const result = await applyFix(dir, { now: NOW });
  assert.equal(result.written, false);
  assert.deepEqual(result.changes, []);
  const item = result.unfixed.find(entry => entry.reason === 'index-absent');
  assert.equal(item.kind, 'index-missing');
  assert.equal(item.path, 'wiki/index.md');
  assert.equal(existsSync(join(dir, 'wiki/index.md')), false);
  assert.equal(existsSync(join(dir, 'wiki/log.md')), false);
});

test('archived-link: one archive match becomes plain text, several or none stay unfixed, code is skipped', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md'], ['B', 'concepts/b.md']),
    'wiki/concepts/a.md': page({
      title: 'A',
      body: [
        'One [[old-thing]] and [[old-thing|Alias]] plus [[dup]] and [[nowhere]].',
        '```',
        '[[old-thing]]',
        '```',
        'Inline `[[old-thing]]` stays.',
        'Trailing [[old-thing#Heading]].',
      ].join('\n'),
    }),
    'wiki/concepts/b.md': page({ title: 'B' }),
    'archive/nested/old-thing.md': '# Old\n',
    'archive/dup.md': '1\n',
    'archive/other/dup.md': '2\n',
  });
  const result = await applyFix(dir, { now: NOW });
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.match(text, /^One old-thing \(archived: `archive\/nested\/old-thing\.md`\) and Alias \(archived: `archive\/nested\/old-thing\.md`\) plus \[\[dup\]\] and \[\[nowhere\]\]\.$/m);
  assert.match(text, /^```\n\[\[old-thing\]\]\n```$/m);
  assert.match(text, /^Inline `\[\[old-thing\]\]` stays\.$/m);
  assert.match(text, /^Trailing old-thing \(archived: `archive\/nested\/old-thing\.md`\)\.$/m);
  const [change] = kinds(result, 'archived-link');
  assert.equal(change.path, 'wiki/concepts/a.md');
  assert.equal(change.line, 9);
  assert.equal(change.before, 'One [[old-thing]] and [[old-thing|Alias]] plus [[dup]] and [[nowhere]].');
  const reasons = result.unfixed.map(item => `${item.path}:${item.reason}`).sort();
  assert.ok(reasons.includes('wiki/concepts/a.md:ambiguous-archive'));
  assert.ok(reasons.includes('wiki/concepts/a.md:unknown-target'));
  assert.equal(kinds(result, 'archived-link').length, 2);
  const first = change.after;
  assert.equal(first.split('\n').length, 1);
});

test('source-link: only --sources lists existing, unlinked frontmatter sources once, under one heading', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md'], ['B', 'concepts/b.md']),
    'wiki/concepts/a.md': page({
      title: 'A',
      extra: 'sources:\n  - raw/one.txt\n  - raw/one.txt\n  - wiki/concepts/b.md\n  - repo:src/x.mjs\n  - ../etc/passwd\n  - raw/missing.txt\n',
      body: 'Body with [b](b.md).',
    }),
    'wiki/concepts/b.md': page({ title: 'B' }),
    'raw/one.txt': 'raw\n',
  });
  const off = await planFix(dir, { now: NOW });
  assert.deepEqual(kinds(off, 'source-link'), []);
  const result = await applyFix(dir, { now: NOW, sources: true });
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.match(text, /Body with \[b\]\(b\.md\)\.\n\n## Source files\n- \[raw\/one\.txt\]\(\.\.\/\.\.\/raw\/one\.txt\)\n$/);
  assert.doesNotMatch(text, /wiki\/concepts\/b\.md\]/);
  assert.deepEqual(kinds(result, 'source-link').map(change => change.after), ['- [raw/one.txt](../../raw/one.txt)']);
  const again = await applyFix(dir, { now: NOW, sources: true });
  assert.deepEqual(again.changes, []);
  assert.equal(again.written, false);
});

test('source-link appends to an existing trailing Source files section', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A', extra: 'sources:\n  - raw/one.txt\n', body: 'Body.\n\n## Source files\n\n- [old](../../raw/old.txt)' }),
    'raw/one.txt': 'raw\n',
    'raw/old.txt': 'raw\n',
  });
  await applyFix(dir, { now: NOW, sources: true });
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.match(text, /## Source files\n\n- \[old\]\(\.\.\/\.\.\/raw\/old\.txt\)\n- \[raw\/one\.txt\]\(\.\.\/\.\.\/raw\/one\.txt\)\n$/);
});

test('apply logs one content-free entry per changed file and a second run writes nothing', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n',
    'wiki/concepts/a.md': page({ title: 'A', body: '[[old-thing]]' }),
    'archive/old-thing.md': '# Old\n',
  });
  const result = await applyFix(dir, { now: NOW });
  assert.equal(result.written, true);
  assert.equal(result.mode, 'apply');
  const log = await readFile(join(dir, 'wiki/log.md'), 'utf8');
  assert.match(log, /"action":"maintain-fix","path":"wiki\/index\.md"/);
  assert.match(log, /"action":"maintain-fix","path":"wiki\/concepts\/a\.md"/);
  assert.doesNotMatch(log, /old-thing|Alpha|\[A\]/);
  assert.equal(log.match(/"action":"maintain-fix"/g).length, 2);
  const before = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  const again = await applyFix(dir, { now: NOW });
  assert.deepEqual(again.changes, []);
  assert.equal(again.written, false);
  assert.equal(await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8'), before);
  assert.equal((await readFile(join(dir, 'wiki/log.md'), 'utf8')), log);
});

test('symlinks are skipped and reported, and no line is ever deleted', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A', body: 'kept line\n\n[[old-thing]]' }),
    'archive/old-thing.md': '# Old\n',
  });
  await mkdir(join(dir, 'wiki/entities'), { recursive: true });
  await symlink(join(dir, 'wiki/concepts/a.md'), join(dir, 'wiki/entities/linked.md'));
  const result = await applyFix(dir, { now: NOW });
  const item = result.unfixed.find(entry => entry.reason === 'symlink');
  assert.equal(item.path, 'wiki/entities/linked.md');
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  const lines = text.split('\n').filter(line => line.trim() && !line.startsWith('#'));
  assert.deepEqual(lines.slice(-2), ['kept line', 'old-thing (archived: `archive/old-thing.md`)']);
});

test('formatFix prints the header, per-file before/after lines and unfixed items', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n',
    'wiki/concepts/a.md': page({ title: 'A', body: '[[nowhere]]' }),
  });
  const result = await planFix(dir, { now: NOW });
  const text = formatFix(result);
  const lines = text.split('\n');
  assert.match(lines[0], /^BrainAtlas maintain --fix \(plan\): \d+ change\(s\) in \d+ file\(s\), \d+ unfixed, \d+ ms$/);
  assert.ok(lines.includes('  wiki/index.md'));
  assert.ok(lines.includes('    + - [A](concepts/a.md)'));
  assert.ok(lines.includes('  wiki/concepts/a.md: unknown-target wikilink target not found: "nowhere"'));
  assert.ok(lines.includes('unfixed (1)'));
  for (const line of lines.slice(1).filter(line => line.startsWith('    + '))) assert.ok(line.length > 6);
});

test('CLI: argument rules and --fix --plan / --apply', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A' }),
    'wiki/concepts/b.md': page({ title: 'B' }),
  });
  const home = await mkdtemp(join(tmpdir(), 'ba47-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, 'maintain', ...args, '--vault', dir], { env: cleanEnv({ HOME: home }), encoding: 'utf8', timeout: 20000 });
  const neither = run('--fix');
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /E_ARGUMENT/);
  assert.match(run('--fix', '--plan', '--apply').stderr, /E_ARGUMENT/);
  assert.match(run('--fix', '--plan', '--queue').stderr, /E_ARGUMENT/);
  assert.match(run('--fix', '--plan', '--repo', '.').stderr, /E_ARGUMENT/);
  assert.match(run('--sources').stderr, /E_ARGUMENT/);
  const planRun = run('--fix', '--plan');
  assert.equal(planRun.status, 0, planRun.stderr);
  assert.match(planRun.stdout, /^BrainAtlas maintain --fix \(plan\):/);
  const jsonRun = run('--fix', '--plan', '--json');
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.written, false);
  assert.equal(parsed.counts['index-missing'], 1);
  const applyRun = run('--fix', '--apply');
  assert.equal(applyRun.status, 0, applyRun.stderr);
  const text = await readFile(join(dir, 'wiki/index.md'), 'utf8');
  assert.match(text, /- \[B\]\(concepts\/b\.md\)/);
  assert.match(await readFile(join(dir, 'wiki/log.md'), 'utf8'), /"action":"maintain-fix"/);
  const help = spawnSync(process.execPath, [cli, 'help', 'maintain'], { env: cleanEnv({ HOME: home }), encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /--fix \(--plan \| --apply\) \[--sources\]/);
});

test('archived-link: several archive matches are a broken-link ambiguous-archive item, alias text is kept whole', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A', body: 'One [[dup]] and [[old-thing|Alias#Part]].' }),
    'archive/dup.md': '1\n',
    'archive/other/dup.md': '2\n',
    'archive/old-thing.md': '# Old\n',
  });
  const result = await applyFix(dir, { now: NOW });
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.match(text, /^One \[\[dup\]\] and Alias#Part \(archived: `archive\/old-thing\.md`\)\.$/m);
  const ambiguous = result.unfixed.filter(item => item.reason === 'ambiguous-archive');
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].kind, 'broken-link');
  assert.equal(ambiguous[0].path, 'wiki/concepts/a.md');
  assert.equal(result.unfixed.filter(item => /"dup"/.test(item.detail)).length, 1);
});

test('archived-link: matching is exact after lower-casing, with no dash, space or diacritic folding', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A', body: 'Dash [[old-thing]] space [[Old Thing]] case [[OLD-THING.MD]] accent [[Şeker]].' }),
    'archive/old-thing.md': '# Old\n',
    'archive/seker.md': '# Seker\n',
  });
  const result = await applyFix(dir, { now: NOW });
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.match(text, /^Dash old-thing \(archived: `archive\/old-thing\.md`\) space \[\[Old Thing\]\] case OLD-THING\.MD \(archived: `archive\/old-thing\.md`\) accent \[\[Şeker\]\]\.$/m);
  assert.equal(kinds(result, 'archived-link').length, 1);
  const unknown = result.unfixed.filter(item => item.reason === 'unknown-target').map(item => item.detail).join('\n');
  assert.match(unknown, /"Old Thing"/);
  assert.match(unknown, /"Şeker"/);
});

test('archived-link: an ambiguous wiki name is never rewritten to archive text', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md'], ['D1', 'a/dup.md'], ['D2', 'b/dup.md']),
    'wiki/concepts/a.md': page({ title: 'A', body: 'Link [[dup]].' }),
    'wiki/a/dup.md': page({ title: 'One' }),
    'wiki/b/dup.md': page({ title: 'Two' }),
    'archive/dup.md': 'archived\n',
  });
  const result = await applyFix(dir, { now: NOW });
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.match(text, /^Link \[\[dup\]\]\.$/m);
  assert.deepEqual(kinds(result, 'archived-link'), []);
  const item = result.unfixed.find(entry => entry.path === 'wiki/concepts/a.md');
  assert.equal(item.kind, 'broken-link');
  assert.equal(item.reason, 'unknown-target');
  assert.match(item.detail, /ambiguous/);
});

test('idempotent: spaces and parentheses are percent-encoded, titles flattened and ] escaped', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n',
    'wiki/concepts/my page (1).md': '---\ntype: concept\ntitle: "A ] B"\nsummary: |\n  First line\n  second line\nsources:\n  - raw/my file (1).txt\n---\n\n# A ] B\n\nBody.\n',
    'raw/my file (1).txt': 'raw\n',
  });
  const first = await applyFix(dir, { now: NOW, sources: true });
  const text = await readFile(join(dir, 'wiki/index.md'), 'utf8');
  assert.match(text, /- \[A \\\] B\]\(concepts\/my%20page%20%281%29\.md\) — First line second line/);
  const pageText = await readFile(join(dir, 'wiki/concepts/my page (1).md'), 'utf8');
  assert.match(pageText, /## Source files\n- \[raw\/my file \(1\)\.txt\]\(\.\.\/\.\.\/raw\/my%20file%20%281%29\.txt\)\n$/);
  assert.equal(first.written, true);
  const second = await applyFix(dir, { now: NOW, sources: true });
  assert.deepEqual(second.changes, []);
  assert.equal(second.written, false);
});

test('the log entry is exactly the action and the page path', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n',
    'wiki/concepts/a.md': page({ title: 'A' }),
  });
  await applyFix(dir, { now: NOW });
  const lines = (await readFile(join(dir, 'wiki/log.md'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '- 2026-11-17T00:00:00.000Z {"action":"maintain-fix","path":"wiki/index.md"}');
  assert.deepEqual(Object.keys(JSON.parse(lines[0].slice(lines[0].indexOf('{')))), ['action', 'path']);
});

test('orphan items come from the report and are dropped when this plan indexes the page', async t => {
  const withoutIndex = await vaultWith(t, { 'wiki/concepts/a.md': page({ title: 'A' }) });
  const planned = await planFix(withoutIndex, { now: NOW });
  const orphan = planned.unfixed.find(item => item.kind === 'orphan' && item.path === 'wiki/concepts/a.md');
  assert.equal(orphan?.reason, 'report-only');
  assert.ok(planned.unfixed.some(item => item.reason === 'index-absent'));

  const withIndex = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n',
    'wiki/concepts/a.md': page({ title: 'A' }),
  });
  const fixed = await planFix(withIndex, { now: NOW });
  assert.deepEqual(fixed.changes.map(change => change.kind), ['index-missing']);
  assert.equal(fixed.unfixed.filter(item => item.kind === 'orphan').length, 0);
});

test('a leading BOM still yields frontmatter, so frontmatter lines are never rewritten', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': '\uFEFF---\ntype: concept\ntitle: "A"\nsuperseded_by: "[[old-thing]]"\n---\n\n# A\n\nBody [[old-thing]].\n',
    'archive/old-thing.md': '# Old\n',
  });
  const result = await applyFix(dir, { now: NOW });
  const text = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.ok(text.startsWith('\uFEFF---\n'));
  assert.match(text, /^superseded_by: "\[\[old-thing\]\]"$/m);
  assert.match(text, /^Body old-thing \(archived: `archive\/old-thing\.md`\)\.$/m);
  const [change] = kinds(result, 'archived-link');
  assert.equal(change.line, 9);
  assert.equal(change.before, 'Body [[old-thing]].');
  assert.ok(result.changes.every(item => item.path !== 'wiki/concepts/a.md' || item.line >= 9));
});

test('only .md file symlinks and directory symlinks are reported as symlink', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A' }),
    'raw/pic.png': 'png\n',
  });
  await mkdir(join(dir, 'wiki/entities'), { recursive: true });
  await symlink(join(dir, 'wiki/concepts/a.md'), join(dir, 'wiki/entities/linked.md'));
  await symlink(join(dir, 'raw/pic.png'), join(dir, 'wiki/entities/pic.png'));
  await symlink(join(dir, 'wiki/concepts'), join(dir, 'wiki/entities/concepts-link'));
  const result = await planFix(dir, { now: NOW });
  const paths = result.unfixed.filter(item => item.reason === 'symlink').map(item => item.path).sort();
  assert.deepEqual(paths, ['wiki/entities/concepts-link', 'wiki/entities/linked.md']);
});

test('the summary is cut by Unicode code points to at most 160 including the ellipsis', async t => {
  const emoji = '😀'.repeat(200);
  const dir = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n',
    'wiki/concepts/a.md': `---\ntype: concept\ntitle: "A"\nsummary: "${emoji}"\n---\n\n# A\n`,
  });
  const result = await planFix(dir, { now: NOW });
  const summary = result.changes[0].after.split(' — ')[1];
  assert.equal(Array.from(summary).length, 160);
  assert.ok(summary.endsWith('…'));
  assert.doesNotMatch(summary, /\p{Surrogate}/u);
});

test('inserted lines reuse the CRLF ending of the file', async t => {
  const crlf = lines => `${lines.join('\r\n')}\r\n`;
  const dir = await vaultWith(t, {
    'wiki/index.md': crlf(['# Wiki Index', '', '## Concepts']),
    'wiki/concepts/a.md': crlf(['---', 'type: concept', 'title: "A"', 'sources:', '  - raw/one.txt', '---', '', '# A', '', 'Body.']),
    'raw/one.txt': 'raw\n',
  });
  const result = await applyFix(dir, { now: NOW, sources: true });
  assert.equal(result.written, true);
  for (const rel of ['wiki/index.md', 'wiki/concepts/a.md']) {
    const text = await readFile(join(dir, rel), 'utf8');
    assert.doesNotMatch(text, /(?<!\r)\n/u, `${rel} has a bare LF`);
  }
  assert.match(await readFile(join(dir, 'wiki/index.md'), 'utf8'), /## Concepts\r\n- \[A\]\(concepts\/a\.md\)\r\n$/);
  assert.match(await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8'), /## Source files\r\n- \[raw\/one\.txt\]\(\.\.\/\.\.\/raw\/one\.txt\)\r\n$/);
  const again = await applyFix(dir, { now: NOW, sources: true });
  assert.deepEqual(again.changes, []);
});

test('index frontmatter is skipped by section scanning and never receives an insertion', async t => {
  // A heading-shaped YAML comment in the frontmatter is not a section: the entry falls through to Unsorted at the end.
  const dir = await vaultWith(t, {
    'wiki/index.md': '---\n## Concepts\nstatus: draft\n---\n\n# Wiki Index\n\n## Other\n\n- [X](concepts/x.md)\n',
    'wiki/concepts/a.md': page({ title: 'A' }),
  });
  const result = await applyFix(dir, { now: NOW });
  assert.equal(result.counts['index-missing'], 1);
  const text = await readFile(join(dir, 'wiki/index.md'), 'utf8');
  assert.ok(text.startsWith('---\n## Concepts\nstatus: draft\n---\n'));
  assert.match(text, /## Unsorted \(maintain --fix\)\n- \[A\]\(concepts\/a\.md\)\n$/);
  assert.ok(result.changes.every(change => change.line > 10), JSON.stringify(result.changes));
  const again = await planFix(dir, { now: NOW });
  assert.deepEqual(again.changes, []);

  // An unclosed frontmatter block leaves no body to insert into: the fix fails verification and writes nothing.
  for (const indexText of ['---\ntitle: idx\n', '---\ntitle: idx']) {
    const unclosed = await vaultWith(t, {
      'wiki/index.md': indexText,
      'wiki/concepts/a.md': page({ title: 'A' }),
    });
    await assert.rejects(planFix(unclosed, { now: NOW }), error => error.code === 'E_FIX_VERIFY');
    await assert.rejects(applyFix(unclosed, { now: NOW }), error => error.code === 'E_FIX_VERIFY');
    assert.equal(await readFile(join(unclosed, 'wiki/index.md'), 'utf8'), indexText);
    assert.equal(existsSync(join(unclosed, 'wiki/log.md')), false);
  }
});

test('CRLF files without a final line terminator keep a consistent ending', async t => {
  const dir = await vaultWith(t, {
    // No final terminator: one entry is appended right after the unterminated last line, one block goes to Unsorted.
    'wiki/index.md': '# Wiki Index\r\n\r\n## Entities\r\n\r\n- [E](entities/e.md)',
    'wiki/entities/f.md': page({ title: 'F' }),
    'wiki/concepts/a.md': '---\r\ntype: concept\r\ntitle: "A"\r\nsources:\r\n  - raw/one.txt\r\n---\r\n\r\n# A\r\n\r\nBody.',
    'raw/one.txt': 'raw\n',
  });
  const result = await applyFix(dir, { now: NOW, sources: true });
  assert.equal(result.written, true);
  const text = await readFile(join(dir, 'wiki/index.md'), 'utf8');
  assert.doesNotMatch(text, /(?<!\r)\n/u, 'the index has a bare LF');
  assert.doesNotMatch(text, /\r(?!\n)/u, 'the index has a lone CR');
  assert.match(text, /- \[E\]\(entities\/e\.md\)\r\n- \[F\]\(entities\/f\.md\)\r\n\r\n## Unsorted \(maintain --fix\)\r\n- \[A\]\(concepts\/a\.md\)\r\n$/);
  const pageText = await readFile(join(dir, 'wiki/concepts/a.md'), 'utf8');
  assert.doesNotMatch(pageText, /(?<!\r)\n/u, 'the page has a bare LF');
  assert.doesNotMatch(pageText, /\r(?!\n)/u, 'the page has a lone CR');
  assert.match(pageText, /Body\.\r\n\r\n## Source files\r\n- \[raw\/one\.txt\]\(\.\.\/\.\.\/raw\/one\.txt\)\r\n$/);
  const again = await applyFix(dir, { now: NOW, sources: true });
  assert.deepEqual(again.changes, []);
  assert.equal(again.written, false);
});

test('existing maintain report without --fix is unchanged', async t => {
  const dir = await vaultWith(t, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A', body: '[[nowhere]]' }),
  });
  const home = await mkdtemp(join(tmpdir(), 'ba47-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [cli, 'maintain', '--vault', dir], { env: cleanEnv({ HOME: home }), encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^BrainAtlas maintenance report \(read-only\): 1 pages, \d+ findings, \d+ ms/);
  assert.match(run.stdout, /broken-link \(1\)/);
  assert.equal(existsSync(join(dir, 'wiki/log.md')), false);
});
