// SPDX-License-Identifier: MIT
import { dirname, resolve } from 'node:path';
import { lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { extractVerifiedRelease } from '../packages/cli/src/archive.mjs';

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
try {
  if (args.includes('--switch-link')) {
    const link = value('--link'); const target = value('--target');
    if (!link || !/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target || '')) throw Object.assign(new Error(), { code: 'E_ARGUMENT' });
    const destination = resolve(link); const temp = `${destination}.next-${process.pid}`;
    try { const stat = await lstat(destination); if (!stat.isSymbolicLink()) throw Object.assign(new Error('Current release path is not a link.'), { code: 'E_PATH_CONFLICT' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(temp, { force: true }); await symlink(target, temp);
    try { await rename(temp, destination); } catch { await rm(temp, { force: true }); throw Object.assign(new Error('Could not switch current release.'), { code: 'E_CURRENT_SWITCH' }); }
    process.exit(0);
  }
  if (args.includes('--write-shim')) {
    const file = value('--file'); const node = value('--node'); const cli = value('--cli');
    if (!file || !node || !cli) throw Object.assign(new Error(), { code: 'E_ARGUMENT' });
    const quote = item => `'${item.replace(/'/g, `'\\''`)}'`;
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(resolve(file), `#!/bin/sh\nexec ${quote(resolve(node))} ${quote(resolve(cli))} "$@"\n`, { mode: 0o755 });
    process.exit(0);
  }
  const archive = value('--archive'); const destination = value('--destination'); const signers = value('--allowed-signers');
  if (!archive || !destination || !signers) throw Object.assign(new Error(), { code: 'E_ARGUMENT' });
  const manifest = await extractVerifiedRelease(resolve(archive), resolve(destination), resolve(signers));
  process.stdout.write(`${manifest.version} ${manifest.profile}\n`);
} catch (error) {
  const safeCodes = new Set(['E_ARGUMENT', 'E_ARCHIVE_READ', 'E_SHA_MISMATCH', 'E_SIGNATURE_INVALID', 'E_MANIFEST_INVALID', 'E_PROFILE_MISMATCH', 'E_PATH_CONFLICT', 'E_CURRENT_SWITCH']);
  const code = safeCodes.has(error?.code) ? error.code : 'E_INSTALL';
  const message = safeCodes.has(error?.code) ? error.message : 'Install helper could not complete the requested operation.';
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
}
