// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { absoluteVaultPath, resolvePaths, vaultId, vaultStateDir } from '../../packages/core/src/paths/index.mjs';
import { DEFAULT_EXCLUDE_WIKI, createSearcher } from '../../packages/core/src/retrieval/index.mjs';
import { callToolInProcess } from '../../packages/mcp/src/in-process.mjs';
import { runHook } from '../../packages/hooks/src/index.mjs';

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false
  );

async function fixture(t, name = 'vault') {
  const base = await mkdtemp(join(tmpdir(), 'ba105-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, name);
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'alpha.md'), '---\nstatus: draft\n---\n# Alpha\n\nzebrafish alpha text.\n');
  const env = { HOME: home, XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data') };
  const paths = resolvePaths({ platform: 'linux', env });
  const config = defaultConfig('lite');
  config.vault.path = vault;
  return { base, home, vault, env, paths, config, state: vaultStateDir(paths, vault) };
}

const rootIndex = (f) => join(f.paths.stateDir, 'retrieval-index.json');
const vaultIndex = (f) => join(f.state, 'retrieval-index.json');

test('BA-105: vaultStateDir is stateDir joined with the vault id', async (t) => {
  const f = await fixture(t);
  assert.equal(f.state, join(f.paths.stateDir, vaultId(f.vault)));
  assert.equal(vaultStateDir(f.paths, `${f.vault}/../vault`), f.state);
});

test('BA-105: MCP server, hook and searcher share one per-vault index', async (t) => {
  const f = await fixture(t);
  const options = { config: f.config, paths: f.paths, env: f.env };
  await callToolInProcess(options, 'wiki_query', { query: 'zebrafish' });
  assert.ok(await exists(vaultIndex(f)));
  assert.equal(await exists(rootIndex(f)), false);
  const before = await readFile(vaultIndex(f), 'utf8');
  const hook = await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: 'ba105', prompt: 'zebrafish' }),
    env: f.env,
    config: { ...f.config, retrieval: { abstainThreshold: 0 } },
    now: new Date('2026-11-27T00:00:00Z'),
  });
  assert.equal(hook.exitCode, 0);
  assert.match(hook.stdout, /alpha\.md/);
  assert.equal(await readFile(vaultIndex(f), 'utf8'), before);
  assert.equal(await exists(rootIndex(f)), false);
});

test('BA-105: a root index built for the same vault is adopted by moving it', async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.stateDir, { recursive: true });
  createSearcher({
    vaultDir: join(f.vault, 'wiki'),
    stateDir: f.paths.stateDir,
    exclude: DEFAULT_EXCLUDE_WIKI,
  });
  const built = await readFile(rootIndex(f), 'utf8');
  await callToolInProcess({ config: f.config, paths: f.paths, env: f.env }, 'wiki_query', { query: 'zebrafish' });
  assert.equal(await readFile(vaultIndex(f), 'utf8'), built);
  assert.equal(await exists(rootIndex(f)), false);
});

test('BA-105: a root index built for another vault is ignored and left in place', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t, 'other');
  await writeFile(join(other.vault, 'wiki', 'beta.md'), '# Beta\n\nunrelated text.\n');
  await mkdir(f.paths.stateDir, { recursive: true });
  createSearcher({
    vaultDir: join(other.vault, 'wiki'),
    stateDir: f.paths.stateDir,
    exclude: DEFAULT_EXCLUDE_WIKI,
  });
  const foreign = await readFile(rootIndex(f), 'utf8');
  await callToolInProcess({ config: f.config, paths: f.paths, env: f.env }, 'wiki_query', { query: 'zebrafish' });
  assert.equal(await readFile(rootIndex(f), 'utf8'), foreign);
  assert.notEqual(await readFile(vaultIndex(f), 'utf8'), foreign);
});

test('BA-105: vaultStateDir rejects a relative vault path', async (t) => {
  const f = await fixture(t);
  assert.throws(() => vaultStateDir(f.paths, 'relative/vault'), {
    code: 'E_PATHS',
    message: 'Vault path must be absolute.',
  });
});

test('BA-105: a relative config vault path resolves to the same state dir for MCP and hook', async (t) => {
  const f = await fixture(t);
  const relative = join('..', 'vault');
  const config = { ...f.config, vault: { path: relative } };
  const home = join(f.home, 'sub');
  await mkdir(home, { recursive: true });
  const env = { ...f.env, HOME: home };
  const vault = absoluteVaultPath(relative, home);
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'alpha.md'), '# Alpha\n\nzebrafish text.\n');
  const paths = resolvePaths({ platform: 'linux', env });
  const state = vaultStateDir(paths, vault);
  await callToolInProcess({ config, paths, env }, 'wiki_query', { query: 'zebrafish' });
  assert.ok(await exists(join(state, 'retrieval-index.json')));
  const before = await readFile(join(state, 'retrieval-index.json'), 'utf8');
  await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: 'ba105-rel', prompt: 'zebrafish' }),
    env,
    config: { ...config, retrieval: { abstainThreshold: 0 } },
    now: new Date('2026-11-27T00:00:00Z'),
  });
  assert.equal(await readFile(join(state, 'retrieval-index.json'), 'utf8'), before);
});

test('BA-105: the hook never adopts a root index', async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.stateDir, { recursive: true });
  createSearcher({
    vaultDir: join(f.vault, 'wiki'),
    stateDir: f.paths.stateDir,
    exclude: DEFAULT_EXCLUDE_WIKI,
  });
  await runHook({
    client: 'claude',
    event: 'prompt',
    stdin: JSON.stringify({ session_id: 'ba105-hook', prompt: 'zebrafish' }),
    env: f.env,
    config: { ...f.config, retrieval: { abstainThreshold: 0 } },
    now: new Date('2026-11-27T00:00:00Z'),
  });
  assert.ok(await exists(rootIndex(f)));
});

test('BA-105: a foreign root index is parsed once per searcher', async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.stateDir, { recursive: true });
  await writeFile(rootIndex(f), '{"key":"other"}');
  const searcher = createSearcher({
    vaultDir: join(f.vault, 'wiki'),
    stateDir: f.state,
    adoptFrom: f.paths.stateDir,
  });
  await rm(rootIndex(f));
  await writeFile(rootIndex(f), '{"key":"other"}');
  await writeFile(join(f.vault, 'wiki', 'beta.md'), '# Beta\n');
  await searcher.refresh();
  assert.ok(await exists(rootIndex(f)));
});
