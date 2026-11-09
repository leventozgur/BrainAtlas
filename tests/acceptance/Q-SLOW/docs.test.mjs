// SPDX-License-Identifier: MIT
// Docs accompanying Q-SLOW: sections exist, command names are real, no personal paths or localhost URLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { commands } from '../../../modules/semantic/src/index.mjs';

const read = relative => readFile(new URL(`../../../${relative}`, import.meta.url), 'utf8');

function section(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /u);
  return next === -1 ? rest : rest.slice(0, next);
}

test('semantic.md has a slow-machines section with the measured example, resume, both settings and partialChunks', async () => {
  const body = section(await read('docs/user/semantic.md'), '## Slow machines');
  for (const needle of ['819', '2012', '8 GB', 'indexTimeoutMs', 'indexBatchSize', 'partialChunks', 'semanticSetup', 'idle', 'timeoutMs']) assert.ok(body.includes(needle), `semantic.md slow section lacks ${needle}`);
  assert.match(body, /16 minutes|16 min/u);
  assert.match(body, /0\.5 second/u);
  assert.match(body, /120000/u);
  assert.match(body, /1.64/u);
});

test('troubleshooting.md covers long indexing, interrupted indexing and a concurrent indexing lock', async () => {
  const body = await read('docs/user/troubleshooting.md');
  assert.match(body, /takes a long time/iu);
  assert.match(body, /stopped partway|interrupted/iu);
  assert.match(body, /Another indexing operation/iu);
});

test('config contract documents indexTimeoutMs (>= 1, default 120000) and indexBatchSize (1-64, default 32)', async () => {
  const body = await read('docs/contracts/config.md');
  assert.match(body, /indexTimeoutMs/u);
  assert.match(body, /indexBatchSize/u);
  assert.match(body, /120000/u);
  assert.match(body, /1 to 64/u);
});

test('documented brainatlas commands in the new sections exist, and no personal paths, e-mail addresses or localhost URLs appear', async () => {
  const files = ['docs/user/semantic.md', 'docs/user/troubleshooting.md'];
  const real = new Set(Object.keys(commands));
  for (const file of files) {
    const text = await read(file);
    for (const match of text.matchAll(/brainatlas (semantic[A-Za-z]+)/gu)) assert.ok(real.has(match[1]), `${file}: unknown command ${match[1]}`);
  }
  const added = [section(await read('docs/user/semantic.md'), '## Slow machines'), section(await read('docs/user/troubleshooting.md'), '## Slow or interrupted semantic indexing')].join('\n');
  assert.doesNotMatch(added, /\/Users\/|\/home\/[a-z]|[\w.-]+@[\w-]+\.\w+|localhost/iu);
});
