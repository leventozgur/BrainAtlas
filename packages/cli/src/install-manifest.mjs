// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile, chmod, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = paths => paths.installManifest;
const within = (file, root) => { const rel = relative(resolve(root), resolve(file)); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const matchingRoot = (file, roots) => [...roots].map(root => resolve(root)).filter(root => within(file, root)).sort((a, b) => b.length - a.length)[0];

/** Resolve symlinked parent directories while keeping the final path itself intact. */
export async function resolveManagedPath(file, { followFinal = false } = {}) {
  checkedPath(file);
  if (followFinal) {
    try { return await realpath(file); }
    catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
  }
  const tail = followFinal ? [] : [basename(file)];
  let current = followFinal ? file : dirname(file);
  while (true) {
    try {
      const root = await realpath(current);
      return resolve(root, ...tail);
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
      const parent = dirname(current);
      if (parent === current) throw cause;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function checkedPath(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || normalize(file) !== file || file.split(/[\\/]/).includes('..')) throw fail('E_MANIFEST_INVALID', 'Install manifest path is invalid.');
  return file;
}

/** Return a stable snapshot without following the final symlink. */
export async function snapshotPath(file) {
  file = await resolveManagedPath(file);
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(await readlink(file));
      return { kind: 'symlink', bytes: target, sha256: digest(target), mode: stat.mode & 0o777 };
    }
    if (!stat.isFile()) throw fail('E_MANIFEST_PATH_TYPE', 'Install-managed path is not a regular file.');
    const bytes = await readFile(file);
    return { kind: 'file', bytes, sha256: digest(bytes), mode: stat.mode & 0o777 };
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw cause;
  }
}

async function readManifest(paths) {
  try {
    const value = JSON.parse(await readFile(manifestPath(paths), 'utf8'));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.files) || (value.createdDirectories !== undefined && !Array.isArray(value.createdDirectories))) throw new Error();
    if (!Array.isArray(value.createdDirectories)) value.createdDirectories = [];
    return value;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { schemaVersion: 1, files: [] };
    throw fail('E_MANIFEST_INVALID', 'Install manifest is invalid.');
  }
}

async function writeManifest(paths, value) {
  const file = manifestPath(paths); await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 }); await rename(temp, file); }
  catch { await rm(temp, { force: true }); throw fail('E_MANIFEST_WRITE', 'Could not update install manifest.'); }
}

/** Preserve the original state for uninstall and record the latest managed state. */
export async function recordManagedWrite(paths, file, { before = null, after = undefined, owner = undefined, role = undefined } = {}) {
  file = await resolveManagedPath(file);
  const manifest = await readManifest(paths);
  const index = manifest.files.findIndex(item => item.path === file);
  const prior = index >= 0 ? manifest.files[index] : null;
  let backupPath = prior?.backupPath || null;
  if (!prior && before) {
    const backupDir = await resolveManagedPath(join(paths.dataDir, 'install-backups'), { followFinal: true });
    const dataDir = await resolveManagedPath(paths.dataDir, { followFinal: true });
    const rel = relative(dataDir, backupDir);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fail('E_MANIFEST_INVALID', 'Install backup path is invalid.');
    await mkdir(backupDir, { recursive: true });
    backupPath = join(backupDir, `${digest(Buffer.from(file))}.before`);
    await writeFile(backupPath, before.bytes, { flag: 'wx', mode: 0o600 }).catch(async cause => { if (cause?.code !== 'EEXIST') throw cause; });
  }
  const final = after === undefined ? await snapshotPath(file) : after;
  const item = {
    path: file,
    beforeSha256: prior ? prior.beforeSha256 : before?.sha256 ?? null,
    afterSha256: final?.sha256 ?? null,
    backupPath,
    beforeKind: prior ? prior.beforeKind : before?.kind ?? null,
    afterKind: final?.kind ?? null,
    beforeMode: prior ? prior.beforeMode : before?.mode ?? null,
    afterMode: final?.mode ?? null
  };
  const owners = new Set([...(prior?.owners || (prior?.owner ? [prior.owner] : [])), ...(owner ? [owner] : [])]);
  if (owners.size) item.owners = [...owners].sort();
  if (prior?.role || role) item.role = prior?.role || role;
  if (index >= 0) manifest.files[index] = item; else manifest.files.push(item);
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  await writeManifest(paths, manifest);
  return item;
}

/** Execute a write while capturing the original and resulting bytes in the manifest. */
export async function managePath(paths, file, action) {
  const before = await snapshotPath(file);
  await action();
  const after = await snapshotPath(file);
  await recordManagedWrite(paths, file, { before, after });
}

