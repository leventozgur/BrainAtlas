// SPDX-License-Identifier: MIT
// BA-48: the read-only weekly maintenance snapshot, its overdue reminder and the absence of any OS scheduler code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultConfig, resolvePaths, saveConfig, vaultId } from '../../packages/core/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const cliUrl = pathToFileURL(resolve('packages/cli/src/index.mjs')).href;
const { main } = await import(cliUrl);

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function homeEnv(t, platform = 'linux') {
  const home = await temp(t, 'ba48-home-');
  return cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: platform,
    BRAINATLAS_OFFLINE: '1',
    UID: '501'
  });
}

async function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  }
  return root;
}

const page = ({ title = 'Page', generated = '2026-11-01', stale = 'P90D', body = '', extra = '' } = {}) =>
  `---\ntype: concept\ntitle: ${JSON.stringify(title)}\ngenerated: "${generated}"\nstatus: confirmed\nsources: []\nverified: []\nstale_after: "${stale}"\naliases: []\nkeywords: []\n${extra}---\n\n# ${title}\n\n${body}\n`;
const index = (...entries) => `# Wiki Index\n\n## Pages\n\n${entries.map(([title, path]) => `- [${title}](${path})`).join('\n')}\n`;
const longBody = (sections = 0) => {
  const words = Array.from({ length: 2999 }, () => 'word').join(' ');
  const dated = Array.from({ length: sections }, (_, i) => `## Update 2026-0${i + 1}-01\n\nsection ${i}\n`).join('\n');
  return `${words}\n\n${dated}`;
};

async function run(args, env, dependencies = {}) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try { await main(args, env, dependencies); }
  finally { console.log = original; }
  return lines.join('\n');
}

async function snapshotTree(dir) {
  const out = [];
  async function visit(rel) {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const info = await lstat(join(dir, child));
      if (info.isDirectory()) { out.push(`d ${child}`); await visit(child); }
      else out.push(`f ${child} ${createHash('sha256').update(await readFile(join(dir, child))).digest('hex')}`);
    }
  }
  await visit('');
  return out.sort();
}

function fakeRunner(calls, handler = () => ({ code: 0, stdout: '', stderr: '' })) {
  return async (command, args) => {
    calls.push([command, ...args].join(' '));
    return handler(command, args);
  };
}

async function configuredVault(env, vault) {
  const paths = resolvePaths({ platform: env.BRAINATLAS_PLATFORM, env });
  const cfg = defaultConfig('lite');
  cfg.vault.path = vault;
  await mkdir(join(paths.configFile, '..'), { recursive: true });
  await saveConfig(cfg, { paths });
  return paths;
}

test('weekly run writes a content-free snapshot and leaves the vault byte-identical', async t => {
  const env = await homeEnv(t);
  const vault = await temp(t, 'ba48-vault-');
  await writeFiles(vault, {
    'wiki/index.md': index(['A', 'concepts/a.md'], ['B', 'concepts/b.md']),
    'wiki/concepts/a.md': page({ title: 'A', generated: '2020-01-01', stale: 'P1D', body: longBody(5) }),
    'wiki/concepts/b.md': page({ title: 'B', body: 'Unlinked [[nowhere]].' })
  });
  const before = await snapshotTree(vault);
  const text = await run(['maintain', '--vault', vault, '--weekly'], env, { runCommand: fakeRunner([]) });
  assert.deepEqual(await snapshotTree(vault), before);
  assert.match(text, /^BrainAtlas weekly maintenance: \d+ finding\(s\), \d+ fix change\(s\) planned, \d+ compaction candidate\(s\); nothing was applied\.$/m);
  assert.match(text, /^Nothing queued \(not-configured-vault\)\.$/m);

  const state = join(env.XDG_STATE_HOME, 'brainatlas', vaultId(resolve(vault)), 'maintenance');
  const names = (await readdir(state)).sort();
  const snapshots = names.filter(name => name.startsWith('weekly-'));
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0], /^weekly-\d{4}-\d{2}-\d{2}\.json$/);
  const snapshot = JSON.parse(await readFile(join(state, snapshots[0]), 'utf8'));
  assert.deepEqual(Object.keys(snapshot).sort(), ['compact', 'counts', 'fix', 'pages', 'queue', 'ranAt']);
  assert.equal(snapshot.pages, 2);
  assert.equal(snapshot.counts.stale, 1);
  assert.equal(snapshot.counts.oversized, 1);
  assert.equal(snapshot.fix.changes, 0);
  assert.equal(snapshot.fix.unfixed, 1);
  assert.deepEqual(snapshot.compact, [{ page: 'wiki/concepts/a.md', moved: 2 }]);
  assert.ok(!JSON.stringify(snapshot).includes(vault));
  const last = JSON.parse(await readFile(join(state, 'last-weekly.json'), 'utf8'));
  assert.deepEqual(Object.keys(last), ['ranAt']);
  assert.equal(last.ranAt, snapshot.ranAt);

  const json = JSON.parse(await run(['maintain', '--vault', vault, '--weekly', '--json'], env, { runCommand: fakeRunner([]) }));
  assert.deepEqual({ ...json, ranAt: snapshot.ranAt }, snapshot);
});

