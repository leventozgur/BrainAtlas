// SPDX-License-Identifier: MIT
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  appendLog,
  atomicWriteFile,
  lintPolicyReferences,
  parseFrontmatter,
  readStandard,
  refreshVaultPolicy,
  scanText,
  secretFilterEnabled,
  standardFromConfig,
  vaultStateDir,
  absoluteVaultPath,
  writeStandard,
} from '@brainatlas/core';
import { commandNames } from './index.mjs';
import { orphanStateDirs } from './commands/lifecycle.mjs';
import { activeCommandNames, error } from './commands/shared.mjs';
import { readInstallManifest } from './install-manifest.mjs';

const PLANNING_NAME = /(^|-)(backlog|todo|tasks|roadmap)(-|$)/i;
const DIRECTORIES = [
  'wiki/entities',
  'wiki/concepts',
  'wiki/sources',
  'wiki/summaries',
  'wiki/queries',
  'raw',
  'inbox',
  'planning',
  'planning/projects',
];
const BACKLOG = 'planning/backlog.md';
const KEEP_BACKUPS = 3;
const stampOf = (date) => date.toISOString().replace(/[:.]/g, '-');

async function kindOf(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'));
}

async function insideAfterResolve(root, target) {
  let probe = target;
  for (;;) {
    try {
      return inside(root, await realpath(probe));
    } catch (cause) {
      if (cause?.code !== 'ENOENT' || probe === dirname(probe)) return false;
      probe = dirname(probe);
    }
  }
}

const GUARDED = ['.brainatlas', '.brainatlas/migrations', 'planning', 'planning/projects', 'wiki', ...DIRECTORIES];

async function unsafeLayout(base) {
  const bad = [];
  for (const rel of [...new Set(GUARDED)]) {
    const target = join(base, rel);
    const kind = await kindOf(target);
    if (kind === null) continue;
    if (kind === 'symlink' || !(await insideAfterResolve(base, target))) bad.push(rel);
  }
  return bad;
}

async function planningPageNames(base) {
  const root = join(base, 'wiki');
  if ((await kindOf(root)) !== 'dir') return [];
  const found = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith('.md') && PLANNING_NAME.test(entry.name.slice(0, -3)))
        found.push(rel);
    }
  };
  await walk(root, '');
  return found.sort();
}

function slugFor(rel) {
  const stem = basename(rel, '.md')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56);
  return stem || 'moved';
}

const oneLine = (text) =>
  text
    .replace(/[|\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);

function titleFor(text, slug) {
  const front = parseFrontmatter(text).data.title;
  const heading = /^#\s+(.+)$/m.exec(text)?.[1];
  return oneLine(typeof front === 'string' ? front : (heading ?? '')) || slug;
}

function displayPath(homes, file) {
  const home = homes.find((candidate) => inside(candidate, file));
  return home ? `~/${relative(home, file)}` : file;
}

async function canonical(file) {
  try {
    return join(await realpath(dirname(file)), basename(file));
  } catch {
    return file;
  }
}

function unwrap(result) {
  if (result.isError) {
    const match = /^(E_[A-Z0-9_]+):/u.exec(result.text);
    throw error(match ? match[1] : 'E_PLAN_TOOL', 'A vault tool refused the change.');
  }
  return result.text ? JSON.parse(result.text) : {};
}

async function adapterBackups(paths, env, cfg, warnings) {
  let managed;
  try {
    managed = ((await readInstallManifest(paths)).files ?? [])
      .filter((item) => item.role === 'adapter-config')
      .map((item) => item.path);
  } catch (cause) {
    warnings.push(`Install manifest could not be read (${cause?.code ?? 'error'}); adapter backups were not checked.`);
    return [];
  }
  const claude = env.HOME && (cfg.agents ?? []).includes('claude-code') ? [join(env.HOME, '.claude.json')] : [];
  const files = [...new Set(await Promise.all([...managed, ...claude].map(canonical)))];
  const homes = env.HOME ? [...new Set([env.HOME, await canonical(join(env.HOME, 'x')).then(dirname)])] : [];
  const groups = [];
  for (const file of files) {
    const prefix = `${basename(file)}.bak.`;
    let names;
    try {
      names = (await readdir(dirname(file))).filter((name) => name.startsWith(prefix));
    } catch (cause) {
      if (cause?.code !== 'ENOENT')
        warnings.push(`${displayPath(homes, file)}: backups could not be listed (${cause?.code ?? 'error'}).`);
      continue;
    }
    const backups = [];
    for (const name of names) {
      const path = join(dirname(file), name);
      let info;
      try {
        info = await lstat(path);
      } catch {
        continue;
      }
      if (info.isFile()) backups.push({ path, mtime: info.mtimeMs, name });
    }
    backups.sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name));
    if (backups.length) groups.push({ label: displayPath(homes, file), backups });
  }
  return groups;
}

