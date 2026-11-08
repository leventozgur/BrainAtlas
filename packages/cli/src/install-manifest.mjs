// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile, chmod, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = paths => paths.installManifest;
const within = (file, root) => { const rel = relative(resolve(root), resolve(file)); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const matchingRoot = (file, roots) => [...roots].map(root => resolve(root)).filter(root => within(file, root)).sort((a, b) => b.length - a.length)[0];

function checkedPath(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || normalize(file) !== file || file.split(/[\\/]/).includes('..')) throw fail('E_MANIFEST_INVALID', 'Install manifest path is invalid.');
  return file;
}

/** Return a stable snapshot without following the final symlink. */
export async function snapshotPath(file) {
  checkedPath(file);
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

/** Preserve the original state for uninstall and record the new managed state. */
export async function recordManagedPath(paths, file, before, after = undefined) {
  checkedPath(file);
  const manifest = await readManifest(paths);
  const index = manifest.files.findIndex(item => item.path === file);
  const prior = index >= 0 ? manifest.files[index] : null;
  let backupPath = prior?.backupPath || null;
  if (!prior && before) {
    const backupDir = join(paths.dataDir, 'install-backups');
    const rel = relative(paths.dataDir, backupDir);
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
  await recordManagedPath(paths, file, before, after);
}

export async function missingDirectories(directory, home, roots = [home]) {
  const target = resolve(directory);
  if (!matchingRoot(target, roots)) throw fail('E_MANIFEST_INVALID', 'Install directory is outside managed roots.');
  const missing = []; let current = target;
  while (true) {
    try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('E_MANIFEST_INVALID', 'Install directory path is unsafe.'); break; }
    catch (cause) { if (cause?.code !== 'ENOENT') throw cause; missing.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  }
  return missing;
}

export async function recordCreatedDirectories(paths, directories = [], home, roots = [home]) {
  const manifest = await readManifest(paths); const known = new Set(manifest.createdDirectories);
  for (const directory of directories) {
    const checked = checkedPath(directory);
    if ((!matchingRoot(checked, roots) && !roots.some(root => within(root, checked))) || resolve(checked) === resolve(home)) throw fail('E_MANIFEST_INVALID', 'Install directory is outside managed roots.');
    known.add(checked);
  }
  manifest.createdDirectories = [...known].sort((a, b) => b.split(sep).length - a.split(sep).length || a.localeCompare(b));
  await writeManifest(paths, manifest);
}

export async function removeCreatedDirectories(directories, home, roots = [home]) {
  for (const directory of [...directories].sort((a, b) => b.split(sep).length - a.split(sep).length)) {
    const checked = checkedPath(directory);
    if ((!matchingRoot(checked, roots) && !roots.some(root => within(root, checked))) || resolve(checked) === resolve(home)) throw fail('E_MANIFEST_INVALID', 'Install directory is outside managed roots.');
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
  const rel = relative(backupRoot, backup);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fail('E_MANIFEST_INVALID', 'Install backup path is invalid.');
  await checkSafeParents(backup, paths.dataDir);
  try { const stat = await lstat(backup); if (!stat.isFile() || stat.isSymbolicLink()) throw fail('E_MANIFEST_INVALID', 'Install backup is unsafe.'); }
  catch (cause) { if (cause?.code === 'ENOENT') throw fail('E_MANIFEST_INVALID', 'Install backup is missing.'); throw cause; }
  return readFile(backup);
}

async function preflightEntry(paths, entry, roots) {
  const file = checkedPath(entry.path);
  if ((entry.afterSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.afterSha256 || '')) || (entry.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.beforeSha256 || ''))) throw fail('E_MANIFEST_INVALID', 'Install manifest entry is invalid.');
  const root = matchingRoot(file, roots);
  if (!root) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside managed roots.');
  await checkSafeParents(file, root);
  const current = await snapshotPath(file);
  if ((current?.sha256 ?? null) !== entry.afterSha256 || (current?.kind ?? null) !== (entry.afterKind ?? null) || (current?.mode ?? null) !== (entry.afterMode ?? null)) throw fail('E_UNINSTALL_CONFLICT', 'A managed file changed after installation.');
  if (entry.beforeSha256 === null) {
    if (entry.backupPath !== null || (entry.beforeKind !== null && entry.beforeKind !== undefined)) throw fail('E_MANIFEST_INVALID', 'Install manifest entry is invalid.');
    return;
  }
  if (!['file', 'symlink'].includes(entry.beforeKind)) throw fail('E_MANIFEST_INVALID', 'Install backup type is invalid.');
  const bytes = await readBackup(paths, entry.backupPath);
  if (digest(bytes) !== entry.beforeSha256) throw fail('E_MANIFEST_INVALID', 'Install backup checksum is invalid.');
}

async function restoreEntry(paths, entry, roots) {
  const file = checkedPath(entry.path);
  if ((entry.afterSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.afterSha256 || '')) || (entry.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.beforeSha256 || ''))) throw fail('E_MANIFEST_INVALID', 'Install manifest entry is invalid.');
  const current = await snapshotPath(file);
  if ((current?.sha256 ?? null) !== entry.afterSha256) throw fail('E_UNINSTALL_CONFLICT', 'A managed file changed after installation.');
  const root = matchingRoot(file, roots);
  if (!root) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside managed roots.');
  if (entry.beforeSha256 === null) { if (current) { await ensureSafeParents(file, root); await rm(file, { force: true }); } return; }
  await ensureSafeParents(file, root);
  const bytes = await readBackup(paths, entry.backupPath);
  if (digest(bytes) !== entry.beforeSha256) throw fail('E_MANIFEST_INVALID', 'Install backup checksum is invalid.');
  await rm(file, { force: true });
  if (entry.beforeKind === 'symlink') await symlink(bytes.toString(), file);
  else if (entry.beforeKind === 'file') { await writeFile(file, bytes, { mode: Number.isInteger(entry.beforeMode) ? entry.beforeMode : 0o600 }); if (Number.isInteger(entry.beforeMode)) await chmod(file, entry.beforeMode); }
  else throw fail('E_MANIFEST_INVALID', 'Install backup type is invalid.');
}

export async function uninstallManagedFiles(paths, { plan = false, home, roots = [home] } = {}) {
  const manifest = await readManifest(paths);
  if (plan) return { action: 'uninstall', files: manifest.files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })), createdDirectories: manifest.createdDirectories };
  if (typeof home !== 'string' || !isAbsolute(home)) throw fail('E_MANIFEST_INVALID', 'Install home is invalid.');
  for (const entry of [...manifest.files].reverse()) {
    if (!matchingRoot(entry.path, roots)) throw fail('E_MANIFEST_INVALID', 'Install manifest path is outside managed roots.');
    await preflightEntry(paths, entry, roots);
  }
  for (const entry of [...manifest.files].reverse()) await restoreEntry(paths, entry, roots);
  return { action: 'uninstall', restored: manifest.files.length, createdDirectories: manifest.createdDirectories };
}

export async function readInstallManifest(paths) { return readManifest(paths); }
