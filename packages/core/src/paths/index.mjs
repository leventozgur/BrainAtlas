// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainAtlasError } from '../util/errors.mjs';

/** @typedef {{dataDir:string,configFile:string,stateDir:string,installManifest:string,releasesDir:string,currentDir:string,binPath:string}} ResolvedPaths */
export function resolvePaths(options = {}) {
  const { platform = process.platform, env = {} } = options;
  if (!env.HOME) throw new BrainAtlasError('E_NO_HOME', 'HOME must be provided to resolve BrainAtlas paths.');
  if (!['darwin', 'linux'].includes(platform))
    throw new BrainAtlasError('E_PLATFORM', 'Unsupported platform for path resolution.');
  const path = posix;
  const home = env.HOME;
  if (platform === 'darwin') {
    const dataDir = join(home, 'Library', 'Application Support', 'BrainAtlas');
    return {
      dataDir,
      releasesDir: join(dataDir, 'releases'),
      currentDir: join(dataDir, 'current'),
      binPath: join(dataDir, 'bin', 'brainatlas'),
      configFile: join(dataDir, 'config.json'),
      stateDir: join(dataDir, 'state'),
      installManifest: join(dataDir, 'install-manifest.json'),
    };
  }
  const dataDir = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'brainatlas');
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return {
    dataDir,
    releasesDir: path.join(dataDir, 'releases'),
    currentDir: path.join(dataDir, 'current'),
    binPath: path.join(dataDir, 'bin', 'brainatlas'),
    configFile: path.join(configHome, 'brainatlas', 'config.json'),
    stateDir: path.join(stateHome, 'brainatlas'),
    installManifest: path.join(dataDir, 'install-manifest.json'),
  };
}

export function vaultId(absPath) {
  if (typeof absPath !== 'string' || !absPath || !absPath.startsWith('/'))
    throw new BrainAtlasError('E_VAULT_PATH', 'Vault path must be absolute.');
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

export function absoluteVaultPath(vaultPath, home = process.env.HOME) {
  return resolve(isAbsolute(vaultPath) ? vaultPath : resolve(home ?? process.cwd(), vaultPath));
}

export function vaultStateDir(paths, vaultPath) {
  if (typeof vaultPath !== 'string' || !isAbsolute(vaultPath))
    throw new BrainAtlasError('E_PATHS', 'Vault path must be absolute.');
  return join(paths.stateDir, vaultId(resolve(vaultPath)));
}

export function packageRootFromUrl(fileUrl) {
  const bad = (why) => new BrainAtlasError('E_PACKAGE_ROOT', `Cannot determine the package root: ${why}.`);
  let path;
  try {
    if (typeof fileUrl !== 'string' && !(fileUrl instanceof URL)) throw bad('input must be a file URL');
    path = fileURLToPath(fileUrl);
  } catch (error) {
    throw error?.code === 'E_PACKAGE_ROOT' ? error : bad('input must be a file URL');
  }
  const segs = path.split(sep === '/' ? '/' : /[\\/]/);
  let cut = -1;
  for (let i = 0; i < segs.length; i += 1) {
    const installed = segs[i] === 'node_modules' && segs[i + 1] === '@brainatlas' && segs[i + 2] && i + 3 < segs.length;
    const workspace = segs[i] === 'packages' && segs[i + 1] && i + 2 < segs.length;
    if (installed || workspace) cut = i;
  }
  if (cut < 0) throw bad('no package directory in the path');
  return segs.slice(0, cut).join(sep) || sep;
}