test('a failing compaction plan is recorded as an error code and the run continues', async t => {
  const env = await homeEnv(t);
  const outside = await temp(t, 'ba48-outside-');
  const vault = await temp(t, 'ba48-vault-');
  await writeFiles(vault, {
    'wiki/index.md': index(['A', 'concepts/a.md'], ['B', 'concepts/b.md']),
    'wiki/concepts/a.md': page({ title: 'A', body: longBody(4) }),
    'wiki/concepts/b.md': page({ title: 'B' })
  });
  await symlink(outside, join(vault, 'wiki/archive'));
  const snapshot = JSON.parse(await run(['maintain', '--vault', vault, '--weekly', '--json'], env, { runCommand: fakeRunner([]) }));
  assert.deepEqual(snapshot.compact, [{ page: 'wiki/concepts/a.md', error: 'E_PATH_ESCAPE' }]);
  assert.equal(snapshot.pages, 2);
  assert.equal(snapshot.queue.reason, 'not-configured-vault');
});

test('at most twelve weekly snapshots are kept; the oldest are deleted and nothing else is touched', async t => {
  const env = await homeEnv(t);
  const vault = await temp(t, 'ba48-vault-');
  await writeFiles(vault, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A' })
  });
  const state = join(env.XDG_STATE_HOME, 'brainatlas', vaultId(resolve(vault)), 'maintenance');
  await mkdir(state, { recursive: true });
  for (let day = 1; day <= 14; day++) await writeFile(join(state, `weekly-2026-10-${String(day).padStart(2, '0')}.json`), '{}\n');
  await writeFile(join(state, 'notes.json'), '{}\n');
  const calls = [];
  await run(['maintain', '--vault', vault, '--weekly'], env, { runCommand: fakeRunner(calls) });
  assert.deepEqual(calls, []);
  const names = (await readdir(state)).sort();
  assert.equal(names.filter(name => /^weekly-.*\.json$/u.test(name)).length, 12);
  assert.ok(!names.includes('weekly-2026-10-01.json'));
  assert.ok(!names.includes('weekly-2026-10-03.json'));
  assert.ok(names.includes('weekly-2026-10-04.json'));
  assert.ok(names.includes('notes.json'));
  assert.ok(names.includes('last-weekly.json'));
});

test('queue: the configured vault goes through the receipts path, another vault does not', async t => {
  const env = await homeEnv(t);
  const vault = await temp(t, 'ba48-vault-');
  const other = await temp(t, 'ba48-other-');
  await writeFiles(vault, {
    'wiki/index.md': index(['A', 'concepts/a.md'], ['B', 'concepts/b.md']),
    'wiki/concepts/a.md': page({ title: 'A', generated: '2020-01-01', stale: 'P1D' }),
    'wiki/concepts/b.md': page({ title: 'B' })
  });
  await writeFiles(other, { 'wiki/index.md': index(['A', 'concepts/a.md']), 'wiki/concepts/a.md': page({ title: 'A' }) });
  await configuredVault(env, vault);
  const lite = JSON.parse(await run(['maintain', '--weekly', '--json'], env, { runCommand: fakeRunner([]) }));
  assert.deepEqual(lite.fix.counts, { 'index-missing': 0, 'archived-link': 0, 'source-link': 0 });
  assert.equal(lite.fix.changes, 0);
  assert.equal(lite.counts.stale, 1);
  assert.deepEqual(lite.queue, { queued: false, reason: 'receipts-module-missing' });
  const foreign = JSON.parse(await run(['maintain', '--vault', other, '--weekly', '--json'], env, { runCommand: fakeRunner([]) }));
  assert.deepEqual(foreign.queue, { queued: false, reason: 'not-configured-vault' });
  const clean = await temp(t, 'ba48-clean-');
  await writeFiles(clean, { 'wiki/index.md': index(['A', 'concepts/a.md']), 'wiki/concepts/a.md': page({ title: 'A' }) });
  await configuredVault(env, clean);
  const none = JSON.parse(await run(['maintain', '--weekly', '--json'], env, { runCommand: fakeRunner([]) }));
  assert.deepEqual(none.queue, { queued: false, reason: 'no-findings' });
});

