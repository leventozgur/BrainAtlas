// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

export const PREPROCESS_VERSION = '1';
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

function safeError(message) {
  const error = new Error(message);
  error.code = 'E_SEMANTIC_PROVIDER';
  return error;
}

function validateBaseUrl(baseUrl, allowRemote) {
  let url;
  try { url = new URL(baseUrl); } catch { throw safeError('Embedding provider URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw safeError('Embedding provider URL is invalid.');
  }
  if (!allowRemote && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw safeError('Embedding provider configuration is invalid.');
  return `${url.origin}${url.pathname.replace(/\/$/u, '')}`;
}

function validateVector(value, dims) {
  if (!Array.isArray(value) || value.length !== dims || !value.every(Number.isFinite)) {
    throw safeError('Embedding provider returned an invalid vector.');
  }
  return Float32Array.from(value);
}

/** Create an Ollama provider using only the supplied fetch implementation. */
export function createOllamaProvider({
  baseUrl = DEFAULT_BASE_URL,
  model,
  dims = 768,
  fetchImpl = globalThis.fetch,
  queryPrefix = '', documentPrefix = '', batchSize = 32, timeoutMs = 60000, allowRemote = false,
} = {}) {
  if (typeof model !== 'string' || !model.trim() || !Number.isInteger(dims) || dims < 1) {
    throw safeError('Embedding provider configuration is invalid.');
  }
  if (typeof queryPrefix !== 'string' || typeof documentPrefix !== 'string' || !Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw safeError('Embedding provider configuration is invalid.');
  if (typeof fetchImpl !== 'function') throw safeError('Embedding provider fetch is unavailable.');
  const endpoint = `${validateBaseUrl(baseUrl, allowRemote)}/api/embed`;
  let isHealthy = true;

  return Object.freeze({
    id: `ollama:${model}`,
    dims,
    preprocessVersion: PREPROCESS_VERSION,
    fingerprint: createHash('sha256').update([model, dims, queryPrefix, documentPrefix, PREPROCESS_VERSION].join('|')).digest('hex').slice(0, 16),
    healthy: async () => isHealthy,
    async embed(texts) {
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) {
        throw safeError('Embedding input must be an array of text.');
      }
      if (texts.length === 0) return [];
      try {
        const output = [];
        for (let start = 0; start < texts.length; start += batchSize) {
          const batch = texts.slice(start, start + batchSize);
          const controller = new AbortController();
          let timer;
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(safeError('Embedding provider timed out.')); }, timeoutMs); });
          try {
            const response = await Promise.race([fetchImpl(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model, input: batch }),
              signal: controller.signal,
            }), timeout]);
            if (!response?.ok) throw safeError(response?.status === 404 ? 'Embedding model unavailable.' : 'Embedding provider request failed.');
            const payload = await Promise.race([response.json(), timeout]);
            const vectors = payload?.embeddings;
            if (!Array.isArray(vectors) || vectors.length !== batch.length) {
              throw safeError('Embedding provider returned an invalid response.');
            }
            output.push(...vectors.map((vector) => validateVector(vector, dims)));
          } finally { clearTimeout(timer); }
        }
        isHealthy = true;
        return output;
      } catch (error) {
        isHealthy = false;
        if (error?.code === 'E_SEMANTIC_PROVIDER') throw error;
        throw safeError('Embedding provider request failed.');
      }
    },
    async embedQuery(text) {
      if (typeof text !== 'string') throw safeError('Embedding input must be text.');
      return (await this.embed([queryPrefix + text]))[0];
    },
    async embedDocuments(texts) {
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) throw safeError('Embedding input must be an array of text.');
      return this.embed(texts.map((text) => documentPrefix + text));
    },
  });
}

export { DEFAULT_BASE_URL };
