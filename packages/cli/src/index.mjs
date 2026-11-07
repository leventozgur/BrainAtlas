// SPDX-License-Identifier: MIT
import { readdir, access, mkdir, readFile, readlink, lstat, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { defaultConfig, loadConfig, saveConfig, setConfigValue, resolvePaths, validateConfig } from '@brainatlas/core';
import { inspectReleaseArchive, extractVerifiedRelease } from './archive.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });
const validVersion = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';
const journalPath = paths => join(paths.stateDir, 'update-journal.json');
const previousPath = paths => join(paths.stateDir, 'previous-release');
const releaseLink = version => `releases/${version}`;

async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 }); await rename(temp, file); }
  catch { await rm(temp, { force: true }); throw error('E_STATE_WRITE', 'Could not write update state.'); }
}
async function readCurrent(paths) {
  let target;
  try { target = await readlink(paths.currentDir); } catch (e) { if (e.code === 'ENOENT') return null; throw error('E_CURRENT_INVALID', 'Current release link is invalid.'); }
  if (target.startsWith('/') && target.startsWith(`${paths.releasesDir}/`)) target = `releases/${target.slice(paths.releasesDir.length + 1)}`;
  const match = /^releases\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(target);
  if (!match || !validVersion(match[1])) throw error('E_CURRENT_INVALID', 'Current release link is invalid.');
  return target;
}
function validateReleaseLink(target, allowNull = true) {
  if (target === null && allowNull) return null;
  if (typeof target !== 'string' || !/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target) || !validVersion(target.slice('releases/'.length))) throw error('E_JOURNAL_INVALID', 'Update journal is invalid.');
  return target;
}
async function switchCurrent(paths, target) {
  const currentExists = await exists(paths.currentDir);
  if (currentExists) {
    const stat = await lstat(paths.currentDir);
    if (!stat.isSymbolicLink()) throw error('E_CURRENT_INVALID', 'Current release path is not a symbolic link.');
  }
  if (target !== null) {
    validateReleaseLink(target, false);
    let releaseStat;
    try { releaseStat = await lstat(join(paths.dataDir, target)); } catch { throw error('E_RELEASE_MISSING', 'Requested release is unavailable.'); }
    if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) throw error('E_RELEASE_INVALID', 'Requested release is invalid.');
  }
  await mkdir(paths.dataDir, { recursive: true });
  const temp = `${paths.currentDir}.next-${process.pid}`;
  await rm(temp, { force: true });
  try {
    if (target === null) await rm(paths.currentDir, { force: true });
    else { await symlink(target, temp); await rename(temp, paths.currentDir); }
  } catch { await rm(temp, { force: true }); throw error('E_CURRENT_SWITCH', 'Could not switch the current release.'); }
}
async function savePrevious(paths, target) {
  if (target === null) { await rm(previousPath(paths), { force: true }); return; }
  validateReleaseLink(target, false);
  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(previousPath(paths), `${target}\n`, { mode: 0o600 });
}
async function readPrevious(paths) {
  try { return validateReleaseLink((await readFile(previousPath(paths), 'utf8')).trim(), false); }
  catch (e) { if (e.code === 'ENOENT') return null; if (e.code === 'E_JOURNAL_INVALID') throw e; throw error('E_STATE_READ', 'Could not read release state.'); }
}
async function readJournal(paths) {
  try {
    const value = JSON.parse(await readFile(journalPath(paths), 'utf8'));
    if (value?.schemaVersion !== 1 || !['update', 'rollback'].includes(value.kind) || !['extracting', 'prepared', 'switching', 'switched', 'complete', 'rolled-back'].includes(value.phase)) throw new Error();
    validateReleaseLink(value.target, false); validateReleaseLink(value.previous, true);
    if (value.staging !== null && (typeof value.staging !== 'string' || !/^releases\/\.staging-[A-Za-z0-9._-]+$/.test(value.staging))) throw new Error();
    return value;
  } catch (e) { if (e.code === 'ENOENT') return null; throw error('E_JOURNAL_INVALID', 'Update journal is invalid.'); }
}
async function clearJournal(paths) { await rm(journalPath(paths), { force: true }); }
async function doctorResult(paths, env) {
  let cfg; let configOk = true;
  try { cfg = await loadConfig({ paths, env }); configOk = validateConfig(cfg).ok; }
  catch { cfg = defaultConfig('lite'); configOk = false; }
  const checks = { config: configOk };
  try { await access(paths.currentDir); checks.release = true; } catch { checks.release = false; }
  if (env.BRAINATLAS_TEST_DOCTOR_FAIL === '1') checks.injected = false;
  return { ok: Object.values(checks).every(Boolean), checks, profile: cfg.profile, modules: cfg.modules };
}
function checkCurrentRelease(paths, env) {
  const cli = join(paths.currentDir, 'packages', 'cli', 'bin', 'brainatlas.mjs');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], { env, encoding: 'utf8', timeout: 15000 });
  let report;
  try { report = JSON.parse(result.stdout || ''); } catch { report = null; }
  if (!report || typeof report.ok !== 'boolean') return { ok: false, checks: { doctor: false } };
  if (result.error || result.status !== 0) report.ok = false;
  return report;
}
function releaseSigner(paths, env) { return env.BRAINATLAS_ALLOWED_SIGNERS || join(paths.currentDir, 'release', 'allowed_signers'); }