test('reminder: only an existing last-weekly.json that is more than 8 days old adds it', async t => {
  const env = await homeEnv(t);
  const vault = await temp(t, 'ba48-vault-');
  await writeFiles(vault, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A' })
  });
  const paths = await configuredVault(env, vault);
  const state = join(paths.stateDir, vaultId(resolve(vault)), 'maintenance');
  const last = join(state, 'last-weekly.json');
  const calls = [];
  const runner = fakeRunner(calls);

  // Never run: no reminder, no host command.
  const plain = await run(['maintain'], env, { runCommand: runner });
  assert.ok(!plain.includes('Reminder:'));
  assert.deepEqual(calls, []);

  // A recent run: no reminder and the JSON keys are exactly as before.
  await mkdir(state, { recursive: true });
  await writeFile(last, JSON.stringify({ ranAt: new Date().toISOString() }));
  const recent = await run(['maintain'], env, { runCommand: runner });
  assert.ok(!recent.includes('Reminder:'));
  const recentJson = JSON.parse(await run(['maintain', '--json'], env, { runCommand: runner }));
  assert.equal(recentJson.weekly, undefined);
  assert.deepEqual(Object.keys(recentJson).sort(), ['counts', 'durationMs', 'findings', 'ok', 'pages']);

  // An old run: exactly one reminder line, plus `weekly` in the JSON.
  const oldRanAt = new Date(Date.now() - 9 * 86400000).toISOString();
  await writeFile(last, JSON.stringify({ ranAt: oldRanAt }));
  const stale = await run(['maintain'], env, { runCommand: runner });
  assert.equal(stale.split('\n').filter(line => line.startsWith('Reminder:')).length, 1);
  assert.match(stale, /^Reminder: weekly maintenance has not run since \d{4}-\d{2}-\d{2}; run "brainatlas maintain --weekly"\.$/m);
  const staleJson = JSON.parse(await run(['maintain', '--json'], env, { runCommand: runner }));
  assert.equal(staleJson.weekly.overdue, true);
  assert.equal(staleJson.weekly.lastRun, oldRanAt);
  assert.deepEqual(Object.keys(staleJson.weekly).sort(), ['lastRun', 'overdue']);

  // With --vault: no reminder even when overdue, and the JSON keys stay untouched.
  const withVault = await run(['maintain', '--vault', vault], env, { runCommand: runner });
  assert.ok(!withVault.includes('Reminder:'));
  const withVaultJson = JSON.parse(await run(['maintain', '--vault', vault, '--json'], env, { runCommand: runner }));
  assert.deepEqual(Object.keys(withVaultJson).sort(), ['counts', 'durationMs', 'findings', 'ok', 'pages']);

  // After a weekly run the reminder disappears.
  await run(['maintain', '--weekly'], env, { runCommand: runner });
  const after = await run(['maintain'], env, { runCommand: runner });
  assert.ok(!after.includes('Reminder:'));
  const afterJson = JSON.parse(await run(['maintain', '--json'], env, { runCommand: runner }));
  assert.equal(afterJson.weekly, undefined);
  assert.deepEqual(calls, []);
});

test('--schedule is rejected as an argument error in every position', async t => {
  const env = await homeEnv(t);
  const runner = fakeRunner([]);
  for (const args of [['maintain', '--schedule'], ['maintain', '--schedule', 'install'], ['maintain', '--schedule', 'remove'], ['maintain', '--schedule', 'status'], ['maintain', '--schedule', 'install', '--json']]) {
    const cause = await run(args, env, { runCommand: runner }).catch(error => error);
    assert.equal(cause.code, 'E_ARGUMENT', args.join(' '));
  }
  for (const args of [['maintain', '--weekly', '--fix', '--plan'], ['maintain', '--weekly', '--queue']]) {
    const cause = await run(args, env, { runCommand: runner }).catch(error => error);
    assert.equal(cause.code, 'E_ARGUMENT', args.join(' '));
  }
});

test('no file under packages/cli mentions an OS scheduler', async t => {
  const root = resolve('packages/cli');
  const offenders = [];
  async function visit(rel) {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else {
        const text = (await readFile(join(root, child))).toString('latin1').toLowerCase();
        for (const word of ['launchd', 'systemd', 'launchctl', 'systemctl', 'launchagents']) {
          if (text.includes(word)) offenders.push(`${child}: ${word}`);
        }
      }
    }
  }
  await visit('');
  assert.deepEqual(offenders, []);
});

test('reminder: a corrupt last-weekly.json is unreadable and adds nothing', async t => {
  const env = await homeEnv(t);
  const vault = await temp(t, 'ba48-vault-');
  await writeFiles(vault, {
    'wiki/index.md': index(['A', 'concepts/a.md']),
    'wiki/concepts/a.md': page({ title: 'A' })
  });
  const paths = await configuredVault(env, vault);
  const state = join(paths.stateDir, vaultId(resolve(vault)), 'maintenance');
  await mkdir(state, { recursive: true });
  const last = join(state, 'last-weekly.json');
  for (const corrupt of ['{"ranAt":"garbage"}', '{"ranAt":"Tue, 01 Jan 2026"}']) {
    await writeFile(last, corrupt);
    const text = await run(['maintain'], env, { runCommand: fakeRunner([]) });
    assert.ok(!text.includes('Reminder:'), corrupt);
    const json = JSON.parse(await run(['maintain', '--json'], env, { runCommand: fakeRunner([]) }));
    assert.equal(json.weekly, undefined, corrupt);
    assert.deepEqual(Object.keys(json).sort(), ['counts', 'durationMs', 'findings', 'ok', 'pages'], corrupt);
  }
});
