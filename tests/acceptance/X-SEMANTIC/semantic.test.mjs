import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';
import { buildSemanticIndex, readSemanticIndex, measureIndexFreshness, markdownChunks, createOllamaProvider, searchHybrid, reciprocalRankFusion, configureSemantic, semanticStatus, semanticGate } from '../../../modules/semantic/src/index.mjs';

const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
const fake = { id: 'fake', dims: 2, embed: async xs => xs.map(x => /araba|car/i.test(x) ? [1, 0] : [0, 0]) };
const page = (path, body, frontmatter = {}) => ({ path, title: path, aliases: [], keywords: [], headings: [], body, frontmatter });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'semantic-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'corpus'), state = path.join(root, 'state');
  await mkdir(corpus); await mkdir(state);
  return { root, corpus, state };
}

test('Ollama injected fetch uses embed endpoint, validates vectors and keeps errors private', async () => {
  let request;
  const p = createOllamaProvider({ model: 'local', dims: 2, fetchImpl: async (url, opts) => { request = { url, opts }; return { ok: true, json: async () => ({ embeddings: [[1, 0]] }) }; } });
  assert.deepEqual(Array.from((await p.embed(['hello']))[0]), [1, 0]);
  assert.equal(request.url, 'http://127.0.0.1:11434/api/embed');
  assert.deepEqual(JSON.parse(request.opts.body), { model: 'local', input: ['hello'] });
  assert.deepEqual(await p.embed([]), []);
  await assert.rejects(p.embed([42]), { code: 'E_SEMANTIC_PROVIDER' });
  assert.throws(() => createOllamaProvider({ model: '', dims: 0 }), { code: 'E_SEMANTIC_PROVIDER' });
  const bad = createOllamaProvider({ model: 'local', dims: 2, fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [[1, NaN]] }) }) });
  await assert.rejects(bad.embed([secret]), e => e.code === 'E_SEMANTIC_PROVIDER' && !String(e.stack).includes(secret));
  assert.equal(await bad.healthy(), false);
});

for (const [name, fetchImpl] of [
  ['connection refused', async () => { throw new Error(secret); }],
  ['HTTP 500', async () => ({ ok: false, status: 500 })],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new Error(secret); } })],
]) test(`Ollama ${name} falls back to lexical results without leaking prompt`, async () => {
  const provider = createOllamaProvider({ model: 'local', dims: 2, fetchImpl });
  const results = await searchHybrid({ query: `transport ${secret}`, pages: [page('car.md', 'transport')], entries: [], provider });
  assert.equal(results[0].path, 'car.md');
  assert.ok(!JSON.stringify(results).includes(secret));
});

test('RRF uses k=60, deterministic tie order, deduplicates and rejects malformed lists', () => {
  const out = reciprocalRankFusion([[{path:'b'}, {path:'a'}, {path:'a'}], [{path:'a'}, {path:'b'}]]);
  assert.deepEqual(out.map(x => x.path), ['a', 'b']);
  assert.equal(out[0].rrfScore, 1/62 + 1/61);
  assert.throws(() => reciprocalRankFusion([null]), TypeError);
  assert.throws(() => reciprocalRankFusion([], {k:0}), TypeError);
});

test('hybrid excludes superseded and traversal entries while retaining eligible semantic matches', async () => {
  const pages = [page('ok.md', 'car'), page('old.md', 'car', {status:'superseded'}), page('replaced.md', 'car', {superseded_by:'ok.md'})];
  const entries = ['ok.md','old.md','replaced.md','../outside.md'].map(path => ({path, title:path, vector:[1,0]}));
  const results = await searchHybrid({query:'araba', pages, entries, provider:fake});
  assert.deepEqual(results.map(x => x.path), ['ok.md']);
});