async function recoverUpdate(paths, env) {
  const journal = await readJournal(paths);
  if (!journal) return { recovered: false };
  const target = validateReleaseLink(journal.target, false); const previous = validateReleaseLink(journal.previous, true);
  if (journal.phase === 'extracting' || journal.phase === 'prepared') {
    if (journal.staging) await rm(join(paths.dataDir, journal.staging), { recursive: true, force: true });
    await clearJournal(paths);
    return { recovered: true, action: 'discarded-incomplete-update' };
  }
  if (journal.phase === 'switching' || journal.phase === 'rolled-back') {
    const restore = journal.kind === 'rollback' && journal.phase === 'switching' ? target : previous;
    await switchCurrent(paths, restore);
    if (journal.kind === 'rollback' && journal.phase === 'switching') await savePrevious(paths, previous);
    await clearJournal(paths);
    return { recovered: true, action: journal.kind === 'rollback' && journal.phase === 'switching' ? 'completed-rollback' : 'restored-previous-release' };
  }
  if (journal.phase === 'switched') {
    if (journal.kind === 'rollback') {
      await switchCurrent(paths, target); await savePrevious(paths, previous); await clearJournal(paths);
      return { recovered: true, action: 'completed-rollback' };
    }
    await switchCurrent(paths, target);
    const health = checkCurrentRelease(paths, env);
    if (!health.ok) {
      await switchCurrent(paths, previous);
      await clearJournal(paths);
      return { recovered: true, action: 'rolled-back-after-doctor', doctor: health };
    }
    await savePrevious(paths, previous); await clearJournal(paths);
    return { recovered: true, action: 'completed-update', doctor: health };
  }
  await switchCurrent(paths, target);
  await savePrevious(paths, previous); await clearJournal(paths);
  return { recovered: true, action: 'completed-update' };
}

