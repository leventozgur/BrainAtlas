// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSemanticEval } from '../../eval/semantic-eval.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'semantic-eval-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const corpusDir = path.join(root, 'corpus'); mkdirSync(corpusDir);
  writeFileSync(path.join(corpusDir, 'a.md'), '# A\ncar transport');
  writeFileSync(path.join(corpusDir, 'b.md'), '# B\nbook reading');
  const casesFile = path.join(root, 'cases.json');
  writeFileSync(casesFile, JSON.stringify([{ query: 'araba', relevant: ['a.md'], trToEn: true, category: 'cross' }, { query: 'book', relevant: ['b.md'], category: 'english' }, { query: 'none', abstain: true, category: 'empty' }]));
  return { root, corpusDir, casesFile };
}
const vector = (text) => /araba|car/u.test(text) ? [1, 0] : /book/u.test(text) ? [0, 1] : [0, 0];
test('three modes share cases and compute hand checked metrics and subsets', async (t) => {
  const { corpusDir, casesFile } = fixture(t);
  const provider = { id: 'fake', dims: 2, embedDocuments: async (texts) => texts.map(vector), embedQuery: async (text) => vector(text) };
  const result = await runSemanticEval({ corpusDir, casesFile, provider });
  assert.equal(result.lexical.recallAt5, 0.5); assert.equal(result.lexical.precisionAt5, 0.1);
  assert.equal(result.semantic.recallAt5, 1); assert.equal(result.semantic.mrrAt10, 1); assert.equal(result.semantic.ndcgAt10, 1);
  assert.equal(result.hybrid.recallAt5, 1); assert.equal(result.hybrid.precisionAt5, 0.2);
  assert.equal(result.hybrid.trToEn.recallAt5, 1); assert.equal(result.deltaVsLexical.trToEn.recallAt5, 1);
  assert.equal(result.hybrid.byCategory.empty.abstain, 1); assert.equal(result.hybrid.answerable, 2);
  assert.equal(result.index.chunks, 2); assert.equal(result.index.dims, 2);
  assert.equal(JSON.stringify(result).includes('araba'), false);
});

test('CLI json and help use fake fetch and isolated environment', (t) => {
  const { root, corpusDir, casesFile } = fixture(t);
  const preload = path.join(root, 'fake.mjs');
  writeFileSync(preload, `globalThis.fetch = async (_url, options) => ({ok:true,json:async()=>({embeddings:JSON.parse(options.body).input.map(x => /araba|car/.test(x) ? [1,0] : /book/.test(x) ? [0,1] : [0,0])})});`);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root };
  const cli = spawnSync(process.execPath, ['--import', preload, 'eval/semantic-eval.mjs', '--corpus', corpusDir, '--cases', casesFile, '--model', 'embeddinggemma', '--dims', '2', '--json'], { encoding: 'utf8', env });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).semantic.recallAt5, 1); assert.match(cli.stderr, /fair/);
  const help = spawnSync(process.execPath, ['eval/semantic-eval.mjs', '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0); assert.match(help.stdout, /multilingual-e5-small/); assert.match(help.stdout, /qwen3-embedding/);
});
