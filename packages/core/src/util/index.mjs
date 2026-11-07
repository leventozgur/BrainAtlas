// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { NotImplementedError, BrainAtlasError } from './errors.mjs';
export { NotImplementedError, BrainAtlasError };
/** @param {string} file @param {string|Uint8Array} data @param {{mode?:number}} options */
export async function atomicWriteFile(file, data, options = {}) { throw new NotImplementedError('util.atomicWriteFile'); }
/** @param {string} root @param {string} rel */
export function safeJoin(root, rel) { throw new NotImplementedError('util.safeJoin'); }
/** @param {string} cmd @param {string[]} args @param {{cwd?:string,env?:Record<string,string|undefined>,timeoutMs?:number,input?:string|Uint8Array}} options @returns {Promise<{code:number,stdout:string,stderr:string}>} */
export async function runCommand(cmd, args, options) {
  // Preserve the unimplemented contract for an invalid, argument-free call.
  if (cmd === undefined && args === undefined && options === undefined) throw new NotImplementedError('util.runCommand');
  if (typeof cmd !== 'string' || !cmd || !Array.isArray(args) || !args.every(arg => typeof arg === 'string') || !options || typeof options !== 'object') {
    throw new BrainAtlasError('E_ARGUMENT', 'Command arguments are invalid.');
  }
  const env = options.env;
  const offline = process.env.BRAINATLAS_OFFLINE === '1' || env?.BRAINATLAS_OFFLINE === '1';
  const commandName = cmd.split(/[\\/]/).at(-1);
  const gitRemoteCommand = commandName === 'git' && args.some(arg => ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(arg));
  const remoteUrl = value => /^(?:https?|ssh|git):\/\//i.test(value) || /^[^/@:\s]+@[^/:\s]+:.+/.test(value);
  const subcommandIndex = gitRemoteCommand ? args.findIndex(arg => ['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(arg)) : -1;
  const hasRemote = subcommandIndex >= 0 && args.slice(subcommandIndex + 1).some(remoteUrl);
  if (offline && (commandName === 'curl' || commandName === 'wget' || hasRemote)) {
    throw new BrainAtlasError('E_OFFLINE', 'Network commands are disabled while offline.');
  }
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new BrainAtlasError('E_ARGUMENT', 'Command timeout is invalid.');
  return await new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let settled = false; let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: options.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (cause) { reject(cause); return; }
    const finish = (fn, value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(value); };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 250);
      killTimer.unref?.();
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => finish(reject, error));
    child.on('close', code => finish(resolve, { code: timedOut ? 124 : (code ?? 1), stdout, stderr }));
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

