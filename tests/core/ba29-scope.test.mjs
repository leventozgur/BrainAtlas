// SPDX-License-Identifier: MIT
// BA-29: one search-root rule (<vault>/wiki when it is a directory inside the vault, else the vault root) and one
// exclusion rule for the core searcher. Hermetic: temporary vault and state directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearcher, searchScope, loadPagesDetailed } from '../../packages/core/src/retrieval/index.mjs';

const now = new Date('2026-11-11T00:00:00Z');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba29-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
function paths(results) {
  return results.map((r) => r.path).sort();
}

test('the search root is <vault>/wiki when it is a directory, otherwise the vault root', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  assert.equal(searchScope(vault).root, vault, 'no wiki directory: vault root');
  fs.writeFileSync(path.join(vault, 'wiki'), 'not a directory');
  assert.equal(searchScope(vault).root, vault, 'a wiki file is not a wiki directory');
  fs.rmSync(path.join(vault, 'wiki'));
  fs.mkdirSync(path.join(vault, 'wiki'));
  assert.equal(searchScope(vault).root, path.join(vault, 'wiki'), 'wiki directory: wiki root');
});

test('a wiki symlink that points inside the vault is the root; one that leaves the vault is not', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault'),
    outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(vault, 'real'), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(path.join(vault, 'real'), path.join(vault, 'wiki'), 'dir');
  assert.equal(searchScope(vault).root, path.join(vault, 'wiki'), 'inside symlink: wiki root');
  fs.unlinkSync(path.join(vault, 'wiki'));
  fs.symlinkSync(outside, path.join(vault, 'wiki'), 'dir');
  assert.equal(searchScope(vault).root, vault, 'escaping symlink: vault root, nothing is read outside the vault');
});

test('default exclusion at wiki root covers only the root-level navigation and policy files', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  assert.deepEqual(searchScope(vault).exclude, ['index.md', 'log.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
});

test('default exclusion at vault root adds planning, archive, inbox and raw', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  assert.deepEqual(searchScope(vault).exclude, [
    'index.md',
    'log.md',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'planning/**',
    'archive/**',
    'inbox/**',
    'raw/**',
  ]);
});

test('a configured list replaces the default and an empty list restores the legacy scope', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  fs.mkdirSync(vault);
  assert.deepEqual(searchScope(vault, ['drafts/**']).exclude, ['drafts/**']);
  assert.deepEqual(searchScope(vault, []).exclude, []);
});

test('wiki root: root-level index and log are not ranked, nested pages with the same names are', (t) => {
  const dir = temp(t),
    wiki = path.join(dir, 'vault', 'wiki');
  write(wiki, 'index.md', '# Catalog\nquokka catalog');
  write(wiki, 'log.md', '# Log\nquokka log entry');
  write(wiki, 'AGENTS.md', '# Policy\nquokka policy');
  write(wiki, 'notes/index.md', '# Notes index\nquokka notes catalog');
  write(wiki, 'notes/habitat.md', '# Habitat\nquokka habitat');
  const scope = searchScope(path.join(dir, 'vault'));
  const state = path.join(dir, 'state');
  const results = createSearcher({ vaultDir: scope.root, stateDir: state, now, exclude: scope.exclude }).search(
    'quokka',
    { limit: 10, abstainThreshold: 0 }
  ).results;
  assert.deepEqual(paths(results), ['notes/habitat.md', 'notes/index.md']);
});

test('wiki/archive is an ordinary folder under the wiki root and stays searchable', (t) => {
  const dir = temp(t),
    wiki = path.join(dir, 'vault', 'wiki');
  write(wiki, 'archive/old.md', '# Old\nquokka archive page');
  const scope = searchScope(path.join(dir, 'vault'));
  const results = createSearcher({
    vaultDir: scope.root,
    stateDir: path.join(dir, 'state'),
    now,
    exclude: scope.exclude,
  }).search('quokka', { limit: 10, abstainThreshold: 0 }).results;
  assert.deepEqual(paths(results), ['archive/old.md']);
});