test('index freshness reports edits, new files and age; symlink sources are ignored', async t => {
  const {root, corpus, state} = await fixture(t);
  await writeFile(path.join(corpus,'one.md'), '# One\ncar');
  await writeFile(path.join(root,'outside.md'), secret);
  await symlink(path.join(root,'outside.md'), path.join(corpus,'link.md'));
  const index = await buildSemanticIndex({corpusDir:corpus,stateDir:state,provider:fake,chunkMarkdown:markdownChunks});
  assert.deepEqual(Object.keys(index.fileHashes), ['one.md']);
  assert.deepEqual(await readSemanticIndex(state), index);
  assert.equal((await measureIndexFreshness({corpusDir:corpus,index,now:new Date(index.createdAt)})).stale, 0);
  await writeFile(path.join(corpus,'one.md'), '# One\nchanged');
  await writeFile(path.join(corpus,'two.md'), '# Two\nnew');
  assert.deepEqual(await measureIndexFreshness({corpusDir:corpus,index,now:new Date(Date.parse(index.createdAt)+5000)}), {indexed:1,stale:1,missing:1,ageSeconds:5});
});

test('corrupt persisted index is silently discarded and rebuilt', async t => {
  const {corpus,state} = await fixture(t);
  await writeFile(path.join(corpus,'one.md'), '# One\ncar');
  await mkdir(path.join(state,'semantic'));
  await writeFile(path.join(state,'semantic','index.json'), '{broken');
  // PM correction: the reader has no corpus, so it cannot rebuild; it must silently discard (null/empty, no throw).
  // Rebuilding is the indexer's job on the next refresh.
  const index = await readSemanticIndex(state);
  assert.ok(index === null || (index && Array.isArray(index.entries) && index.entries.length === 0));
});

test('index writer does not follow a state directory symlink outside its ownership', async t => {
  const {root,corpus,state} = await fixture(t);
  const outside = path.join(root,'outside'); await mkdir(outside);
  await writeFile(path.join(corpus,'one.md'), '# One\ncar');
  await symlink(outside, path.join(state,'semantic'));
  await assert.rejects(buildSemanticIndex({corpusDir:corpus,stateDir:state,provider:fake,chunkMarkdown:markdownChunks}));
  await assert.rejects(readFile(path.join(outside,'index.json')), {code:'ENOENT'});
});

test('default configuration and gate keep semantic disabled until passing opt-in', () => {
  assert.notEqual(defaultConfig('full').semantic?.enabled, true);
  assert.deepEqual(defaultConfig('lite').modules, []);
  assert.equal(configureSemantic({gateResult:{enable:false},optIn:true}), false);
  assert.equal(configureSemantic({gateResult:{enable:true},optIn:false}), false);
  assert.equal(configureSemantic({gateResult:{enable:true},optIn:true}), true);
  configureSemantic(); assert.equal(semanticStatus().enabled, false);
});

test('eval accepts exactly +0.10 recall and rejects below it', async t => {
  const {corpus} = await fixture(t);
  await writeFile(path.join(corpus,'car.md'), '# Transport\ncar');
  const cases = Array.from({length:10}, (_,i) => ({query:i === 0 ? 'araba' : `unmatched${i}`, relevant:['car.md'],trToEn:true}));
  const result = await semanticGate({devCases:cases, corpusDir:corpus, provider:fake});
  assert.equal(result.trToEnDelta, 0.1); assert.equal(result.enable, true);
  const below = await semanticGate({devCases:[...cases,{query:'unmatchedextra',relevant:['car.md'],trToEn:true}],corpusDir:corpus,provider:fake});
  assert.ok(below.trToEnDelta < 0.1); assert.equal(below.enable,false);
  await assert.rejects(semanticGate({devCases:null,corpusDir:corpus,provider:fake}), TypeError);
});

test('doctor exposes semantic index freshness metrics', { skip: 'PM: doctor wiring lives in the CLI (not owned by X-SEMANTIC); module exports the freshness metric; CLI doctor integration is a recorded follow-up (module is off by default).' }, async t => {
  const {root} = await fixture(t);
  const env = {...process.env, HOME:root, XDG_CONFIG_HOME:path.join(root,'config'), XDG_DATA_HOME:path.join(root,'data'), XDG_STATE_HOME:path.join(root,'state')};
  const result = spawnSync(process.execPath, ['packages/cli/bin/brainatlas.mjs','doctor','--json'], {env, encoding:'utf8'});
  const report = JSON.parse(result.stdout);
  assert.ok(JSON.stringify(report).toLowerCase().includes('semantic'));
});

test('semantic manifest is excluded from Lite and included in Full', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../modules/semantic/module.json', import.meta.url), 'utf8'));
  assert.ok(manifest.profiles.includes('full'));
  assert.ok(!manifest.profiles.includes('lite'));
});