/**
 * @param {{cfg: any, paths: any, env: any, force?: boolean, prune?: boolean, stamp: string, cheap?: boolean}} input
 */
export async function planStandardMigration({ cfg, paths, env, force = false, prune = false, stamp, cheap = false }) {
  let base;
  try {
    base = await realpath(cfg.vault.path);
  } catch {
    throw error('E_ARGUMENT', 'The vault directory does not exist.');
  }
  const items = [];
  const warnings = [];
  const unsafe = await unsafeLayout(base);
  for (const rel of unsafe)
    warnings.push(`${rel}: the path is a symbolic link or leaves the vault; the affected steps were not planned.`);
  const blocked = (...rels) => rels.some((rel) => unsafe.includes(rel));
  const add = (kind, path, detail, run, report = false) =>
    items.push({ step: { id: `${kind}:${path}`, kind, path, detail }, run, report });

  for (const rel of DIRECTORIES) {
    const target = join(base, rel);
    if ((await kindOf(target)) !== null) continue;
    if (!(await insideAfterResolve(base, target))) {
      warnings.push(`${rel}: the path leaves the vault; it was not created.`);
      continue;
    }
    add('skeleton', rel, 'create directory', () => mkdir(target, { recursive: true }));
  }
  const backlog = join(base, BACKLOG);
  if (!blocked('planning') && (await kindOf(backlog)) === null && (await insideAfterResolve(base, backlog)))
    add('skeleton', BACKLOG, 'create from template', async () => {
      const template = await readFile(new URL('../../../templates/vault/backlog.md', import.meta.url));
      await atomicWriteFile(backlog, template);
    });

  const current = await readStandard(base);
  if (current.standard === null && current.errors.length === 0) {
    if (!blocked('.brainatlas'))
      add('standard', '.brainatlas/standard.json', 'create from device config', () =>
        writeStandard(base, standardFromConfig(cfg))
      );
  } else if (current.errors.length)
    warnings.push(`.brainatlas/standard.json is invalid (${current.errors[0].code}); it was not changed.`);

  const policy = await refreshVaultPolicy({ vaultDir: base, plan: true, force });
  warnings.push(...policy.warnings);
  const policyChanges = policy.changes.filter((item) => item.action !== 'none');
  if (policyChanges.length && !blocked('.brainatlas'))
    add(
      'policy',
      policyChanges.map((change) => change.path).join(', '),
      policyChanges.map((change) => change.action).join(', '),
      async (ctx) => {
        for (const change of policyChanges) await ctx.backup(change.path);
        await refreshVaultPolicy({ vaultDir: base, force });
      }
    );

  const taken = new Set();
  const pagesBlocked = blocked('planning', 'planning/projects', 'wiki', '.brainatlas');
  for (const rel of pagesBlocked ? [] : await planningPageNames(base)) {
    const source = join(base, 'wiki', rel);
    const guarded = secretFilterEnabled(cfg);
    const text = cheap && !guarded ? '' : (await readFile(source)).toString('utf8');
    if (guarded && scanText(text).length) {
      if (!cheap) warnings.push(`wiki/${rel}: secret-like content detected; it was not moved.`);
      continue;
    }
    if (cheap) {
      add('planning-page', `wiki/${rel}`, 'move to planning/projects', async () => {});
      continue;
    }
    const root = slugFor(rel);
    let slug = root;
    for (let n = 2; taken.has(slug) || (await kindOf(join(base, 'planning/projects', `${slug}.md`))) !== null; n++)
      slug = `${root}-${n}`;
    taken.add(slug);
    const target = `planning/projects/${slug}.md`;
    add('planning-page', `wiki/${rel}`, target, async (ctx) => {
      for (const file of [`wiki/${rel}`, BACKLOG, 'wiki/index.md', 'wiki/log.md']) await ctx.backup(file);
      const bytes = await readFile(source);
      const previous = (await kindOf(backlog)) === 'file' ? await readFile(backlog) : null;
      let created = null;
      let reindexed = false;
      try {
        const added = unwrap(
          await ctx.call('plan_update', {
            op: 'add_project',
            slug,
            title: titleFor(text, slug),
            purpose: `Moved from wiki/${rel} by standard migrate.`,
            status: 'idea',
          })
        );
        created = join(base, added.file);
        await atomicWriteFile(created, bytes);
        if (!bytes.equals(await readFile(created))) throw error('E_VERIFY', 'The moved page could not be verified.');
        await rm(source);
        try {
          unwrap(await ctx.call('wiki_update_index'));
          reindexed = true;
        } catch {
          ctx.warn(`Run brainatlas wiki reindex; the index still lists wiki/${rel}.`);
        }
        await appendLog(base, { action: 'standard-migrate', path: `wiki/${rel}` });
      } catch (cause) {
        let restored = true;
        try {
          if (created) await rm(created, { force: true });
          if (previous) await atomicWriteFile(backlog, previous);
          else await rm(backlog, { force: true });
          if ((await kindOf(source)) === null) await atomicWriteFile(source, bytes);
        } catch {
          restored = false;
        }
        if (reindexed) {
          try {
            unwrap(await ctx.call('wiki_update_index'));
          } catch {
            ctx.warn('Run brainatlas wiki reindex; the index may be out of date.');
          }
        }
        throw Object.assign(cause, { rolledBack: restored });
      }
    });
  }

  if (!cheap) {
    const references = await lintPolicyReferences({
      vaultDir: base,
      home: env.HOME,
      knownCommands: await activeCommandNames(paths, env, cfg, commandNames),
    });
    warnings.push(...references.warnings);
  }

  const stateRoot = paths.stateDir;
  let orphans = [];
  try {
    orphans = await orphanStateDirs(paths, cfg.vault.path);
  } catch (cause) {
    if (cause?.code !== 'ENOENT') warnings.push(`State directory could not be read (${cause?.code ?? 'error'}).`);
  }
  for (const name of orphans)
    add('orphan-state', `state/${name}`, `archive/${name}-<stamp>`, async () => {
      const archive = join(stateRoot, 'archive');
      await mkdir(archive, { recursive: true });
      if (!(await insideAfterResolve(await realpath(stateRoot), join(archive, name)))) throw error('E_PATH', 'Path.');
      await rename(join(stateRoot, name), join(archive, `${name}-${stamp}`));
    });

  const vaultState = vaultStateDir(paths, absoluteVaultPath(cfg.vault.path, env.HOME));
  const rootIndex = join(stateRoot, 'retrieval-index.json');
  const rootSemantic = join(stateRoot, 'semantic');
  const hasIndex = (await kindOf(join(vaultState, 'retrieval-index.json'))) === 'file';
  const hasSemantic = (await kindOf(join(vaultState, 'semantic'))) === 'dir';
  const staleIndex = hasIndex && (await kindOf(rootIndex)) === 'file';
  const staleSemantic = hasSemantic && (await kindOf(rootSemantic)) === 'dir';
  if (staleIndex || staleSemantic) {
    add(
      'duplicate-index',
      [staleIndex && 'state/retrieval-index.json', staleSemantic && 'state/semantic'].filter(Boolean).join(', '),
      'remove the root caches (cache; rebuilt on demand)',
      async () => {
        if (staleIndex) await rm(rootIndex);
        if (staleSemantic) await rm(rootSemantic, { recursive: true });
      }
    );
    const vaultDirs = (await readdir(stateRoot, { withFileTypes: true }).catch(() => [])).filter(
      (entry) => entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name)
    );
    if (vaultDirs.length > 1) warnings.push('Other vaults on this device rebuild their caches after this step.');
  }

  if (!cheap)
    for (const group of await adapterBackups(paths, env, cfg, warnings)) {
      const count = group.backups.length;
      if (count > KEEP_BACKUPS)
        add(
          'adapter-backups',
          group.label,
          count,
          async () => {
            if (!prune) return;
            for (const backup of group.backups.slice(KEEP_BACKUPS))
              if ((await kindOf(backup.path)) === 'file') await rm(backup.path);
          },
          true
        );
    }
  return { base, items, warnings, unsafe };
}