test('vault root without wiki: planning, archive, inbox and raw are not ranked; other folders are', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nquokka');
  write(vault, 'planning/backlog.md', '# Backlog\nquokka plan');
  write(vault, 'archive/a.md', '# Archive\nquokka archived');
  write(vault, 'inbox/i.md', '# Inbox\nquokka inbox');
  write(vault, 'raw/r.md', '# Raw\nquokka raw');
  write(vault, 'notes/n.md', '# Note\nquokka note');
  const scope = searchScope(vault);
  const results = createSearcher({
    vaultDir: scope.root,
    stateDir: path.join(dir, 'state'),
    now,
    exclude: scope.exclude,
  }).search('quokka', { limit: 10, abstainThreshold: 0 }).results;
  assert.deepEqual(paths(results), ['notes/n.md']);
});

test('an empty exclusion list gives the legacy result set', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nquokka');
  write(vault, 'planning/backlog.md', '# Backlog\nquokka plan');
  write(vault, 'notes/n.md', '# Note\nquokka note');
  const scope = searchScope(vault, []);
  const results = createSearcher({
    vaultDir: scope.root,
    stateDir: path.join(dir, 'state'),
    now,
    exclude: scope.exclude,
  }).search('quokka', { limit: 10, abstainThreshold: 0 }).results;
  assert.deepEqual(paths(results), ['index.md', 'notes/n.md', 'planning/backlog.md']);
});

test('the core searcher without an exclude option keeps every page (API default unchanged)', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nquokka');
  write(vault, 'notes/n.md', '# Note\nquokka note');
  const results = createSearcher({ vaultDir: vault, stateDir: path.join(dir, 'state'), now }).search('quokka', {
    limit: 10,
    abstainThreshold: 0,
  }).results;
  assert.deepEqual(paths(results), ['index.md', 'notes/n.md']);
});

test('excluded pages stay in the index statistics and the snapshot, flagged, and never in results', (t) => {
  const dir = temp(t),
    wiki = path.join(dir, 'vault', 'wiki');
  write(wiki, 'index.md', '# Catalog\nquokka');
  write(wiki, 'notes/n.md', '# Note\nquokka note');
  const scope = searchScope(path.join(dir, 'vault'));
  const searcher = createSearcher({
    vaultDir: scope.root,
    stateDir: path.join(dir, 'state'),
    now,
    exclude: scope.exclude,
  });
  const snapshot = searcher.snapshot();
  assert.deepEqual(
    snapshot.index.docs.map((d) => d.page.path),
    ['index.md', 'notes/n.md']
  );
  assert.equal(snapshot.index.docs[0].excluded, true);
  assert.equal(snapshot.index.docs[1].excluded, undefined);
  assert.deepEqual(paths(searcher.search('quokka', { limit: 10, abstainThreshold: 0 }).results), ['notes/n.md']);
});

test('excluded pages leave the statistics and the scores of other pages unchanged (no IDF shift)', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nquokka habitat catalog');
  write(vault, 'log.md', '# Log\nquokka habitat log');
  write(vault, 'notes/n.md', '# Note\nquokka habitat note');
  write(vault, 'notes/m.md', '# More\nquokka diet');
  const score = (exclude) => {
    const r = createSearcher({
      vaultDir: vault,
      stateDir: path.join(dir, 'state-' + (exclude ? 'x' : 'l')),
      now,
      exclude,
    }).search('quokka habitat', { limit: 10, abstainThreshold: 0 }).results;
    return Object.fromEntries(r.map((x) => [x.path, x.score]));
  };
  const legacy = score(undefined),
    scoped = score(['index.md', 'log.md']);
  assert.equal(scoped['notes/n.md'], legacy['notes/n.md']);
  assert.equal(scoped['notes/m.md'], legacy['notes/m.md']);
  assert.equal(Object.hasOwn(scoped, 'index.md'), false);
  assert.equal(Object.hasOwn(scoped, 'log.md'), false);
});

test('an excluded page at the top does not reduce the results: the next page fills the limit', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nquokka quokka quokka');
  write(vault, 'a.md', '# A\nquokka one');
  write(vault, 'b.md', '# B\nquokka two');
  const r = createSearcher({ vaultDir: vault, stateDir: path.join(dir, 'state'), now, exclude: ['index.md'] }).search(
    'quokka',
    { limit: 2, abstainThreshold: 0 }
  ).results;
  assert.deepEqual(paths(r), ['a.md', 'b.md']);
});

