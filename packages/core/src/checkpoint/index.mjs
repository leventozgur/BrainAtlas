// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { runCommand as defaultRunCommand, BrainAtlasError, resolveSafePath } from '../util/index.mjs';
import * as defaultSafety from '../safety/index.mjs';

const output = (value) => typeof value === 'string' ? value : value?.stdout ?? '';
const failed = (value) => value?.ok === false || (typeof value?.exitCode === 'number' && value.exitCode !== 0) || (typeof value?.status === 'number' && value.status !== 0) || (typeof value?.code === 'number' && value.code !== 0);
const findings = (value) => Array.isArray(value) ? value.length > 0 : Array.isArray(value?.findings) ? value.findings.length > 0 : value?.ok === false;

/** Stage configured paths, safety scan staged blobs, lint and commit. */
export async function checkpoint(vaultDir, message, options = {}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 120 || /[\r\n]/.test(message)) throw new BrainAtlasError('E_CHECKPOINT_MESSAGE', 'Checkpoint message is invalid.');
  let base = resolve(vaultDir);
  const paths = options.paths ?? ['wiki/'];
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string' || p.startsWith('/') || p.includes('\\') || p.split('/').filter(Boolean).some((segment) => segment === '.' || segment === '..'))) throw new BrainAtlasError('E_CHECKPOINT_PATH', 'Checkpoint paths are invalid.');
  const run = options.runCommand ?? options.git?.runCommand ?? options.git?.run ?? defaultRunCommand;
  const call = (args) => run('git', args, { cwd: base, env: options.env, timeoutMs: 15000, shell: false });
  try {
    const probe = await call(['rev-parse', '--is-inside-work-tree']);
    if (failed(probe) || output(probe).trim() !== 'true') return { committed: false, skipped: true, reason: 'not-a-git-repository' };
  } catch { return { committed: false, skipped: true, reason: 'git-unavailable-or-not-a-repository' }; }
  base = await realpath(base);
  for (const path of paths) {
    const rel = path.endsWith('/') ? path.slice(0, -1) : path;
    if (rel) await resolveSafePath(base, rel);
  }
  const lintGate = options.lint ?? options.lintGate;
  if (typeof lintGate !== 'function') throw new BrainAtlasError('E_CHECKPOINT_LINT', 'Checkpoint requires an injected lint gate.');
  const lintResult = await lintGate(base);
  if (lintResult === false || lintResult?.ok === false || lintResult?.errorCount > 0) throw new BrainAtlasError('E_CHECKPOINT_LINT', 'Checkpoint refused because the lint gate failed.');
  await call(['add', '--', ...paths]);
  const changed = output(await call(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean).sort();
  const allowed = (file) => paths.some((p) => p.endsWith('/') ? file.startsWith(p) : file === p || file.startsWith(`${p}/`));
  if (changed.some((file) => !allowed(file))) throw new BrainAtlasError('E_CHECKPOINT_SCOPE', 'Staged changes include paths outside the checkpoint scope.');
  if (!changed.length) return { committed: false, skipped: true, reason: 'no-staged-changes' };
  const safety = options.safety ?? defaultSafety;
  for (const rel of changed) {
    if (findings(await safety.scanPath(rel))) throw new BrainAtlasError('E_SECRET_DETECTED', 'Checkpoint refused by the path safety scan.');
    let staged;
    try { staged = output(await call(['show', `:${rel}`])); }
    catch { throw new BrainAtlasError('E_CHECKPOINT_SCAN', 'Unable to inspect staged content.'); }
    if (findings(await safety.scanText(staged))) throw new BrainAtlasError('E_SECRET_DETECTED', 'Checkpoint refused by the content safety scan.');
  }
  const commit = await call(['-c', 'user.name=Vault Agent', '-c', 'user.email=agent@example.com', 'commit', '-m', message]);
  if (failed(commit)) throw new BrainAtlasError('E_CHECKPOINT_GIT', 'Git commit failed.');
  return { committed: true, skipped: false, paths: changed, output: output(commit).trim() };
}