export async function pendingStandardMigration({ cfg, paths, env }) {
  const plan = await planStandardMigration({ cfg, paths, env, stamp: stampOf(new Date()), cheap: true });
  return plan.items.some((item) => !item.report);
}

/**
 * @param {{env: any, apply: boolean, force: boolean, prune: boolean}} input
 */
export async function runStandardMigrate({ env, apply, force, prune }) {
  const { callToolInProcess, serverOptions } = await import('@brainatlas/mcp');
  const options = await serverOptions(env);
  const { config: cfg, paths } = options;
  if (apply && cfg.readOnly === true) throw error('E_READ_ONLY', 'The vault is read-only (readOnly: true).');
  const stamp = stampOf(new Date());
  const plan = await planStandardMigration({ cfg, paths, env, force, prune, stamp });
  if (apply && plan.unsafe.length) throw error('E_PATH_ESCAPE', 'A vault path is a symbolic link or leaves the vault.');
  const steps = plan.items.map((item) => item.step);
  const changing = plan.items.some((item) => item.report !== true || prune);
  if (!apply) return { action: 'standard-migrate', mode: 'plan', steps, warnings: plan.warnings, backupDir: null };
  if (!changing) return { action: 'standard-migrate', mode: 'apply', steps, warnings: plan.warnings, backupDir: null };

  const backupRel = `.brainatlas/migrations/${stamp}`;
  const backupRoot = join(plan.base, backupRel);
  const copied = new Set();
  const safeBackupRoot = async () => {
    await mkdir(backupRoot, { recursive: true });
    if ((await kindOf(backupRoot)) !== 'dir' || !inside(plan.base, await realpath(backupRoot)))
      throw error('E_PATH_ESCAPE', 'The backup directory leaves the vault.');
  };
  const warnings = [...plan.warnings];
  const ctx = {
    call: (name, args) => callToolInProcess(options, name, args),
    warn: (text) => warnings.push(text),
    backup: async (rel) => {
      if (copied.has(rel) || (await kindOf(join(plan.base, rel))) !== 'file') return;
      await safeBackupRoot();
      const target = join(backupRoot, rel);
      await mkdir(dirname(target), { recursive: true });
      if (!inside(plan.base, await realpath(dirname(target))) || !inside(backupRoot, await realpath(dirname(target))))
        throw error('E_PATH_ESCAPE', 'The backup path leaves the vault.');
      await copyFile(join(plan.base, rel), target);
      copied.add(rel);
    },
  };
  const executed = [];
  let failure = null;
  for (const item of plan.items) {
    try {
      await item.run(ctx);
      executed.push(item.step);
    } catch (cause) {
      failure = {
        step: item.step.id,
        code: cause?.code ?? 'E_STEP_FAILED',
        ...(cause?.rolledBack === undefined ? {} : { rolledBack: cause.rolledBack }),
      };
      break;
    }
  }
  const result = {
    action: 'standard-migrate',
    mode: 'apply',
    steps: executed,
    warnings,
    backupDir: backupRel,
    ...(failure ? { error: failure } : {}),
  };
  await safeBackupRoot();
  await atomicWriteFile(join(backupRoot, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function formatStandardMigrate(result) {
  const lines = [`standard migrate (${result.mode})`];
  if (!result.steps.length) lines.push('Nothing to migrate.');
  for (const step of result.steps) lines.push(`${step.kind}  ${step.path}  ${step.detail}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.backupDir) lines.push(`backups and report: ${result.backupDir}`);
  if (result.error) lines.push(`error: ${result.error.code} at ${result.error.step}`);
  return lines.join('\n');
}
