// SPDX-License-Identifier: MIT
// BA-09 blind acceptance: provenance trust class of each page, observed through the public `trust` result field.
// Every probe page has the same title and body, so the lexical score is identical and only the class can differ.
// Contract: docs/contracts/retrieval.md, "Provenance trust", **Classes**.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { loadCandidate, makeVault, removeDir, page, record, NOW } from './helpers.mjs';

const rt = await loadCandidate();
const QUERY = 'zephyr quorum ledger';
const verified = (fields) => record(fields);
const confirmed = 'status: confirmed\n';

// [name, frontmatter (raw YAML lines after title), expected class]
const CASES = [
  ['confirmed-quoted-date', `${confirmed}${verified({})}`, 'verified'],
  ['confirmed-unquoted-date', `${confirmed}${verified({ date: '2026-11-01' })}`, 'verified'],
  ['confirmed-quoted-utc-stamp', `${confirmed}${verified({ date: '"2026-11-01T10:30:00Z"' })}`, 'verified'],
  ['confirmed-unquoted-utc-stamp', `${confirmed}${verified({ date: '2026-11-01T10:30:00Z' })}`, 'verified'],
  ['confirmed-quoted-status', `status: "confirmed"\n${verified({})}`, 'verified'],
  ['confirmed-one-valid-among-invalid', `${confirmed}${verified({ date: '"2026-02-30"' })}  - date: "2026-11-01"\n    evidence: "e"\n    scope: "s"\n    source: "x"\n`, 'verified'],
  ['confirmed-impossible-date-quoted', `${confirmed}${verified({ date: '"2026-02-30"' })}`, 'neutral'],
  ['confirmed-impossible-month', `${confirmed}${verified({ date: '"2026-13-01"' })}`, 'neutral'],
  ['confirmed-short-day', `${confirmed}${verified({ date: '"2026-11-1"' })}`, 'neutral'],
  ['confirmed-non-iso-date', `${confirmed}${verified({ date: '"11/01/2026"' })}`, 'neutral'],
  ['confirmed-offset-stamp', `${confirmed}${verified({ date: '"2026-11-01T10:30:00+03:00"' })}`, 'neutral'],
  ['confirmed-empty-evidence', `${confirmed}${verified({ evidence: '""' })}`, 'neutral'],
  ['confirmed-blank-scope', `${confirmed}${verified({ scope: '"   "' })}`, 'neutral'],
  ['confirmed-numeric-source', `${confirmed}${verified({ source: '5' })}`, 'neutral'],
  ['confirmed-missing-source', `${confirmed}verified:\n  - date: "2026-11-01"\n    evidence: "e"\n    scope: "s"\n`, 'neutral'],
  ['confirmed-missing-scope', `${confirmed}verified:\n  - date: "2026-11-01"\n    evidence: "e"\n    source: "x"\n`, 'neutral'],
  ['confirmed-mapping-not-list', `${confirmed}verified:\n  date: "2026-11-01"\n  evidence: "e"\n  scope: "s"\n  source: "x"\n`, 'neutral'],
  ['confirmed-empty-list', `${confirmed}verified: []\n`, 'neutral'],
  ['confirmed-no-verified-key', `${confirmed}`, 'neutral'],
  ['confirmed-record-is-string', `${confirmed}verified:\n  - "2026-11-01"\n`, 'neutral'],
  ['confirmed-capitalised-status', `status: Confirmed\n${verified({})}`, 'neutral'],
  ['confirmed-upper-status', `status: CONFIRMED\n${verified({})}`, 'neutral'],
  ['proposed-with-valid-record', `status: proposed\n${verified({})}`, 'weak'],
  ['proposed-without-record', `status: proposed\n`, 'weak'],
  ['disputed-without-record', `status: disputed\n`, 'weak'],
  ['disputed-with-invalid-record', `status: disputed\n${verified({ date: '"2026-02-30"' })}`, 'weak'],
  ['capitalised-proposed', `status: Proposed\n`, 'neutral'],
  ['draft-with-valid-record', `status: draft\n${verified({})}`, 'neutral'],
  ['no-status-with-valid-record', `${verified({})}`, 'neutral'],
  ['no-frontmatter-at-all', null, 'neutral'],
];

const files = {};
for (const [name, fm, _expected] of CASES) {
  files[`${name}.md`] = fm === null ? `# Probe\n${QUERY} reconciliation.\n` : page({ fm });
}
const vault = makeVault(files, 'ba09-class-');
after(() => removeDir(vault));

test('each provenance combination maps to the documented class', () => {
  const index = rt.buildIndex(rt.loadPages(vault), { now: NOW });
  const search = rt.search(index, QUERY, { limit: 100, abstainThreshold: 0, asOf: NOW });
  assert.equal(search.abstained, false);
  const byPath = new Map(search.results.map((r) => [r.path, r]));
  for (const [name, , expected] of CASES) {
    const hit = byPath.get(`${name}.md`);
    assert.ok(hit, `${name} is indexed and matches`);
    if (expected === 'neutral') assert.equal(Object.hasOwn(hit, 'trust'), false, `${name} is neutral and has no trust key`);
    else assert.equal(hit.trust, expected, name);
  }
});

test('a page with a non-list verified value is neutral even when its status is confirmed', () => {
  const dir = makeVault({
    'scalar.md': page({ fm: `status: confirmed\nverified: "2026-11-01"\n` }),
    'list.md': page({ fm: `status: confirmed\n${record({})}` }),
  }, 'ba09-scalar-');
  try {
    const index = rt.buildIndex(rt.loadPages(dir), { now: NOW });
    const trust = Object.fromEntries(index.docs.map((d) => [d.page.path, d.trust]));
    assert.equal(trust['scalar.md'], 'neutral');
    assert.equal(trust['list.md'], 'verified');
  } finally {
    removeDir(dir);
  }
});

test('superseded pages are not indexed, so they have no class', () => {
  const dir = makeVault({
    'old.md': page({ fm: `status: superseded\nsuperseded_by: wiki/new.md\n${record({})}` }),
    'new.md': page({ fm: `status: confirmed\n${record({ source: '"raw/new.md"' })}` }),
  }, 'ba09-super-');
  try {
    const index = rt.buildIndex(rt.loadPages(dir), { now: NOW });
    assert.deepEqual(index.docs.map((d) => [d.page.path, d.trust]), [['new.md', 'verified']]);
  } finally {
    removeDir(dir);
  }
});

// Contract: an impossible calendar day such as 2026-02-30 is invalid, quoted or not (retrieval/index.mjs, validDate comment).
// An unquoted scalar is first parsed as a YAML 1.1 timestamp and rolled over (2026-02-30 becomes 2026-03-02) before the check.
test('unquoted impossible calendar days and times are invalid, like their quoted forms', () => {
  const impossible = { 'unq-feb30.md': '2026-02-30', 'unq-feb29.md': '2026-02-29', 'unq-nov31.md': '2026-11-31', 'unq-stamp-hour25.md': '2026-11-01T25:00:00Z' };
  const dir = makeVault(Object.fromEntries(Object.entries(impossible).map(([name, date]) => [name, page({ fm: `status: confirmed\n${record({ date })}` })])), 'ba09-unq-');
  try {
    const index = rt.buildIndex(rt.loadPages(dir), { now: NOW });
    const trust = Object.fromEntries(index.docs.map((d) => [d.page.path, d.trust]));
    for (const name of Object.keys(impossible)) assert.equal(trust[name], 'neutral', `${name} (${impossible[name]})`);
  } finally {
    removeDir(dir);
  }
});