test('excluded pages stay readable by the page loader used by the read tools', (t) => {
  const dir = temp(t),
    wiki = path.join(dir, 'vault', 'wiki');
  write(wiki, 'index.md', '# Catalog\nquokka');
  const { pages } = loadPagesDetailed(wiki);
  assert.deepEqual(
    pages.map((p) => p.path),
    ['index.md'],
    'the loader itself is unchanged and reads the page'
  );
  assert.equal(fs.readFileSync(path.join(wiki, 'index.md'), 'utf8').includes('quokka'), true);
});

test('the exclusion rule is part of the cache key: same rule shares the cache, a changed rule rebuilds it', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault'),
    state = path.join(dir, 'state');
  write(vault, 'index.md', '# Root index\nquokka');
  write(vault, 'notes/n.md', '# Note\nquokka note');
  const cache = path.join(state, 'retrieval-index.json');
  const keyOf = () => JSON.parse(fs.readFileSync(cache, 'utf8')).key;

  createSearcher({ vaultDir: vault, stateDir: state, now, exclude: ['index.md'] }).search('quokka');
  const keyWithRule = keyOf();
  const written = fs.statSync(cache).ino + ':' + fs.readFileSync(cache, 'utf8');
  createSearcher({ vaultDir: vault, stateDir: state, now, exclude: ['index.md'] }).search('quokka');
  assert.equal(
    fs.statSync(cache).ino + ':' + fs.readFileSync(cache, 'utf8'),
    written,
    'same rule: cache reused without a rewrite'
  );

  createSearcher({ vaultDir: vault, stateDir: state, now, exclude: ['notes/**'] }).search('quokka');
  assert.notEqual(keyOf(), keyWithRule, 'changed rule: the key changes and the cache is rebuilt');
  const rebuilt = createSearcher({ vaultDir: vault, stateDir: state, now, exclude: ['notes/**'] }).search('quokka', {
    limit: 10,
    abstainThreshold: 0,
  }).results;
  assert.deepEqual(paths(rebuilt), ['index.md']);
});

test('hook and MCP that resolve the same scope share one cache file and key', (t) => {
  const dir = temp(t),
    wiki = path.join(dir, 'vault', 'wiki'),
    state = path.join(dir, 'state');
  write(wiki, 'notes/n.md', '# Note\nquokka note');
  const scope = searchScope(path.join(dir, 'vault'));
  createSearcher({ vaultDir: scope.root, stateDir: state, now, exclude: scope.exclude }).search('quokka');
  const first = JSON.parse(fs.readFileSync(path.join(state, 'retrieval-index.json'), 'utf8')).key;
  const second = createSearcher({
    vaultDir: searchScope(path.join(dir, 'vault')).root,
    stateDir: state,
    now,
    exclude: searchScope(path.join(dir, 'vault')).exclude,
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'retrieval-index.json'), 'utf8')).key, first);
  assert.deepEqual(paths(second.search('quokka', { limit: 10, abstainThreshold: 0 }).results), ['notes/n.md']);
});

test('a query whose best match is excluded is decided on the full corpus, as before: no results, not abstained', (t) => {
  const dir = temp(t),
    vault = path.join(dir, 'vault');
  write(vault, 'index.md', '# Root index\nzebrafish catalogue');
  write(vault, 'notes/n.md', '# Note\nunrelated words here');
  const legacy = createSearcher({ vaultDir: vault, stateDir: path.join(dir, 'state-l'), now, exclude: [] }).search(
    'zebrafish catalogue',
    { limit: 5, abstainThreshold: 0.35 }
  );
  const scoped = createSearcher({
    vaultDir: vault,
    stateDir: path.join(dir, 'state-s'),
    now,
    exclude: ['index.md'],
  }).search('zebrafish catalogue', { limit: 5, abstainThreshold: 0.35 });
  assert.equal(legacy.abstained, false);
  assert.equal(legacy.results[0].path, 'index.md');
  assert.deepEqual(scoped.results, []);
  assert.equal(scoped.abstained, false);
});