export async function missingDirectories(directory, home, roots = [home]) {
  const target = await resolveManagedPath(directory, { followFinal: true });
  const resolvedRoots = await Promise.all(roots.map(root => resolveManagedPath(root, { followFinal: true })));
  if (!matchingRoot(target, resolvedRoots)) throw fail('E_MANIFEST_INVALID', 'Install directory is outside managed roots.');
  const missing = []; let current = target;
  while (true) {
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('E_MANIFEST_INVALID', 'Install directory path is unsafe.'); break; }
    catch (cause) { if (cause?.code !== 'ENOENT') throw cause; missing.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  }
  return missing;
}

export async function recordCreatedDirectories(paths, directories = [], home, roots = [home]) {
  const manifest = await readManifest(paths); const known = new Set(manifest.createdDirectories);
  const resolvedRoots = await Promise.all(roots.map(root => resolveManagedPath(root, { followFinal: true })));
  const resolvedHome = await resolveManagedPath(home, { followFinal: true });
  for (const directory of directories) {
    const checked = await resolveManagedPath(directory, { followFinal: true });
    if ((!matchingRoot(checked, resolvedRoots) && !resolvedRoots.some(root => within(root, checked))) || checked === resolvedHome) throw fail('E_MANIFEST_INVALID', 'Install directory is outside managed roots.');
    known.add(checked);
  }
  manifest.createdDirectories = [...known].sort((a, b) => b.split(sep).length - a.split(sep).length || a.localeCompare(b));
  await writeManifest(paths, manifest);
}

export async function removeCreatedDirectories(directories, home, roots = [home]) {
  const resolvedRoots = await Promise.all(roots.map(root => resolveManagedPath(root, { followFinal: true })));
  const resolvedHome = await resolveManagedPath(home, { followFinal: true });
  for (const directory of [...directories].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
    const checked = await resolveManagedPath(directory, { followFinal: true });
    if ((!matchingRoot(checked, resolvedRoots) && !resolvedRoots.some(root => within(root, checked))) || checked === resolvedHome) throw fail('E_MANIFEST_INVALID', 'Install directory is outside managed roots.');
    try { await rmdir(checked); }
    catch (cause) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cause?.code)) throw cause; }
  }
}

async function ensureSafeParents(file, stopAt) {
  const parent = dirname(file); const rel = relative(stopAt, parent);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside the permitted location.');
  let current = stopAt;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('E_MANIFEST_INVALID', 'Install manifest parent path is unsafe.'); }
    catch (cause) { if (cause?.code !== 'ENOENT') throw cause; await mkdir(current); }
  }
}

async function checkSafeParents(file, stopAt) {
  const parent = dirname(file); const rel = relative(stopAt, parent);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside the permitted location.');
  let current = stopAt;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('E_MANIFEST_INVALID', 'Install manifest parent path is unsafe.'); }
    catch (cause) { if (cause?.code === 'ENOENT') return; throw cause; }
  }
}

async function readBackup(paths, file) {
  const backup = checkedPath(file); const backupRoot = join(paths.dataDir, 'install-backups');
  const resolvedBackupRoot = await resolveManagedPath(backupRoot, { followFinal: true });
  const rel = relative(resolvedBackupRoot, backup);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fail('E_MANIFEST_INVALID', 'Install backup path is invalid.');
  await checkSafeParents(backup, await resolveManagedPath(paths.dataDir, { followFinal: true }));
  try { const stat = await lstat(backup); if (!stat.isFile() || stat.isSymbolicLink()) throw fail('E_MANIFEST_INVALID', 'Install backup is unsafe.'); }
  catch (cause) { if (cause?.code === 'ENOENT') throw fail('E_MANIFEST_INVALID', 'Install backup is missing.'); throw cause; }
  return readFile(backup);
}

function isApplicationPath(file, applicationPaths) {
  return applicationPaths.files.includes(file) || applicationPaths.directories.some(directory => within(file, directory));
}

function uninstallConflict(file) {
  return fail('E_UNINSTALL_CONFLICT', `A managed file changed after installation: ${file}.`, { path: file, conflicts: [file] });
}

