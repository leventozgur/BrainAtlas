// SPDX-License-Identifier: MIT
// BA-23: `brainatlas maintain` reports exactly the pages whose frontmatter loadPages throws on (kind `invalid-frontmatter`),
// and does not fail on them. Hermetic: temporary vault and HOME directories only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatMaintenance, runMaintenance } from '../../packages/cli/src/maintain.mjs';
import { cleanEnv } from './clean-env.mjs';

const NOW = new Date('2026-11-11T00:00:00Z');
const page = (title, body = 'zephyr body text') =>
  `---\ntype: concept\ngenerated: "2026-11-01"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: "P90D"\naliases: []\nkeywords: []\n---\n\n# ${title}\n\n${body}\n`;
const index = (...entries) => `# Wiki Index\n\n## Pages\n\n${entries.map((e) => `- [${e[0]}](${e[1]})`).join('\n')}\n`;
const BROKEN_BODY = 'SECRET-BODY-TEXT zephyr broken body.';
// Pages that loadPages throws on: reported as invalid-frontmatter.
const BROKEN = {
  'wiki/concepts/yaml.md': `---\ntitle: [oops\n---\n\n# Yaml\n\n${BROKEN_BODY}\n`,
  'wiki/concepts/dup.md': `---\ntitle: A\ntitle: B\n---\n\n# Dup\n\n${BROKEN_BODY}\n`,
  'wiki/concepts/bom-yaml.md': `\uFEFF---\ntitle: [oops\n---\n\n# BomYaml\n\n${BROKEN_BODY}\n`,
};
// Pages that loadPages accepts (an unclosed block, a non-mapping root): not reported, as before.
const ACCEPTED = {
  'wiki/concepts/unclosed.md': `---\ntitle: Unclosed\nstatus: confirmed\n\n# Unclosed\n\n${BROKEN_BODY}\n`,
  'wiki/concepts/list.md': `---\n- one\n- two\n---\n\n# List\n\n${BROKEN_BODY}\n`,
};

async function vaultWith(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'ba23-maintain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  }
  return dir;
}
const healthy = {
  'wiki/index.md': index(['A', 'concepts/a.md'], ['B', 'concepts/b.md']),
  'wiki/concepts/a.md': page('A', 'Links to [[B]].'),
  'wiki/concepts/b.md': page('B', 'Back to [[A]].'),
};
const ofKind = (report, kind) => report.findings.filter((f) => f.kind === kind);

test('a vault with broken frontmatter does not fail maintenance, and each broken page is reported by path', async (t) => {
  const dir = await vaultWith(t, { ...healthy, ...BROKEN, ...ACCEPTED });
  const report = await runMaintenance(dir, { now: NOW });
  assert.equal(report.ok, true);
  const found = ofKind(report, 'invalid-frontmatter')
    .map((f) => f.path)
    .sort();
  assert.deepEqual(found, Object.keys(BROKEN).sort());
});

test('pages that loadPages accepts are not reported as invalid-frontmatter', async (t) => {
  const dir = await vaultWith(t, { ...healthy, ...ACCEPTED });
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(ofKind(report, 'invalid-frontmatter'), []);
  assert.equal(report.pages, 4);
});

test('invalid-frontmatter detail names no page content and no parser message', async (t) => {
  const dir = await vaultWith(t, { ...healthy, ...BROKEN });
  const report = await runMaintenance(dir, { now: NOW });
  assert.equal(ofKind(report, 'invalid-frontmatter').length, 3);
  for (const item of ofKind(report, 'invalid-frontmatter')) {
    assert.deepEqual(Object.keys(item).sort(), ['detail', 'kind', 'path']);
    assert.doesNotMatch(item.detail, /SECRET|zephyr|oops|Duplicate|unique|map keys/i);
    assert.doesNotMatch(item.path, /^\/|^[A-Za-z]:|\\/u);
  }
});

test('a clean vault has no invalid-frontmatter findings and the same counts keys as before', async (t) => {
  const dir = await vaultWith(t, healthy);
  const report = await runMaintenance(dir, { now: NOW });
  assert.deepEqual(ofKind(report, 'invalid-frontmatter'), []);
  assert.deepEqual(Object.keys(report.counts).sort(), [
    'broken-link',
    'index-missing',
    'index-stale',
    'orphan',
    'oversized',
    'stale',
    'superseded-broken',
    'update-sprawl',
  ]);
  assert.deepEqual(report.findings, []);
});

test('human output lists invalid-frontmatter findings by path under their own heading', async (t) => {
  const dir = await vaultWith(t, { ...healthy, ...BROKEN });
  const text = formatMaintenance(await runMaintenance(dir, { now: NOW }));
  assert.match(text, /invalid-frontmatter \(3\)/);
  assert.match(text, /wiki\/concepts\/yaml\.md: /);
  assert.doesNotMatch(text, /SECRET/);
});

test('brainatlas maintain --json reports invalid-frontmatter by path and exits 0', async (t) => {
  const dir = await vaultWith(t, { ...healthy, 'wiki/concepts/yaml.md': BROKEN['wiki/concepts/yaml.md'] });
  const home = await mkdtemp(join(tmpdir(), 'ba23-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
  });
  const run = spawnSync(
    process.execPath,
    [resolve('packages/cli/bin/brainatlas.mjs'), 'maintain', '--json', '--vault', dir],
    { env, encoding: 'utf8', shell: false }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const out = JSON.parse(run.stdout);
  assert.deepEqual(
    out.findings.filter((f) => f.kind === 'invalid-frontmatter').map((f) => f.path),
    ['wiki/concepts/yaml.md']
  );
});
