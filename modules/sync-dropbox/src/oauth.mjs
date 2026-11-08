// SPDX-License-Identifier: MIT
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DropboxError } from './errors.mjs';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

function validAppKey(appKey) {
  if (typeof appKey !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(appKey)) throw new DropboxError('E_ARGUMENT');
  return appKey;
}

async function parseTokenResponse(response) {
  if (!response?.ok) {
    if (response?.status === 429) throw new DropboxError('E_QUOTA');
    if (response?.status === 401 || response?.status === 400) throw new DropboxError('E_AUTH');
    throw new DropboxError('E_NETWORK');
  }
  let body;
  try { body = await response.json(); } catch { throw new DropboxError('E_AUTH'); }
  if (typeof body?.access_token !== 'string' || !body.access_token) throw new DropboxError('E_AUTH');
  return body;
}

async function postToken(fetchImpl, form) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch { throw new DropboxError('E_NETWORK'); }
  return parseTokenResponse(response);
}

async function readCode(input) {
  if (typeof input === 'string') return input.split(/\r?\n/, 1)[0].trim();
  if (!input || typeof input.on !== 'function') throw new DropboxError('E_ARGUMENT');
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) {
      const code = line.trim();
      if (!code || code.length > 4096) throw new DropboxError('E_ARGUMENT');
      return code;
    }
  } catch (error) { if (error?.code === 'E_ARGUMENT') throw error; throw new DropboxError('E_ARGUMENT'); }
  finally { lines.close(); }
  throw new DropboxError('E_ARGUMENT');
}

function credentialsJson(value) {
  try {
    const credentials = JSON.parse(value);
    if (typeof credentials?.accessToken !== 'string' || typeof credentials?.refreshToken !== 'string'
        || typeof credentials?.appKey !== 'string' || !Number.isFinite(credentials.expiresAt)) throw new Error();
    return credentials;
  } catch { throw new DropboxError('E_AUTH'); }
}

/** Print the PKCE authorization URL, read a code from stdin, exchange it, and persist tokens. */
export async function enrollDropbox({ appKey, fetch: fetchImpl = globalThis.fetch, credentialStore, stdin = process.stdin, stdout = process.stdout, now = () => Date.now(), random = randomBytes } = {}) {
  validAppKey(appKey);
  if (typeof fetchImpl !== 'function' || !credentialStore || typeof credentialStore.set !== 'function') throw new DropboxError('E_ARGUMENT');
  const verifier = random(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', appKey);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('token_access_type', 'offline');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  if (typeof stdout === 'function') stdout(`Open this authorization URL and paste the code:\n${authorize.href}\n`);
  else stdout?.write?.(`Open this authorization URL and paste the code:\n${authorize.href}\n`);
  const code = await readCode(stdin);
  if (!code || code.length > 4096) throw new DropboxError('E_ARGUMENT');
  const token = await postToken(fetchImpl, {
    code,
    grant_type: 'authorization_code',
    client_id: appKey,
    code_verifier: verifier,
  });
  if (typeof token.refresh_token !== 'string' || !token.refresh_token) throw new DropboxError('E_AUTH');
  const expiresIn = Number(token.expires_in);
  const credentials = {
    version: 1,
    appKey,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0) * 1000,
  };
  try { await credentialStore.set(JSON.stringify(credentials)); }
  catch { throw new DropboxError('E_CREDENTIAL_STORE'); }
  return { status: 'ENROLLED' };
}

/** Return a refresh-aware access token callback for Dropbox API requests. */
export function createDropboxTokenProvider({ credentialStore, fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (!credentialStore || typeof credentialStore.get !== 'function' || typeof credentialStore.set !== 'function' || typeof fetchImpl !== 'function') {
    throw new DropboxError('E_CREDENTIAL_STORE');
  }
  let current = null;
  let refreshInFlight = null;

  async function load() {
    let stored;
    try { stored = await credentialStore.get(); } catch { throw new DropboxError('E_CREDENTIAL_STORE'); }
    if (typeof stored !== 'string' || !stored) throw new DropboxError('E_AUTH');
    current = credentialsJson(stored);
    return current;
  }

  async function refresh(credentials) {
    const token = await postToken(fetchImpl, {
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.appKey,
    });
    const expiresIn = Number(token.expires_in);
    current = {
      version: 1,
      appKey: credentials.appKey,
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : credentials.refreshToken,
      expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0) * 1000,
    };
    try { await credentialStore.set(JSON.stringify(current)); }
    catch { throw new DropboxError('E_CREDENTIAL_STORE'); }
    return current;
  }

  return async function getAccessToken() {
    const credentials = current ?? await load();
    if (credentials.expiresAt > now() + 60_000) return credentials.accessToken;
    if (!refreshInFlight) refreshInFlight = refresh(credentials).finally(() => { refreshInFlight = null; });
    return (await refreshInFlight).accessToken;
  };
}

export { AUTHORIZE_URL, TOKEN_URL };
