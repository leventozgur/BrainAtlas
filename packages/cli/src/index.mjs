// SPDX-License-Identifier: MIT
import { readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { defaultConfig, loadConfig, saveConfig, setConfigValue, resolvePaths, validateConfig } from '@brainatlas/core';

const error = (code, message) => Object.assign(new Error(message), { code });
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
    if (cfg.agents.some(a => !available.includes(a) || !/^[a-z0-9-]+$/.test(a))) throw error('E_AGENT_UNKNOWN', 'Unknown agent adapter.');
    const warnings = [];
    for (const agent of cfg.agents) {
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
    const cfg = await config(); const checks = { config: validateConfig(cfg).ok };
    try { await access(paths.currentDir); checks.release = true; } catch { checks.release = false; }
    if (env.BRAINATLAS_TEST_DOCTOR_FAIL === '1') checks.injected = false;
    const ok = Object.values(checks).every(Boolean);
    output({ ok, checks, profile: cfg.profile, modules: cfg.modules });
    if (command === 'doctor' && !ok) process.exitCode = 1;
    return;
  }
  if (command === 'config') {
    const action = args.shift(); const key = args.shift(); const cfg = await config();
    if (!key || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)?$/.test(key)) throw error('E_CONFIG_KEY', 'Invalid configuration key.');
    if (action === 'get') { const result = key.split('.').reduce((v, k) => v?.[k], cfg); if (result === undefined) throw error('E_CONFIG_KEY', 'Unknown configuration key.'); output(result); return; }
    if (action === 'set') { const raw = args.shift(); if (raw === undefined || raw.startsWith('--')) throw error('E_ARGUMENT', 'Missing configuration value.'); let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; } const updated = setConfigValue(cfg, key, parsed); if (!plan) await saveConfig(updated, { paths }); output({ action: 'config set', key }); return; }
  }
  if (command === 'update' && flag('--check')) { output({ status: 'unknown' }); return; }
  if (command === 'hook' || command === 'mcp') throw error('E_COMPONENT_MISSING', 'Requested component entry point is unavailable.');
  throw error('E_NOT_IMPLEMENTED', 'Command is not implemented.');
}
export const activate = main;
