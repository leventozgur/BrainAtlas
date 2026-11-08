// SPDX-License-Identifier: MIT
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

function safeError(message) {
  const error = new Error(message);
  error.code = 'E_SEMANTIC_PROVIDER';
  return error;
}

function validateBaseUrl(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw safeError('Embedding provider URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw safeError('Embedding provider URL is invalid.');
  }
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
} = {}) {
  if (typeof model !== 'string' || !model.trim() || !Number.isInteger(dims) || dims < 1) {
    throw safeError('Embedding provider configuration is invalid.');
  }
  if (typeof fetchImpl !== 'function') throw safeError('Embedding provider fetch is unavailable.');
  const endpoint = `${validateBaseUrl(baseUrl)}/api/embed`;
  let isHealthy = true;

  return Object.freeze({
    id: `ollama:${model}`,
    dims,
    healthy: async () => isHealthy,
    async embed(texts) {
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) {
        throw safeError('Embedding input must be an array of text.');
      }
      if (texts.length === 0) return [];
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
        });
        if (!response?.ok) throw safeError('Embedding provider request failed.');
        const payload = await response.json();
        const vectors = payload?.embeddings;
        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
          throw safeError('Embedding provider returned an invalid response.');
        }
        const output = vectors.map((vector) => validateVector(vector, dims));
        isHealthy = true;
        return output;
      } catch (error) {
        isHealthy = false;
        if (error?.code === 'E_SEMANTIC_PROVIDER') throw error;
        throw safeError('Embedding provider request failed.');
      }
    },
  });
}

export { DEFAULT_BASE_URL };
