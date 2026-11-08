// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DropboxError } from './errors.mjs';

const HELPER_PATH = fileURLToPath(new URL('./mac-keychain-helper.swift', import.meta.url));

function commandFailure(exitCode) {
  const error = new DropboxError('E_CREDENTIAL_STORE');
  error.exitCode = exitCode;
  return error;
}

/** Run a credential helper with any secret delivered on stdin, never in argv. */
export function runCredentialCommand(command, args, { input = '' } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch { reject(commandFailure(null)); return; }
    const stdout = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > 1024 * 1024) { child.kill(); reject(commandFailure(null)); return; }
      stdout.push(Buffer.from(chunk));
    });
    child.once('error', () => reject(commandFailure(null)));
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(commandFailure(code));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function validateSecret(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new DropboxError('E_CREDENTIAL_STORE');
  return value;
}

/** Create an OS-backed secret store. Tests may inject runCommand to avoid subprocesses. */
export function createCredentialStore({ platform = process.platform, runCommand = runCredentialCommand, secretTool = 'secret-tool', swift = 'swift', service = 'brainatlas-dropbox', account = 'default', helperPath = HELPER_PATH } = {}) {
  if (typeof runCommand !== 'function') throw new DropboxError('E_CREDENTIAL_STORE');
  const invoke = async (command, args, input) => {
    try { return await runCommand(command, args, { input }); }
    catch (error) { throw error?.code === 'E_CREDENTIAL_STORE' ? error : new DropboxError('E_CREDENTIAL_STORE'); }
  };

  if (platform === 'linux') {
    const args = ['service', service, 'account', account];
    return Object.freeze({
      async get() {
        try { const value = await invoke(secretTool, ['lookup', ...args]); return value.replace(/\r?\n$/, '') || null; }
        catch (error) { if (error?.exitCode === 1) return null; throw error; }
      },
      async set(value) { await invoke(secretTool, ['store', '--label=BrainAtlas Dropbox', ...args], `${validateSecret(value)}\n`); },
      async delete() {
        try { await invoke(secretTool, ['clear', ...args]); }
        catch (error) { if (error?.exitCode !== 1) throw error; }
      },
    });
  }

  if (platform === 'darwin') {
    const invokeHelper = (action, input) => invoke(swift, [helperPath, action, service, account], input ?? '');
    return Object.freeze({
      async get() {
        try { const value = await invokeHelper('get'); return value.replace(/\r?\n$/, '') || null; }
        catch (error) { if (error?.exitCode === 3) return null; throw error; }
      },
      async set(value) { await invokeHelper('set', validateSecret(value)); },
      async delete() {
        try { await invokeHelper('delete'); }
        catch (error) { if (error?.exitCode !== 3) throw error; }
      },
    });
  }
  throw new DropboxError('E_CREDENTIAL_STORE');
}

export const createSecretToolStore = (options = {}) => createCredentialStore({ ...options, platform: 'linux' });
export const createMacKeychainStore = (options = {}) => createCredentialStore({ ...options, platform: 'darwin' });
