// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { BrainAtlasError } from '../util/errors.mjs';

/** @typedef {{dataDir:string,configFile:string,stateDir:string,installManifest:string,releasesDir:string,currentDir:string,binPath:string}} ResolvedPaths */
/** @param {{platform?:string,env:Record<string,string|undefined>}} options @returns {ResolvedPaths} */
export function resolvePaths(options = {}) {
  const { platform = process.platform, env = {} } = options;
  if (!env.HOME) throw new BrainAtlasError('E_NO_HOME', 'HOME must be provided to resolve BrainAtlas paths.');
  if (!['darwin','linux'].includes(platform)) throw new BrainAtlasError('E_PLATFORM', 'Unsupported platform for path resolution.');
  const path = posix;
  const home = env.HOME;
  if (platform === 'darwin') {
    const dataDir = join(home, 'Library', 'Application Support', 'BrainAtlas');
    return { dataDir, releasesDir: join(dataDir, 'releases'), currentDir: join(dataDir, 'current'), binPath: join(dataDir, 'bin', 'brainatlas'), configFile: join(dataDir, 'config.json'), stateDir: join(dataDir, 'state'), installManifest: join(dataDir, 'install-manifest.json') };
  }
  const dataDir = env.XDG_DATA_HOME || path.join(home, '.local', 'share', 'brainatlas');
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return { dataDir, releasesDir: path.join(dataDir, 'releases'), currentDir: path.join(dataDir, 'current'), binPath: path.join(dataDir, 'bin', 'brainatlas'), configFile: path.join(configHome, 'brainatlas', 'config.json'), stateDir: path.join(stateHome, 'brainatlas'), installManifest: path.join(dataDir, 'install-manifest.json') };
}

/** @param {string} absPath @returns {string} */
export function vaultId(absPath) {
  if (typeof absPath !== 'string' || !absPath || !absPath.startsWith('/') ) throw new BrainAtlasError('E_VAULT_PATH', 'Vault path must be absolute.');
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}
