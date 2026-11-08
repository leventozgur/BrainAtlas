import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanPath, scanText, fingerprintSafetyFinding, isSafetyFindingAllowed } from '../../../packages/core/src/safety/index.mjs';
import { defaultConfig, migrateConfig, validateConfig } from '../../../packages/core/src/config/index.mjs';
import { inventoryVault } from '../../../modules/sync-engine/src/scope.mjs';

const cli = resolve('packages/cli/bin/brainatlas.mjs');
const first = ['sk', 'test' + 'x'.repeat(24)].join('-');
const second = ['sk', 'test' + 'y'.repeat(24)].join('-');
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sallow-blind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), vault = join(root, 'vault');
  const env = { HOME: home, PATH: process.env.PATH, BRAINATLAS_PLATFORM: 'linux', BRAINATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state') };
  const file = join(env.XDG_CONFIG_HOME, 'brainatlas', 'config.json');
  await mkdir(dirname(file), { recursive: true }); await mkdir(join(vault, 'wiki'), { recursive: true });
  const cfg = defaultConfig('lite'); cfg.vault.path = vault;
  await writeFile(file, JSON.stringify(cfg));
  const run = (...args) => spawnSync(process.execPath, [cli, 'safety', ...args], { env, encoding: 'utf8', timeout: 10000 });
  const config = async () => JSON.parse(await readFile(file, 'utf8'));
  return { root, home, vault, file, run, config };
}

test('blind: narrowed path table and canonical matching', () => {
  for (const path of ['wiki/secret-rotation.md', 'wiki/my-secret.md', 'wiki/secrets-guide.MD', 'wiki/secretive.md', 'wiki/ordinary.md']) assert.equal(scanPath(path).length, 0, path);
  for (const path of ['wiki/secret.md', 'wiki/SECRETS.MD', 'wiki/secret.json', 'wiki/secrets.txt', 'wiki/file.secret', 'wiki/file.secrets', 'wiki/client_secret_backup.md', 'wiki/.ENV.local', 'wiki/credentials-list.md', 'wiki/id_rsa.pub', 'wiki/a.pem', 'wiki/a.key']) assert.ok(scanPath(path).length, path);
  assert.ok(scanPath('wiki\\.env.local').length);
  assert.ok(scanPath('./wiki/private.md', { extraDenyGlobs: ['private.md'] }).length);
  assert.throws(() => scanPath(null), TypeError);
});

test('blind: exact content and path fingerprints are scoped to rule, path and value', () => {
  const text = `note ${first}`; const finding = scanText(text).find(x => x.ruleId === 'openai');
  assert.ok(finding); const entry = fingerprintSafetyFinding('wiki/a.md', text, finding);
  assert.equal(entry.sha256, digest(first)); assert.ok(isSafetyFindingAllowed('wiki/a.md', text, finding, [entry]));
  assert.equal(isSafetyFindingAllowed('wiki/b.md', text, finding, [entry]), false);
  assert.equal(isSafetyFindingAllowed('wiki/a.md', text, { ...finding, ruleId: 'other' }, [entry]), false);
  const altered = `note ${second}`; assert.equal(isSafetyFindingAllowed('wiki/a.md', altered, scanText(altered)[0], [entry]), false);
  const pathFinding = scanPath('wiki/secret.md')[0]; const pathEntry = fingerprintSafetyFinding('wiki/secret.md', '', pathFinding);
  assert.deepEqual(pathEntry, { path: 'wiki/secret.md', ruleId: 'denied-path' });
  assert.ok(isSafetyFindingAllowed(pathEntry.path, '', pathFinding, [pathEntry]));
  assert.equal(isSafetyFindingAllowed('wiki/secrets.md', '', pathFinding, [pathEntry]), false);
  assert.throws(() => fingerprintSafetyFinding('x', '', { kind: 'content', ruleId: 'x', start: -1, end: 1 }), TypeError);
});

