// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaProvider, KEEP_ALIVE_PATTERN } from '../../modules/semantic/src/provider.mjs';

function recordingFetch() {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) };
  };
  return { bodies, fetchImpl };
}

test('keep_alive is sent for a positive duration', async () => {
  const { bodies, fetchImpl } = recordingFetch();
  const provider = createOllamaProvider({ model: 'm', dims: 2, fetchImpl, keepAlive: '30m' });
  await provider.embed(['alpha']);
  assert.deepEqual(bodies, [{ model: 'm', input: ['alpha'], keep_alive: '30m' }]);
});

test('keep_alive is absent for "0" and for an omitted value', async () => {
  for (const keepAlive of ['0', undefined]) {
    const { bodies, fetchImpl } = recordingFetch();
    const provider = createOllamaProvider({ model: 'm', dims: 2, fetchImpl, ...(keepAlive ? { keepAlive } : {}) });
    await provider.embed(['alpha']);
    assert.deepEqual(bodies, [{ model: 'm', input: ['alpha'] }], String(keepAlive));
  }
});

test('every accepted duration value is sent verbatim', async () => {
  for (const value of ['1s', '30m', '2h', '99999h']) {
    const { bodies, fetchImpl } = recordingFetch();
    await createOllamaProvider({ model: 'm', dims: 2, fetchImpl, keepAlive: value }).embed(['x']);
    assert.equal(bodies[0].keep_alive, value);
  }
  assert.equal(KEEP_ALIVE_PATTERN.test('0'), true);
});

test('malformed keepAlive values throw the existing invalid-configuration error', () => {
  for (const value of ['', 'm', '0m', '01m', '30', '1d', ' 30m', '30m ', '100000h', 30, null, true]) {
    assert.throws(
      () => createOllamaProvider({ model: 'm', dims: 2, fetchImpl: async () => ({}), keepAlive: value }),
      { code: 'E_SEMANTIC_PROVIDER', message: 'Embedding provider configuration is invalid.' },
      String(value)
    );
  }
});

test('the provider fingerprint does not depend on keepAlive', () => {
  const base = { model: 'm', dims: 2, fetchImpl: async () => ({}) };
  const reference = createOllamaProvider(base).fingerprint;
  for (const keepAlive of ['30m', '1h', '0']) {
    assert.equal(createOllamaProvider({ ...base, keepAlive }).fingerprint, reference, keepAlive);
  }
});