export function enableOffline(env = process.env) {
  if (env.BRAINATLAS_OFFLINE === '1') globalThis.fetch = async () => { throw error('E_OFFLINE', 'Network access is disabled.'); };
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  enableOffline(env);
  const args = [...argv]; const command = args.shift();
  const flag = name => args.includes(name);
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw error('E_ARGUMENT', `Missing value for ${name}.`); return args[i + 1]; };
  const paths = resolvePaths({ platform: env.BRAINATLAS_PLATFORM || process.platform, env });
  const json = flag('--json'); const plan = flag('--plan');
  const output = data => console.log(json || plan ? JSON.stringify(data, null, 2) : typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  const config = () => loadConfig({ paths, env });
  if (command === 'init') {
    let vault = value('--vault');
    if (!vault && !flag('--yes')) {
      if (!process.stdin.isTTY) throw error('E_ARGUMENT', 'Use --vault or --yes for non-interactive initialization.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { vault = await rl.question('Vault path: '); } finally { rl.close(); }
    }
    const cfg = defaultConfig(value('--profile') || 'lite');
    cfg.vault.path = resolve(vault || join(env.HOME, 'BrainAtlas'));
    cfg.node.path = process.execPath;
    const agents = value('--agents'); cfg.agents = agents ? agents.split(',').filter(Boolean) : [];
    const adapterRoot = resolve(new URL('../../adapters/', import.meta.url).pathname);
    let available = []; try { available = await readdir(adapterRoot); } catch {}
    if (cfg.agents.some(a => !/^[a-z0-9-]+$/.test(a))) throw error('E_AGENT_UNKNOWN', 'Invalid agent adapter name.');
    const warnings = [];
    for (const agent of cfg.agents) {
      if (!available.includes(agent)) { warnings.push(`Adapter ${agent} is unavailable.`); continue; }
      try {
        const adapter = await import(pathToFileURL(join(adapterRoot, agent, 'src/index.mjs')).href);
        const ctx = { env, config: cfg, paths, scope: cfg.scope, nodePath: process.execPath, shimPath: paths.binPath, now: new Date() };
        const changes = await adapter.plan(ctx);
        if (!plan && adapter.apply) await adapter.apply(changes, ctx);
      } catch (e) { if (e.code === 'E_NOT_IMPLEMENTED' || e.code === 'ERR_MODULE_NOT_FOUND') warnings.push(`Adapter ${agent} is unavailable.`); else throw e; }
    }
    if (!plan) await saveConfig(cfg, { paths });
    output({ action: 'init', configFile: paths.configFile, warnings }); return;
  }
  if (command === 'status' || command === 'doctor') {
    const result = await doctorResult(paths, env);
    output(result);
    if (command === 'doctor' && !result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'config') {
    const action = args.shift(); const key = args.shift(); const cfg = await config();
    if (!key || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)?$/.test(key)) throw error('E_CONFIG_KEY', 'Invalid configuration key.');
    if (action === 'get') { const result = key.split('.').reduce((v, k) => v?.[k], cfg); if (result === undefined) throw error('E_CONFIG_KEY', 'Unknown configuration key.'); output(result); return; }
    if (action === 'set') { const raw = args.shift(); if (raw === undefined || raw.startsWith('--')) throw error('E_ARGUMENT', 'Missing configuration value.'); let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; } const updated = setConfigValue(cfg, key, parsed); if (!plan) await saveConfig(updated, { paths }); output({ action: 'config set', key }); return; }
  }
  if (command === 'update' && flag('--check')) { output({ status: 'unknown' }); return; }
  if (command === 'update' && flag('--from')) {
    const archive = resolve(value('--from'));
    const signer = releaseSigner(paths, env);
    const { manifest } = await inspectReleaseArchive(archive, signer);
    const target = releaseLink(manifest.version);
    const previous = await readCurrent(paths);
    if (await exists(join(paths.releasesDir, manifest.version))) throw error('E_RELEASE_EXISTS', 'Release version is already installed.');
    const staging = `releases/.staging-${process.pid}-${Date.now()}`;
    if (plan) { output({ action: 'update', version: manifest.version, profile: manifest.profile, from: archive, previous, target }); return; }
    const state = { schemaVersion: 1, kind: 'update', phase: 'extracting', version: manifest.version, target, previous, staging };
    await mkdir(paths.releasesDir, { recursive: true });
    await writeJsonFile(journalPath(paths), state);
    try {
      const extracted = await extractVerifiedRelease(archive, join(paths.dataDir, staging), signer);
      if (extracted.version !== manifest.version) throw error('E_MANIFEST_INVALID', 'Release version changed during extraction.');
      await rename(join(paths.dataDir, staging), join(paths.releasesDir, manifest.version));
      state.phase = 'prepared'; await writeJsonFile(journalPath(paths), state);
      state.phase = 'switching'; await writeJsonFile(journalPath(paths), state);
      await switchCurrent(paths, target);
      state.phase = 'switched'; await writeJsonFile(journalPath(paths), state);
      const health = checkCurrentRelease(paths, env);
      if (!health.ok) {
        await switchCurrent(paths, previous);
        state.phase = 'rolled-back'; await writeJsonFile(journalPath(paths), state);
        await clearJournal(paths);
        throw error('E_DOCTOR_FAILED', 'New release failed its health check; previous release restored.');
      }
      await savePrevious(paths, previous);
      state.phase = 'complete'; await writeJsonFile(journalPath(paths), state);
      await clearJournal(paths);
      output({ action: 'update', version: manifest.version, profile: manifest.profile, doctor: health }); return;
    } catch (cause) {
      const currentJournal = await readJournal(paths).catch(() => null);
      if (currentJournal?.phase === 'extracting' || currentJournal?.phase === 'prepared') {
        await rm(join(paths.dataDir, staging), { recursive: true, force: true });
        await clearJournal(paths);
      } else if (currentJournal?.phase === 'switching') {
        await switchCurrent(paths, previous); await clearJournal(paths);
      }
      throw cause;
    }
  }
  if (command === 'rollback') {
    const current = await readCurrent(paths); const requested = value('--to');
    const target = requested ? releaseLink(requested) : await readPrevious(paths);
    if (requested && !validVersion(requested)) throw error('E_ARGUMENT', 'Release version is invalid.');
    if (!target || target === current) throw error('E_RELEASE_MISSING', 'No different previous release is available.');
    if (!(await exists(join(paths.dataDir, target)))) throw error('E_RELEASE_MISSING', 'Requested release is unavailable.');
    if (plan) { output({ action: 'rollback', from: current, to: target }); return; }
    const state = { schemaVersion: 1, kind: 'rollback', phase: 'switching', version: target.slice('releases/'.length), target, previous: current, staging: null };
    await writeJsonFile(journalPath(paths), state);
    await switchCurrent(paths, target);
    state.phase = 'switched'; await writeJsonFile(journalPath(paths), state);
    await savePrevious(paths, current);
    state.phase = 'complete'; await writeJsonFile(journalPath(paths), state);
    await clearJournal(paths);
    output({ action: 'rollback', from: current, to: target }); return;
  }
  if (command === 'recover') {
    if (plan) { const journal = await readJournal(paths); output({ action: 'recover', pending: Boolean(journal), journal }); return; }
    output(await recoverUpdate(paths, env)); return;
  }
  if (command === 'eval') {
    let component;
    try { component = await import(new URL('../../../eval/run-eval.mjs', import.meta.url)); }
    catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Evaluation component is unavailable.'); throw e; }
    if (typeof component.runEval !== 'function') throw error('E_COMPONENT_MISSING', 'Evaluation component is unavailable.');
    output(await component.runEval({ cases: value('--cases'), corpus: value('--corpus') })); return;
  }
  if (command === 'hook' || command === 'mcp') {
    let component;
    try { component = command === 'hook' ? await import('@brainatlas/hooks') : await import('@brainatlas/mcp'); }
    catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') throw error('E_COMPONENT_MISSING', 'Requested component is unavailable.'); throw e; }
    const entry = command === 'hook' ? component.runHook : component.main;
    if (typeof entry !== 'function') throw error('E_COMPONENT_MISSING', 'Requested component entry point is unavailable.');
    try {
      if (command === 'mcp') await entry({ config: await config(), paths, env });
      else {
        let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
        const result = await entry({ client: args[0], event: args[1], stdin, env, now: new Date(), config: await config() });
        if (result.stdout) process.stdout.write(result.stdout); process.exitCode = result.exitCode;
      }
    } catch (e) { if (e.code === 'E_NOT_IMPLEMENTED') throw error('E_COMPONENT_MISSING', 'Requested component is unavailable.'); throw e; }
    return;
  }
  throw error('E_NOT_IMPLEMENTED', 'Command is not implemented.');
}
export const activate = main;