test('blind: plan, allow, inventory, changed values, revoke and value-free output', async t => {
  const f = await fixture(t); const rel = 'wiki/notes.md'; const target = join(f.vault, rel);
  await writeFile(target, `first ${first}\n`);
  const initial = await readFile(f.file, 'utf8');
  let inventory = await inventoryVault({ vaultPath: f.vault, config: await f.config() });
  assert.ok(inventory.refused.some(x => x.path === rel)); assert.equal(inventory.files.has(rel), false);
  const outputs = [];
  const invoke = (...args) => { const r = f.run(...args); outputs.push(r.stdout, r.stderr); return r; };
  assert.equal(invoke('allow', rel, '--plan', '--json').status, 0); assert.equal(await readFile(f.file, 'utf8'), initial);
  assert.equal(invoke('allow', rel, '--json').status, 0);
  const cfg = await f.config(); assert.ok(cfg.safety.allow.some(x => x.sha256 === digest(first)));
  inventory = await inventoryVault({ vaultPath: f.vault, config: cfg }); assert.ok(inventory.files.has(rel));
  assert.equal(invoke('list', rel, '--json').status, 0);
  await writeFile(target, `first ${first}\nsecond ${second}\n`);
  inventory = await inventoryVault({ vaultPath: f.vault, config: cfg }); assert.equal(inventory.files.has(rel), false); assert.ok(inventory.refused.some(x => x.path === rel));
  await writeFile(target, `first ${first}\n`);
  const beforeRevoke = await readFile(f.file, 'utf8');
  assert.equal(invoke('revoke', rel, '--plan', '--json').status, 0); assert.equal(await readFile(f.file, 'utf8'), beforeRevoke);
  assert.equal(invoke('revoke', rel, '--json').status, 0);
  inventory = await inventoryVault({ vaultPath: f.vault, config: await f.config() }); assert.ok(inventory.refused.some(x => x.path === rel));
  assert.equal(invoke('list', rel, '--json').status, 0);
  const homeFiles = await readdir(f.home, { recursive: true, withFileTypes: true });
  const persisted = await Promise.all(homeFiles.filter(entry => entry.isFile()).map(entry => readFile(join(entry.parentPath, entry.name), 'utf8')));
  const all = outputs.join('\n') + persisted.join('\n') + JSON.stringify(inventory.refused);
  assert.equal(all.includes(first), false); assert.equal(all.includes(second), false);
});

test('blind: path allowance is limited to one denied path', async t => {
  const f = await fixture(t);
  await writeFile(join(f.vault, 'wiki', 'secret.md'), 'ordinary text');
  await writeFile(join(f.vault, 'wiki', 'secrets.md'), 'ordinary text');
  const r = f.run('allow', 'wiki/secret.md', '--json'); assert.equal(r.status, 0);
  const cfg = await f.config();
  assert.deepEqual(cfg.safety.allow, [{ path: 'wiki/secret.md', ruleId: 'denied-path' }]);
  const inventory = await inventoryVault({ vaultPath: f.vault, config: cfg });
  assert.ok(inventory.files.has('wiki/secret.md'));
  assert.ok(inventory.refused.some(row => row.path === 'wiki/secrets.md'));
});

test('blind: reject traversal, symlinks, bad encoding and clean or missing targets without writes', async t => {
  const f = await fixture(t); const external = join(f.root, 'outside.md');
  await writeFile(external, first); await symlink(external, join(f.vault, 'wiki', 'link.md'));
  await symlink(f.root, join(f.vault, 'wiki', 'linkdir'));
  await writeFile(join(f.vault, 'wiki', 'clean.md'), 'ordinary text');
  await writeFile(join(f.vault, 'wiki', 'bad.md'), Buffer.from([0xff]));
  const initial = await readFile(f.file, 'utf8');
  for (const path of ['../outside.md', '/tmp/outside.md', 'wiki/../outside.md', 'wiki/link.md', 'wiki/linkdir/outside.md', 'wiki/bad.md', 'wiki/clean.md', 'wiki/missing.md']) {
    const result = f.run('allow', path, '--json'); assert.notEqual(result.status, 0, path);
    assert.equal((result.stdout + result.stderr).includes(first), false);
  }
  assert.equal(await readFile(f.file, 'utf8'), initial); assert.equal(await readFile(external, 'utf8'), first);
  const inventory = await inventoryVault({ vaultPath: f.vault, config: await f.config() }); assert.equal(inventory.files.has('wiki/link.md'), false);
});

test('blind: legacy migration, backup and schema rejection', async t => {
  const f = await fixture(t); const legacy = { profile: 'lite', vault: { path: f.vault }, safety: { extraDenyGlobs: ['private.md'] } };
  const result = await migrateConfig(legacy, { backupDir: f.root, now: new Date('2020-01-01T00:00:00Z') });
  assert.deepEqual(result.config.safety, { secretFilter: true, extraDenyGlobs: ['private.md'], allow: [] });
  assert.deepEqual(JSON.parse(await readFile(result.backupPath, 'utf8')), legacy); assert.ok(validateConfig(result.config).ok);
  const oldV1 = defaultConfig('lite'); delete oldV1.safety.allow; assert.ok(validateConfig(oldV1).ok);
  for (const entry of [{ path: '../x', ruleId: 'denied-path' }, { path: 'x', ruleId: 'openai' }, { path: 'x', ruleId: 'denied-path', sha256: 'a'.repeat(64) }, { path: 'x', ruleId: 'openai', sha256: 'z'.repeat(64) }]) {
    const cfg = defaultConfig('lite'); cfg.safety.allow = [entry]; assert.equal(validateConfig(cfg).ok, false);
  }
  const disabled = defaultConfig('full'); disabled.safety.secretFilter = false; assert.equal(validateConfig(disabled).ok, false);
  await assert.rejects(migrateConfig('{invalid', { backupDir: f.root }));
  assert.ok((await readdir(f.root)).some(name => name.startsWith('config.json.bak.')));
});
