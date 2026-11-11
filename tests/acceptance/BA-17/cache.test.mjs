// SPDX-License-Identifier: MIT
// BA-17 cache schema: a cache written under the old fingerprint tag (retrieval-stat-v5) is rebuilt exactly once,
// and the rebuilt cache (tag v6) is reused on the next start without a rewrite. The fingerprint is reproduced here from
// the contract (lstat size, mtimeMs, ctimeMs, ino and the vault-relative path of every walked Markdown file, in walk
// order, under the schema tag). The reproduction is checked against the key the module writes before it is trusted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadRetrieval, NOW } from './support.mjs';

const { createSearcher, buildIndex, search } = await loadRetrieval();

function walkMarkdown(root) {
  const files = [];
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(full);
    }
  })(root);
  return files;
}
function fingerprintKey(vault, tag) {
  const h = createHash('sha256').update(tag);
  for (const full of walkMarkdown(vault)) {
    const rel = path.relative(vault, full).split(path.sep).join('/');
    const st = fs.lstatSync(full);
    h.update(`${rel}\0${[st.size, st.mtimeMs, st.ctimeMs, st.ino].join('\0')}\n`);
  }
  return h.digest('hex');
}

function makeVault(home) {
  const vault = path.join(home, 'vault');
  const deep = 'l1/l2/l3/l4/l5/l6/l7/l8/l9/l10/l11/l12/l13/l14/l15/l16';
  fs.mkdirSync(path.join(vault, deep), { recursive: true });
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, deep, 'handler-x-13.mjs.md'), 'Reference: l12/l13/l14/l15/l16/handler-x-13.mjs for the pipeline.\n');
  fs.writeFileSync(path.join(vault, 'notes/widgets.md'), '---\ntitle: Widgets\n---\n# Widgets\nThe widget pipeline uses E_WIDGET_TIMEOUT.\n');
  fs.writeFileSync(path.join(vault, 'notes/old.md'), '---\nstatus: superseded\n---\nOLD_ONLY_TOKEN was replaced.\n');
  return vault;
}

test('fingerprint reproduction matches the key the module writes (self-check of the reproduction)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba17-cache-'));
  try {
    const vault = makeVault(home), stateDir = path.join(home, 'state');
    createSearcher({ vaultDir: vault, stateDir, now: NOW });
    const data = JSON.parse(fs.readFileSync(path.join(stateDir, 'retrieval-index.json'), 'utf8'));
    assert.equal(data.key, fingerprintKey(vault, 'retrieval-stat-v6'), 'current tag reproduces the written key');
    assert.notEqual(fingerprintKey(vault, 'retrieval-stat-v5'), data.key, 'old tag gives a different key');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a cache written under the v5 tag is rebuilt once, then reused without a rewrite', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba17-cache-'));
  try {
    const vault = makeVault(home), stateDir = path.join(home, 'state'), cacheFile = path.join(stateDir, 'retrieval-index.json');
    createSearcher({ vaultDir: vault, stateDir, now: NOW });
    const current = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    // Same content, old schema tag in the key: the only thing that should trigger a rebuild.
    fs.writeFileSync(cacheFile, JSON.stringify({ ...current, key: fingerprintKey(vault, 'retrieval-stat-v5') }));
    const oldBytes = fs.readFileSync(cacheFile, 'utf8');

    // First start on the new code: the key mismatches, so the cache is rewritten under the v6 key.
    const first = createSearcher({ vaultDir: vault, stateDir, now: NOW });
    const rebuilt = fs.readFileSync(cacheFile, 'utf8');
    assert.notEqual(rebuilt, oldBytes, 'old-tag cache must be rebuilt');
    assert.equal(JSON.parse(rebuilt).key, fingerprintKey(vault, 'retrieval-stat-v6'), 'rebuilt cache carries the v6 key');

    // Second start: same vault, cache hit, no rewrite.
    const second = createSearcher({ vaultDir: vault, stateDir, now: NOW });
    assert.equal(fs.readFileSync(cacheFile, 'utf8'), rebuilt, 'a valid v6 cache is reused without a rewrite');
    assert.equal(second.refreshIfChanged(), false, 'no change, no rebuild');
    assert.equal(first.refreshIfChanged(), false);

    // Results from the rebuilt and the reused cache equal a fresh build of the same vault.
    const { loadPages } = await loadRetrieval();
    const fresh = buildIndex(loadPages(vault), { now: NOW });
    for (const q of ['E_WIDGET_TIMEOUT', 'l12/l13/l14/l15/l16/handler-x-13.mjs', 'OLD_ONLY_TOKEN', 'widget pipeline']) {
      const a = JSON.stringify(second.search(q, { limit: 5, abstainThreshold: 0, asOf: NOW }));
      const b = JSON.stringify(search(fresh, q, { limit: 5, abstainThreshold: 0, asOf: NOW }));
      assert.equal(a.replace(/"stale":(true|false)/g, ''), b.replace(/"stale":(true|false)/g, ''), `query ${q}`);
    }
    // The superseded page stays out of the index (it is recorded as skipped, not searched).
    assert.equal(second.search('OLD_ONLY_TOKEN', { limit: 5, abstainThreshold: 0, asOf: NOW }).results.length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
