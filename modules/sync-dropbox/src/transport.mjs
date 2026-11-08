// SPDX-License-Identifier: MIT
import { validateTransportPath } from '../../sync-engine/src/transport.mjs';
import { DropboxError } from './errors.mjs';

const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';
const safeJson = async (response) => { try { return await response.json(); } catch { return null; } };
const retryAfter = (response) => {
  const value = response.headers?.get?.('retry-after');
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

function validateRoot(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.includes('\0')
      || value.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))) {
    throw new DropboxError('E_INVALID_PATH');
  }
  return value === '/' ? '' : value.replace(/\/$/, '');
}

function apiError(response, body, { allowMissing = false } = {}) {
  if (response.status === 401) return new DropboxError('E_AUTH');
  if (response.status === 429 || body?.error?.['.tag'] === 'too_many_requests' || body?.error_summary?.startsWith?.('too_many_requests')) {
    return new DropboxError('E_QUOTA', retryAfter(response));
  }
  if (response.status === 409) {
    const tag = body?.error?.['.tag'];
    const pathTag = body?.error?.path?.['.tag'] ?? body?.error?.path_lookup?.['.tag'];
    if (allowMissing && (tag === 'not_found' || pathTag === 'not_found' || body?.error_summary?.startsWith?.('path/not_found'))) return null;
    return new DropboxError('E_CONFLICT');
  }
  return new DropboxError('E_NETWORK');
}

function normalizeListedPath(path, root) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new DropboxError('E_NETWORK');
  const prefix = root ? `${root}/` : '/';
  if (root && path.toLowerCase() === root.toLowerCase()) return '';
  if (root && !path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const relative = root ? path.slice(root.length + 1) : path.slice(1);
  if (!relative) return null;
  try { validateTransportPath(relative); } catch { return null; }
  return relative;
}

/** Build a Dropbox API v2 object transport. The injected fetch is used for every request. */
export function createDropboxTransport({ fetch: fetchImpl = globalThis.fetch, getAccessToken, root = '/BrainAtlas', apiBase = API_BASE, contentBase = CONTENT_BASE, hostId } = {}) {
  if (typeof fetchImpl !== 'function' || typeof getAccessToken !== 'function') throw new DropboxError('E_AUTH');
  const normalizedRoot = validateRoot(root);
  const api = String(apiBase).replace(/\/$/, '');
  const content = String(contentBase).replace(/\/$/, '');
  const remotePath = (relativePath = '') => {
    if (relativePath !== '') validateTransportPath(relativePath);
    return `${normalizedRoot}${relativePath ? `/${relativePath}` : ''}` || '/';
  };

  async function send(url, token, { args, bytes, contentType = false } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    let body;
    if (contentType) {
      headers['content-type'] = 'application/octet-stream';
      headers['Dropbox-API-Arg'] = JSON.stringify(args);
      body = bytes;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(args ?? {});
    }
    try { return await fetchImpl(url, { method: 'POST', headers, body }); }
    catch { throw new DropboxError('E_NETWORK'); }
  }

  async function ensureParentFolders(relativePath, token) {
    const segments = relativePath.split('/');
    const folders = [];
    let path = normalizedRoot;
    if (path) folders.push(path);
    for (const part of segments.slice(0, -1)) {
      path = `${path}/${part}`;
      folders.push(path);
    }
    for (const folder of folders) {
      const response = await send(`${api}/files/create_folder_v2`, token, { args: { path: folder, autorename: false } });
      if (response.ok) continue;
      const body = await safeJson(response);
      const error = apiError(response, body);
      if (error?.code === 'E_CONFLICT') continue;
      throw error ?? new DropboxError('E_NETWORK');
    }
  }

  return Object.freeze({
    ...(typeof hostId === 'string' ? { hostId } : {}),
    capabilities: Object.freeze({ cas: true, mode: 'object' }),
    async list(prefix = '') {
      if (prefix) validateTransportPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
      const token = await getAccessToken();
      const found = [];
      let response = await send(`${api}/files/list_folder`, token, { args: { path: normalizedRoot || '', recursive: true, include_deleted: false } });
      let body = await safeJson(response);
      if (!response.ok) {
        const error = apiError(response, body, { allowMissing: true });
        if (error === null) return [];
        throw error;
      }
      const cursors = new Set();
      while (true) {
        if (!Array.isArray(body?.entries)) throw new DropboxError('E_NETWORK');
        for (const entry of body.entries) {
          if (entry?.['.tag'] !== 'file' || typeof entry.rev !== 'string' || !Number.isSafeInteger(entry.size)) continue;
          const path = normalizeListedPath(entry.path_display ?? entry.path_lower, normalizedRoot);
          if (path !== null && path.startsWith(prefix)) found.push({ path, rev: entry.rev, size: entry.size });
        }
        if (body.has_more !== true) break;
        if (typeof body.cursor !== 'string' || !body.cursor || cursors.has(body.cursor)) throw new DropboxError('E_NETWORK');
        cursors.add(body.cursor);
        response = await send(`${api}/files/list_folder/continue`, token, { args: { cursor: body.cursor } });
        body = await safeJson(response);
        if (!response.ok) throw apiError(response, body);
      }
      return found.sort((left, right) => left.path.localeCompare(right.path));
    },
    async get(path) {
      validateTransportPath(path);
      const token = await getAccessToken();
      const response = await send(`${content}/files/download`, token, { args: { path: remotePath(path) }, contentType: true });
      if (!response.ok) {
        const body = await safeJson(response);
        const error = apiError(response, body, { allowMissing: true });
        if (error === null) return null;
        throw error;
      }
      let metadata;
      try { metadata = JSON.parse(response.headers.get('Dropbox-API-Result') ?? 'null'); } catch { throw new DropboxError('E_NETWORK'); }
      if (typeof metadata?.rev !== 'string') throw new DropboxError('E_NETWORK');
      try { return { bytes: new Uint8Array(await response.arrayBuffer()), rev: metadata.rev }; }
      catch { throw new DropboxError('E_NETWORK'); }
    },
    async put(path, bytes, options = {}) {
      validateTransportPath(path);
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Dropbox object bytes must be a Uint8Array.');
      if (options.ifRev !== undefined && (typeof options.ifRev !== 'string' || !options.ifRev)) throw new DropboxError('E_CONFLICT');
      if (options.ifAbsent === true && options.ifRev !== undefined) throw new DropboxError('E_CONFLICT');
      const token = await getAccessToken();
      await ensureParentFolders(path, token);
      const mode = options.ifRev !== undefined ? { '.tag': 'update', update: options.ifRev } : { '.tag': 'add' };
      const response = await send(`${content}/files/upload`, token, {
        args: { path: remotePath(path), mode, autorename: false }, bytes, contentType: true,
      });
      const body = await safeJson(response);
      if (!response.ok) throw apiError(response, body);
      if (typeof body?.rev !== 'string') throw new DropboxError('E_NETWORK');
      return { rev: body.rev };
    },
    async delete(path, options = {}) {
      validateTransportPath(path);
      if (typeof options.ifRev !== 'string' || !options.ifRev) throw new DropboxError('E_CONFLICT');
      const token = await getAccessToken();
      const response = await send(`${api}/files/delete_v2`, token, { args: { path: remotePath(path), parent_rev: options.ifRev } });
      const body = await safeJson(response);
      if (!response.ok) throw apiError(response, body);
    },
  });
}