async function preflightEntry(paths, entry, roots, applicationPaths) {
  const file = checkedPath(entry.path);
  if ((entry.afterSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.afterSha256 || '')) || (entry.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.beforeSha256 || ''))) throw fail('E_MANIFEST_INVALID', 'Install manifest entry is invalid.');
  const root = matchingRoot(file, roots);
  if (!root) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside managed roots.');
  await checkSafeParents(file, root);
  if (!isApplicationPath(file, applicationPaths)) {
    let current;
    try { current = await snapshotPath(file); }
    catch (cause) { if (cause?.code === 'E_MANIFEST_PATH_TYPE') throw uninstallConflict(file); throw cause; }
    if ((current?.sha256 ?? null) !== entry.afterSha256 || (current?.kind ?? null) !== (entry.afterKind ?? null) || (current?.mode ?? null) !== (entry.afterMode ?? null)) throw uninstallConflict(file);
  }
  if (entry.beforeSha256 === null) {
    if (entry.backupPath !== null || (entry.beforeKind !== null && entry.beforeKind !== undefined)) throw fail('E_MANIFEST_INVALID', 'Install manifest entry is invalid.');
    return;
  }
  if (!['file', 'symlink'].includes(entry.beforeKind)) throw fail('E_MANIFEST_INVALID', 'Install backup type is invalid.');
  const bytes = await readBackup(paths, entry.backupPath);
  if (digest(bytes) !== entry.beforeSha256) throw fail('E_MANIFEST_INVALID', 'Install backup checksum is invalid.');
}

async function restoreEntry(paths, entry, roots, applicationPaths) {
  const file = checkedPath(entry.path);
  if ((entry.afterSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.afterSha256 || '')) || (entry.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.beforeSha256 || ''))) throw fail('E_MANIFEST_INVALID', 'Install manifest entry is invalid.');
  const root = matchingRoot(file, roots);
  if (!root) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside managed roots.');
  const applicationPath = isApplicationPath(file, applicationPaths);
  if (!applicationPath) {
    let current;
    try { current = await snapshotPath(file); }
    catch (cause) { if (cause?.code === 'E_MANIFEST_PATH_TYPE') throw uninstallConflict(file); throw cause; }
    if ((current?.sha256 ?? null) !== entry.afterSha256) throw uninstallConflict(file);
  }
  if (!applicationPath && entry.owners?.length && entry.role === 'adapter-config') {
    const current = await snapshotPath(file);
    if (entry.beforeSha256 === null) return;
    if (current && (current.sha256 !== entry.beforeSha256 || current.kind !== entry.beforeKind)) return;
    if (current?.sha256 === entry.beforeSha256 && current.kind === entry.beforeKind && current.mode === entry.beforeMode) return;
  }
  if (entry.beforeSha256 === null) { await ensureSafeParents(file, root); await rm(file, { recursive: applicationPath, force: true }); return; }
  await ensureSafeParents(file, root);
  const bytes = await readBackup(paths, entry.backupPath);
  if (digest(bytes) !== entry.beforeSha256) throw fail('E_MANIFEST_INVALID', 'Install backup checksum is invalid.');
  await rm(file, { recursive: applicationPath, force: true });
  if (entry.beforeKind === 'symlink') await symlink(bytes.toString(), file);
  else if (entry.beforeKind === 'file') { await writeFile(file, bytes, { mode: Number.isInteger(entry.beforeMode) ? entry.beforeMode : 0o600 }); if (Number.isInteger(entry.beforeMode)) await chmod(file, entry.beforeMode); }
  else throw fail('E_MANIFEST_INVALID', 'Install backup type is invalid.');
}

export async function uninstallManagedFiles(paths, { plan = false, home, roots = [home] } = {}) {
  const manifest = await readManifest(paths);
  if (plan) return { action: 'uninstall', files: manifest.files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })), createdDirectories: manifest.createdDirectories };
  if (typeof home !== 'string' || !isAbsolute(home)) throw fail('E_MANIFEST_INVALID', 'Install home is invalid.');
  roots = await Promise.all(roots.map(root => resolveManagedPath(root, { followFinal: true })));
  const applicationPaths = {
    directories: await Promise.all([paths.dataDir, paths.releasesDir, paths.stateDir].map(directory => resolveManagedPath(directory, { followFinal: true }))),
    files: await Promise.all([paths.currentDir, paths.configFile, paths.installManifest, paths.binPath].map(file => resolveManagedPath(file)))
  };
  for (const entry of [...manifest.files].reverse()) {
    if (!matchingRoot(entry.path, roots)) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside managed roots.');
    await preflightEntry(paths, entry, roots, applicationPaths);
  }
  for (const entry of [...manifest.files].reverse()) await restoreEntry(paths, entry, roots, applicationPaths);
  return { action: 'uninstall', restored: manifest.files.length, createdDirectories: manifest.createdDirectories };
}

export async function readInstallManifest(paths) { return readManifest(paths); }
