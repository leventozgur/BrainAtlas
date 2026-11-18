// SPDX-License-Identifier: MIT
// BA-48 phase B1: the deterministic synthesis core — scoring, target selection, sanitising, schema validation, the five
// gates, the block renderer and the proposal store. No model call and no vault write happens here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runMaintenance } from '../../packages/cli/src/maintain.mjs';

const coreUrl = pathToFileURL(resolve('packages/cli/src/synthesis/core.mjs')).href;
const {
  scorePages,
  selectTargets,
  sanitizeForModel,
  splitSentences,
  validateProposal,
  runGates,
  renderBlock,
  insertBlock,
  createStore,
} = await import(coreUrl);

const FIXTURES = resolve('tests/fixtures/ba48b');
const vaultFixture = join(FIXTURES, 'vault');
const pageFixture = async (name) => readFile(join(FIXTURES, 'pages', name), 'utf8');

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  }
  return root;
}

const anchor = (quote, source = 'page') => ({ source, quote });
const sentence = (text, quotes = [text]) => ({ text, anchors: quotes.map((quote) => anchor(quote)) });
const proposalOf = (sentences, { page = 'wiki/concepts/atlas.md', conflicts = [], schemaVersion = 1 } = {}) => ({
  schemaVersion,
  page,
  sentences,
  conflicts,
});

function withStatus(text, status) {
  return text.replace(/^status: .*$/mu, `status: ${status}`);
}

test('sanitizeForModel removes comments and control characters but changes nothing else', () => {
  const input = 'A\r\n<!-- secret\nmulti-line -->B\u200b\u202eC\ufeff\r\nD';
  assert.equal(sanitizeForModel(input), 'A\nBC\nD');
  assert.equal(
    sanitizeForModel('plain text, keeps punctuation & diacritics: ğüşi'),
    'plain text, keeps punctuation & diacritics: ğüşi'
  );
  assert.equal(sanitizeForModel('<!-- open without a close'), '<!-- open without a close');
});

test('splitSentences is deterministic and keeps fenced lines whole', () => {
  const text = [
    '# Title',
    'First sentence. Second!',
    '- item one',
    '- item two',
    '```js',
    'const x = 1.',
    'const y = 2;',
    '```',
    'Last part?',
  ].join('\n');
  const expected = [
    '# Title',
    'First sentence.',
    'Second!',
    '- item one',
    '- item two',
    'const x = 1.',
    'const y = 2;',
    'Last part?',
  ];
  assert.deepEqual(splitSentences(text), expected);
  assert.deepEqual(splitSentences(text), splitSentences(text));
  assert.deepEqual(splitSentences('a.b no split\n\n'), ['a.b no split']);
});

test('validateProposal accepts the schema and rejects every deviation', () => {
  const valid = proposalOf([sentence('The cache limit is 512 MB.')]);
  assert.deepEqual(validateProposal(valid), { ok: true, errors: [] });

  assert.equal(validateProposal({ ...valid, extra: true }).ok, false);
  assert.equal(validateProposal({ ...valid, schemaVersion: 2 }).ok, false);
  assert.equal(validateProposal({ ...valid, page: 'concepts/atlas.md' }).ok, false);
  assert.equal(validateProposal(proposalOf([])).ok, false);
  assert.equal(validateProposal(proposalOf(Array.from({ length: 21 }, () => sentence('A fact.')))).ok, false);
  assert.equal(validateProposal(proposalOf([{ text: 'A fact.', anchors: [] }])).ok, false);
  assert.equal(
    validateProposal(proposalOf([{ text: 'A fact.', anchors: [anchor('a'), anchor('b'), anchor('c'), anchor('d')] }]))
      .ok,
    false
  );
  assert.equal(validateProposal(proposalOf([sentence('x'.repeat(401))])).ok, false);
  assert.equal(validateProposal(proposalOf([{ text: 'A fact.', anchors: [anchor('quote', 'raw')] }])).ok, false);
  assert.equal(
    validateProposal({ ...valid, conflicts: Array.from({ length: 6 }, () => ({ a: 'x', b: 'y' })) }).ok,
    false
  );
  assert.equal(validateProposal({ ...valid, conflicts: [{ a: 'x', b: 'y', c: 'z' }] }).ok, false);
  const long = Array.from({ length: 20 }, () => sentence(Array.from({ length: 13 }, () => 'word').join(' ')));
  const tooManyWords = validateProposal(proposalOf(long));
  assert.equal(tooManyWords.ok, false);
  assert.ok(tooManyWords.errors.some((error) => error.includes('250')));
});

test('the clean proposal passes all five gates and reports a zero delta', async () => {
  const pageText = await pageFixture('atlas.md');
  const archiveText = await pageFixture('atlas-history.md');
  const facts = ['The Atlas runtime listens on port 7070.', 'Deployment uses v2.4.0-rc.12 since 2026-03-04.'];
  const proposal = proposalOf(facts.map((text) => sentence(text)));
  const block = renderBlock(proposal, { date: '2026-11-18' });
  const { pageText: newPageText } = insertBlock(pageText, block);
  const result = runGates({ pageText, archiveText, newPageText, newArchiveText: archiveText, proposal });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.delta.droppedSentences, 0);
  assert.deepEqual(result.delta.changedNumbers, []);
  assert.equal(result.delta.lostCaveats, 0);
  assert.equal(result.delta.blockWords, 12);
});

test('G1 blocks a dropped sentence and counts it in the delta', async () => {
  const pageText = await pageFixture('atlas.md');
  const proposal = proposalOf([sentence('The Atlas runtime listens on port 7070.')]);
  const block = renderBlock(proposal, { date: '2026-11-18' });
  const { pageText: newPageText } = insertBlock(pageText, block);
  const dropped = newPageText.replace('The cache limit is 512 MB.\n', '');
  const result = runGates({ pageText, archiveText: '', newPageText: dropped, newArchiveText: '', proposal });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((item) => item.gate === 'G1'));
  assert.equal(result.delta.droppedSentences, 1);
});

test('G2 blocks frontmatter changes except status to disputed with conflicts', async () => {
  const pageText = await pageFixture('atlas.md');
  const archiveText = await pageFixture('atlas-history.md');
  const proposal = proposalOf([sentence('The cache limit is 512 MB.')]);
  const block = renderBlock(proposal, { date: '2026-11-18' });
  const inserted = insertBlock(pageText, block).pageText;

  const shrunk = insertBlock(withStatus(pageText.replace('  - repo:docs/atlas.md\n', ''), 'confirmed'), block).pageText;
  const shrunkResult = runGates({ pageText, archiveText, newPageText: shrunk, newArchiveText: archiveText, proposal });
  assert.equal(shrunkResult.ok, false);
  assert.ok(shrunkResult.failures.some((item) => item.gate === 'G2' && item.detail.includes('sources')));

  const disputed = insertBlock(withStatus(pageText, 'disputed'), block).pageText;
  const disputedResult = runGates({
    pageText,
    archiveText,
    newPageText: disputed,
    newArchiveText: archiveText,
    proposal,
  });
  assert.equal(disputedResult.ok, false);
  assert.ok(disputedResult.failures.some((item) => item.gate === 'G2'));

  const conflictProposal = proposalOf([sentence('The cache limit is 512 MB.')], {
    conflicts: [{ a: 'The cache limit is 512 MB.', b: 'An old note said the cache limit was 128 MB.' }],
  });
  const conflictBlock = renderBlock(conflictProposal, { date: '2026-11-18' });
  const conflictPage = insertBlock(withStatus(pageText, 'disputed'), conflictBlock).pageText;
  const conflictResult = runGates({
    pageText,
    archiveText,
    newPageText: conflictPage,
    newArchiveText: archiveText,
    proposal: conflictProposal,
  });
  assert.deepEqual(conflictResult.failures, []);
  assert.equal(conflictResult.ok, true);

  assert.ok(inserted.includes('<!-- brainatlas:current-state -->'));
});

test('G3 anchors every number, date and version token in a quote that exists verbatim', async () => {
  const pageText = await pageFixture('atlas.md');
  const archiveText = await pageFixture('atlas-history.md');
  const bad = proposalOf([sentence('The cache limit is 512 MB with 8 replicas.', ['The cache limit is 512 MB.'])]);
  const badBlock = renderBlock(bad, { date: '2026-11-18' });
  const badPage = insertBlock(pageText, badBlock).pageText;
  const badResult = runGates({
    pageText,
    archiveText,
    newPageText: badPage,
    newArchiveText: archiveText,
    proposal: bad,
  });
  assert.equal(badResult.ok, false);
  assert.ok(badResult.failures.some((item) => item.gate === 'G3'));
  assert.deepEqual(badResult.delta.changedNumbers, ['8']);

  const missingQuote = proposalOf([sentence('The cache limit is 512 MB.', ['The cache limit is 1024 MB.'])]);
  const missingBlock = renderBlock(missingQuote, { date: '2026-11-18' });
  const missingPage = insertBlock(pageText, missingBlock).pageText;
  const missingResult = runGates({
    pageText,
    archiveText,
    newPageText: missingPage,
    newArchiveText: archiveText,
    proposal: missingQuote,
  });
  assert.ok(missingResult.failures.some((item) => item.gate === 'G3' && item.detail.includes('not found')));
});

test('G4 keeps caveats: a caveat quote needs a caveat sentence and no caveat sentence may be lost', async () => {
  const pageText = await pageFixture('atlas.md');
  const archiveText = await pageFixture('atlas-history.md');
  const quote = 'The failover path is unverified in production.';

  const caveat = proposalOf([sentence('The failover path is documented.', [quote])]);
  const caveatPage = insertBlock(pageText, renderBlock(caveat, { date: '2026-11-18' })).pageText;
  const caveatResult = runGates({
    pageText,
    archiveText,
    newPageText: caveatPage,
    newArchiveText: archiveText,
    proposal: caveat,
  });
  assert.equal(caveatResult.ok, false);
  assert.ok(caveatResult.failures.some((item) => item.gate === 'G4'));
  assert.equal(caveatResult.delta.lostCaveats, 1);

  const proposal = proposalOf([sentence('The Atlas runtime listens on port 7070.')]);
  const droppedPage = insertBlock(pageText, renderBlock(proposal, { date: '2026-11-18' })).pageText.replace(
    `${quote}\n`,
    ''
  );
  const droppedResult = runGates({
    pageText,
    archiveText,
    newPageText: droppedPage,
    newArchiveText: archiveText,
    proposal,
  });
  assert.equal(droppedResult.ok, false);
  assert.ok(droppedResult.failures.some((item) => item.gate === 'G4' && item.detail.includes('caveat sentence lost')));
  assert.equal(droppedResult.delta.lostCaveats, 1);

  const kept = proposalOf([sentence(quote)]);
  const keptPage = insertBlock(pageText, renderBlock(kept, { date: '2026-11-18' })).pageText;
  const keptResult = runGates({
    pageText,
    archiveText,
    newPageText: keptPage,
    newArchiveText: archiveText,
    proposal: kept,
  });
  assert.deepEqual(keptResult.failures, []);
});

test('G5 requires a real conflict, a visible pair and a disputed status', async () => {
  const pageText = await pageFixture('atlas.md');
  const archiveText = await pageFixture('atlas-history.md');
  const conflicts = [{ a: 'The cache limit is 512 MB.', b: 'An old note said the cache limit was 128 MB.' }];
  const proposal = proposalOf([sentence('The cache limit is 512 MB.')], { conflicts });

  const openPage = insertBlock(pageText, renderBlock(proposal, { date: '2026-11-18' })).pageText;
  const openResult = runGates({ pageText, archiveText, newPageText: openPage, newArchiveText: archiveText, proposal });
  assert.equal(openResult.ok, false);
  assert.ok(openResult.failures.some((item) => item.gate === 'G5' && item.detail.includes('disputed')));

  const invented = proposalOf([sentence('The cache limit is 512 MB.')], {
    conflicts: [{ a: 'No such fact.', b: 'Also invented.' }],
  });
  const inventedPage = insertBlock(
    withStatus(pageText, 'disputed'),
    renderBlock(invented, { date: '2026-11-18' })
  ).pageText;
  const inventedResult = runGates({
    pageText,
    archiveText,
    newPageText: inventedPage,
    newArchiveText: archiveText,
    proposal: invented,
  });
  assert.ok(inventedResult.failures.some((item) => item.gate === 'G5' && item.detail.includes('old page')));
});

test('renderBlock matches the fixed marker format', () => {
  const proposal = proposalOf([sentence('A fact.'), sentence('Another fact.')], {
    conflicts: [{ a: 'A fact.', b: 'Another fact.' }],
  });
  assert.equal(
    renderBlock(proposal, { date: '2026-11-18' }),
    [
      '## Current state (proposed 2026-11-18)',
      '<!-- brainatlas:current-state -->',
      '- A fact.',
      '- Another fact.',
      '- Disputed: "A fact." vs "Another fact."',
      '<!-- /brainatlas:current-state -->',
    ].join('\n')
  );
});

test('insertBlock inserts after the first H1 and replaces an embedded block without touching other lines', async () => {
  const pageText = await pageFixture('atlas-with-block.md');
  const proposal = proposalOf([sentence('The cache limit is 512 MB.')]);
  const block = renderBlock(proposal, { date: '2026-11-18' });
  const first = insertBlock(pageText, block);
  assert.deepEqual(first.replaced, [
    '## Current state (proposed 2026-11-01)',
    '<!-- brainatlas:current-state -->',
    '- The Atlas runtime listens on port 7070.',
    '<!-- /brainatlas:current-state -->',
  ]);
  assert.ok(first.pageText.includes('# Atlas Runtime\n\n## Current state (proposed 2026-11-18)'));
  assert.ok(first.pageText.includes('<!-- /brainatlas:current-state -->\n\nThe Atlas runtime listens on port 7070.'));
  assert.equal((first.pageText.match(/<!-- brainatlas:current-state -->/gu) ?? []).length, 1);

  const second = insertBlock(first.pageText, block);
  assert.deepEqual(second.replaced, block.split('\n'));
  assert.equal(second.pageText, first.pageText);

  const original = await pageFixture('atlas.md');
  const fresh = insertBlock(original, block);
  assert.deepEqual(fresh.replaced, []);
  assert.ok(fresh.pageText.includes('# Atlas Runtime\n\n## Current state (proposed 2026-11-18)'));
  assert.equal(fresh.pageText.replace(`${block}\n\n`, ''), original);
});

test('scorePages ranks the fixture vault by the documented score and reasons', async () => {
  const now = new Date('2026-11-18T00:00:00.000Z');
  const report = await runMaintenance(vaultFixture, { now });
  const scored = await scorePages(vaultFixture, { now, report });
  assert.ok(scored.length >= 2);
  for (let index = 1; index < scored.length; index++) assert.ok(scored[index - 1].score >= scored[index].score);

  const atlas = scored.find((entry) => entry.path === 'wiki/concepts/atlas.md');
  assert.ok(atlas);
  assert.ok(atlas.reasons.includes('stale'));
  assert.ok(atlas.reasons.includes('update-sprawl'));
  assert.ok(atlas.reasons.includes('near-duplicate'));
  assert.equal(atlas.score, 2);

  const copy = scored.find((entry) => entry.path === 'wiki/concepts/atlas-copy.md');
  assert.ok(copy);
  assert.ok(copy.reasons.includes('orphan'));
  assert.ok(copy.reasons.includes('near-duplicate'));
  assert.equal(copy.score, 1.5);

  const paths = scored.map((entry) => entry.path);
  assert.ok(paths.indexOf('wiki/concepts/atlas.md') < paths.indexOf('wiki/concepts/atlas-copy.md'));
  assert.ok(!paths.includes('wiki/index.md'));
  assert.ok(!paths.includes('wiki/log.md'));
});

test('scorePages adds words/3000 for an oversized page', async (t) => {
  const vault = await temp(t, 'ba48b-vault-');
  const words = Array.from({ length: 3000 }, () => 'word').join(' ');
  const dated = Array.from({ length: 6 }, (_, index) => `## Update 2026-0${index + 1}-01\n\nsection ${index}`).join(
    '\n'
  );
  await writeFiles(vault, {
    'wiki/index.md': '# Wiki Index\n\n- [Big](big.md)\n',
    'wiki/big.md': `---\ntype: concept\ntitle: Big\nstatus: confirmed\nverified: []\nsources: []\n---\n# Big\n\n${words}\n\n${dated}\n`,
  });
  const now = new Date('2026-11-18T00:00:00.000Z');
  const report = await runMaintenance(vault, { now });
  const [big] = await scorePages(vault, { now, report });
  assert.equal(big.path, 'wiki/big.md');
  assert.ok(big.reasons.includes('oversized'));
  assert.ok(big.reasons.includes('update-sprawl'));
  assert.ok(big.score > 1 && big.score < 2.1);
});

test('selectTargets filters reserved folders, open proposals and recent edits, and caps the list', () => {
  const scored = [
    'raw/a.md',
    'planning/a.md',
    'archive/a.md',
    'inbox/a.md',
    'wiki/archive/a.md',
    'wiki/index.md',
    'wiki/log.md',
    'wiki/concepts/atlas.md',
    'wiki/concepts/copy.md',
    'wiki/concepts/third.md',
    'wiki/concepts/fourth.md',
  ].map((path) => ({ path, score: 1, reasons: [] }));
  const open = ['wiki/concepts/copy.md'];
  const recent = new Set(['wiki/concepts/third.md']);
  const picked = selectTargets(scored, {
    now: new Date(),
    maxPages: 2,
    openProposalPaths: open,
    recentlyEdited: (path) => recent.has(path),
  });
  assert.deepEqual(picked, ['wiki/concepts/atlas.md', 'wiki/concepts/fourth.md']);
  assert.deepEqual(
    selectTargets(scored, { now: new Date(), openProposalPaths: open, recentlyEdited: (path) => recent.has(path) }),
    ['wiki/concepts/atlas.md', 'wiki/concepts/fourth.md']
  );
  for (const maxPages of [0, 4, 1.5, '2']) {
    assert.throws(
      () => selectTargets(scored, { maxPages }),
      (error) => error.code === 'E_ARGUMENT'
    );
  }
});

test('the proposal store saves, lists, expires, reviews and counts open paths and batches', async (t) => {
  const stateDir = await temp(t, 'ba48b-state-');
  const store = createStore(stateDir);
  const record = (page, baseHash, batch, createdAt = '2026-11-01T00:00:00.000Z') => ({
    batch,
    page,
    baseHash,
    createdAt,
    proposal: { schemaVersion: 1, page, sentences: [{ text: 'A fact.', anchors: [anchor('A fact.')] }], conflicts: [] },
    gates: {
      ok: true,
      failures: [],
      delta: { droppedSentences: 0, changedNumbers: [], lostCaveats: 0, blockWords: 2 },
    },
  });

  const first = await store.save(record('wiki/concepts/atlas.md', 'hash-a', 'batch-1'));
  const second = await store.save(record('wiki/concepts/copy.md', 'hash-b', 'batch-2'));
  const third = await store.save(record('wiki/concepts/third.md', 'hash-c', 'batch-1'));
  assert.match(first.id, /^20261101-[0-9a-f]{8}$/u);
  assert.equal(first.expiresAt, '2026-11-15T00:00:00.000Z');
  assert.equal(first.status, 'open');
  assert.notEqual(first.id, second.id);

  const files = await readdir(join(stateDir, 'synthesis', 'proposals'));
  assert.deepEqual(files.sort(), [`${first.id}.json`, `${second.id}.json`, `${third.id}.json`].sort());
  const raw = await readFile(join(stateDir, 'synthesis', 'proposals', `${first.id}.json`), 'utf8');
  assert.ok(!raw.includes('The Atlas runtime listens'));

  assert.deepEqual(await store.openPaths({ now: new Date('2026-11-14T00:00:00.000Z') }), [
    'wiki/concepts/atlas.md',
    'wiki/concepts/copy.md',
    'wiki/concepts/third.md',
  ]);
  assert.equal(await store.unreviewedBatches({ now: new Date('2026-11-14T00:00:00.000Z') }), 2);

  const expired = await store.list({ now: new Date('2026-11-15T00:00:00.000Z') });
  assert.ok(expired.every((item) => item.status === 'expired'));
  const persisted = JSON.parse(await readFile(join(stateDir, 'synthesis', 'proposals', `${first.id}.json`), 'utf8'));
  assert.equal(persisted.status, 'expired');
  assert.deepEqual(await store.openPaths({ now: new Date('2026-11-15T00:00:00.000Z') }), []);
  assert.equal(await store.unreviewedBatches({ now: new Date('2026-11-15T00:00:00.000Z') }), 0);

  const reviewable = await store.save(
    record('wiki/concepts/fourth.md', 'hash-d', 'batch-3', '2026-11-15T00:00:00.000Z')
  );
  const reviewed = await store.markReviewed(reviewable.id, 'accepted');
  assert.equal(reviewed.status, 'accepted');
  assert.equal((await store.get(reviewable.id)).status, 'accepted');
  await assert.rejects(store.markReviewed(reviewable.id, 'maybe'), (error) => error.code === 'E_ARGUMENT');
  await assert.rejects(store.markReviewed(reviewable.id, 'rejected'), (error) => error.code === 'E_PROPOSAL_STATE');
  await assert.rejects(store.markReviewed('nope', 'accepted'), (error) => error.code === 'E_ARGUMENT');
  assert.equal(await store.get('20260101-deadbeef'), null);
  assert.equal(await store.get('../escape'), null);
});

test('G3 matches whole tokens only, and versions ignore one leading v', () => {
  const pageText = [
    '---',
    'type: concept',
    'title: Tokens',
    'status: confirmed',
    'verified: []',
    'sources: []',
    '---',
    '# Tokens',
    '',
    'The cache limit is 512 MB.',
    'Deployment uses v2.4.0-rc.12 today.',
    'The port is 17070.',
    'Version 2.4.0 shipped.',
  ].join('\n');
  const proposal = proposalOf(
    [
      sentence('The cache limit is 5 MB.', ['The cache limit is 512 MB.']),
      sentence('Deployment uses 2.4.0 today.', ['Deployment uses v2.4.0-rc.12 today.']),
      sentence('The port is 7070.', ['The port is 17070.']),
      sentence('Version v2.4.0 shipped.', ['Version 2.4.0 shipped.']),
    ],
    { page: 'wiki/tokens.md' }
  );
  const result = runGates({ pageText, newPageText: pageText, proposal });
  assert.equal(result.ok, false);
  assert.deepEqual(result.delta.changedNumbers, ['5', '2.4.0', '7070']);
  assert.ok(!result.delta.changedNumbers.includes('2.4.0-rc.12'));
  assert.equal(result.failures.filter((item) => item.gate === 'G3').length, 3);
});

test('runGates fails closed with a SCHEMA failure for any invalid proposal', () => {
  const pageText = '---\ntype: concept\ntitle: T\n---\n# T\n\nA fact.\n';
  const base = proposalOf([sentence('A fact.')], { page: 'wiki/t.md' });
  for (const proposal of [
    { ...base, extra: true },
    { ...base, sentences: 'not an array' },
    proposalOf(
      Array.from({ length: 20 }, () => sentence(Array.from({ length: 13 }, () => 'word').join(' '))),
      { page: 'wiki/t.md' }
    ),
  ]) {
    const result = runGates({ pageText, newPageText: pageText, proposal });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].gate, 'SCHEMA');
    assert.equal(typeof result.failures[0].detail, 'string');
  }
});

test('G4 normalises caveat markers across whitespace, hyphens and Turkish letters', () => {
  const pageText = [
    '---',
    'type: concept',
    'title: Caveats',
    'status: confirmed',
    'verified: []',
    'sources: []',
    '---',
    '# Caveats',
    '',
    'The claim is not  verified.',
    'The claim is not-verified.',
    'Bu sonuç DOĞRULANMADI.',
    'The value is BELİRSİZ.',
  ].join('\n');
  const proposal = proposalOf(
    [
      sentence('The claim is documented.', ['The claim is not  verified.']),
      sentence('The claim is documented.', ['The claim is not-verified.']),
      sentence('The claim is documented.', ['Bu sonuç DOĞRULANMADI.']),
      sentence('The value is belirsiz.', ['The value is BELİRSİZ.']),
    ],
    { page: 'wiki/caveats.md' }
  );
  const result = runGates({ pageText, newPageText: pageText, proposal });
  assert.equal(result.ok, false);
  assert.equal(result.failures.filter((item) => item.gate === 'G4').length, 3);
  assert.equal(result.delta.lostCaveats, 3);
  assert.ok(!result.failures.some((item) => item.detail.includes('sentences[3]')));
});

test('insertBlock skips frontmatter and fenced code when looking for the first H1', () => {
  const pageText = [
    '---',
    'type: concept',
    '# this is a yaml comment, not a heading',
    '---',
    '```text',
    '# not a heading either',
    '```',
    '# Real Title',
    '',
    'Body.',
  ].join('\n');
  const block =
    '## Current state (proposed 2026-11-18)\n<!-- brainatlas:current-state -->\n- A fact.\n<!-- /brainatlas:current-state -->';
  const { pageText: inserted } = insertBlock(pageText, block);
  assert.ok(inserted.includes('# this is a yaml comment, not a heading\n---\n```text\n# not a heading either\n```'));
  assert.ok(inserted.includes('# Real Title\n\n## Current state (proposed 2026-11-18)'));
  assert.ok(inserted.indexOf('## Current state') > inserted.indexOf('# Real Title'));
  assert.ok(inserted.indexOf('## Current state') > inserted.indexOf('# not a heading either'));

  const withoutHeading = '---\ntype: concept\n---\nBody only.\n';
  const plain = insertBlock(withoutHeading, block).pageText;
  assert.ok(plain.startsWith('---\ntype: concept\n---\n\n## Current state (proposed 2026-11-18)'));
});

test('markReviewed refuses a proposal that is not open', async (t) => {
  const stateDir = await temp(t, 'ba48b-state-');
  const store = createStore(stateDir);
  const saved = await store.save({
    batch: 'batch-1',
    page: 'wiki/concepts/atlas.md',
    baseHash: 'hash-state',
    createdAt: '2026-11-01T00:00:00.000Z',
    proposal: { schemaVersion: 1, page: 'wiki/concepts/atlas.md', sentences: [sentence('A fact.')], conflicts: [] },
    gates: { ok: true, failures: [], delta: {} },
  });
  await store.markReviewed(saved.id, 'accepted');
  await assert.rejects(store.markReviewed(saved.id, 'rejected'), (error) => error.code === 'E_PROPOSAL_STATE');
  const expired = await store.save({
    batch: 'batch-2',
    page: 'wiki/concepts/copy.md',
    baseHash: 'hash-expired',
    createdAt: '2026-10-01T00:00:00.000Z',
    proposal: { schemaVersion: 1, page: 'wiki/concepts/copy.md', sentences: [sentence('A fact.')], conflicts: [] },
    gates: { ok: true, failures: [], delta: {} },
  });
  await store.list({ now: new Date('2026-11-18T00:00:00.000Z') });
  await assert.rejects(store.markReviewed(expired.id, 'accepted'), (error) => error.code === 'E_PROPOSAL_STATE');
});

test('save never overwrites an id and normalises caller statuses', async (t) => {
  const stateDir = await temp(t, 'ba48b-state-');
  const store = createStore(stateDir);
  const record = (baseHash, status) => ({
    batch: 'batch-1',
    page: 'wiki/concepts/atlas.md',
    baseHash,
    createdAt: '2026-11-01T00:00:00.000Z',
    status,
    proposal: { schemaVersion: 1, page: 'wiki/concepts/atlas.md', sentences: [sentence('A fact.')], conflicts: [] },
    gates: { ok: true, failures: [], delta: {} },
  });

  const first = await store.save(record('hash-same', 'accepted'));
  assert.equal(first.status, 'open');
  await assert.rejects(store.save(record('hash-same', 'accepted')), (error) => error.code === 'E_PROPOSAL_EXISTS');
  assert.equal((await store.save(record('hash-gate', 'gate-failed'))).status, 'gate-failed');
  assert.equal((await store.save(record('hash-schema', 'rejected-schema'))).status, 'rejected-schema');
  assert.equal((await store.save(record('hash-rejected', 'rejected'))).status, 'open');
  assert.equal((await store.save(record('hash-weird', 'expired'))).status, 'open');
});

test('G5 rejects an identical pair and strings shorter than three words', async () => {
  const pageText = await pageFixture('atlas.md');
  const archiveText = await pageFixture('atlas-history.md');
  const proposal = proposalOf([sentence('The cache limit is 512 MB.')], {
    conflicts: [{ a: 'The cache limit is 512 MB.', b: 'The cache limit is 512 MB.' }],
  });
  const disputed = withStatus(pageText, 'disputed');
  const page = insertBlock(disputed, renderBlock(proposal, { date: '2026-11-18' })).pageText;
  const result = runGates({ pageText, archiveText, newPageText: page, newArchiveText: archiveText, proposal });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((item) => item.gate === 'G5' && item.detail.includes('distinct')));

  const short = proposalOf([sentence('The cache limit is 512 MB.')], {
    conflicts: [{ a: 'The cache limit is 512 MB.', b: 'cache limit' }],
  });
  const shortPage = insertBlock(disputed, renderBlock(short, { date: '2026-11-18' })).pageText;
  const shortResult = runGates({
    pageText,
    archiveText,
    newPageText: shortPage,
    newArchiveText: archiveText,
    proposal: short,
  });
  assert.ok(shortResult.failures.some((item) => item.gate === 'G5' && item.detail.includes('distinct')));
});

test('a corrupt proposal record fails the store loudly instead of hiding an open proposal', async (t) => {
  const stateDir = await temp(t, 'ba48b-state-');
  const store = createStore(stateDir);
  assert.deepEqual(await store.list({ now: new Date('2026-11-01T00:00:00.000Z') }), []);
  const directory = join(stateDir, 'synthesis', 'proposals');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '20260101-deadbeef.json'), '{ not json');
  for (const call of [
    () => store.list({ now: new Date('2026-11-01T00:00:00.000Z') }),
    () => store.openPaths({ now: new Date('2026-11-01T00:00:00.000Z') }),
    () => store.unreviewedBatches({ now: new Date('2026-11-01T00:00:00.000Z') }),
    () => store.get('20260101-deadbeef'),
  ]) {
    await assert.rejects(call, (error) => error.code === 'E_STORE_CORRUPT');
  }
});

test('splitSentences joins a wrapped paragraph and still ends list items on their line', () => {
  assert.deepEqual(splitSentences('First line\ncontinues here. Second.'), ['First line continues here.', 'Second.']);
  assert.deepEqual(splitSentences('- first item\n- second item'), ['- first item', '- second item']);
  assert.deepEqual(splitSentences('## A heading without punctuation\n\nBody sentence.'), [
    '## A heading without punctuation',
    'Body sentence.',
  ]);
});

test('scorePages lists only reasons that actually contributed', async (t) => {
  const vault = await temp(t, 'ba48b-vault-');
  await writeFiles(vault, {
    'wiki/index.md': '# Wiki Index\n\n- [Stale](stale.md)\n',
    'wiki/stale.md':
      '---\ntype: concept\ntitle: Stale only\nstatus: confirmed\nverified: []\nsources: []\nstale_after: "2020-01-01"\n---\n# Stale only\n\nA short body without dated sections.\n',
  });
  const now = new Date('2026-11-18T00:00:00.000Z');
  const report = await runMaintenance(vault, { now });
  const scored = await scorePages(vault, { now, report });
  const stale = scored.find((entry) => entry.path === 'wiki/stale.md');
  assert.ok(stale);
  assert.deepEqual(stale.reasons, ['stale']);
  assert.equal(stale.score, 1);
});

test('G4 recognises NFD-encoded Turkish caveat markers', () => {
  const nfd = (value) => value.normalize('NFD');
  const pageText = [
    '---',
    'type: concept',
    'title: NFD caveats',
    'status: confirmed',
    'verified: []',
    'sources: []',
    '---',
    '# NFD caveats',
    '',
    `${nfd('The claim is doğrulanmadı.')}`,
    `${nfd('The claim is çelişkili.')}`,
    `${nfd('The value is belirsiz.')}`,
  ].join('\n');
  const proposal = proposalOf(
    [
      sentence('The claim is documented.', [`${nfd('The claim is doğrulanmadı.')}`]),
      sentence('The claim is documented.', [`${nfd('The claim is çelişkili.')}`]),
      sentence(nfd('The value is belirsiz.'), [`${nfd('The value is belirsiz.')}`]),
    ],
    { page: 'wiki/nfd.md' }
  );
  const result = runGates({ pageText, newPageText: pageText, proposal });
  assert.equal(result.ok, false);
  assert.equal(result.failures.filter((item) => item.gate === 'G4').length, 2);
  assert.equal(result.delta.lostCaveats, 2);
  assert.ok(!result.failures.some((item) => item.detail.includes('sentences[2]')));
});

test('a record whose id does not match its file name is E_STORE_CORRUPT', async (t) => {
  const stateDir = await temp(t, 'ba48b-state-');
  const store = createStore(stateDir);
  const directory = join(stateDir, 'synthesis', 'proposals');
  await mkdir(directory, { recursive: true });
  const record = (id) => ({
    id,
    batch: 'batch-1',
    page: 'wiki/concepts/atlas.md',
    baseHash: 'hash-id',
    createdAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-11-15T00:00:00.000Z',
    status: 'open',
    proposal: { schemaVersion: 1, page: 'wiki/concepts/atlas.md', sentences: [sentence('A fact.')], conflicts: [] },
    gates: { ok: true, failures: [], delta: {} },
  });

  await writeFile(join(directory, '20260101-deadbeef.json'), JSON.stringify(record('20260101-cafebabe')));
  await assert.rejects(
    store.list({ now: new Date('2026-11-18T00:00:00.000Z') }),
    (error) => error.code === 'E_STORE_CORRUPT'
  );
  await assert.rejects(store.get('20260101-deadbeef'), (error) => error.code === 'E_STORE_CORRUPT');

  await writeFile(join(directory, '20260101-deadbeef.json'), JSON.stringify(record('../escape')));
  await assert.rejects(
    store.openPaths({ now: new Date('2026-11-18T00:00:00.000Z') }),
    (error) => error.code === 'E_STORE_CORRUPT'
  );
  await assert.rejects(
    store.unreviewedBatches({ now: new Date('2026-11-18T00:00:00.000Z') }),
    (error) => error.code === 'E_STORE_CORRUPT'
  );

  await writeFile(join(directory, 'evil.json'), JSON.stringify(record('evil')));
  assert.equal(await store.get('evil'), null);
  await assert.rejects(
    store.list({ now: new Date('2026-11-18T00:00:00.000Z') }),
    (error) => error.code === 'E_STORE_CORRUPT'
  );
  assert.deepEqual((await readdir(directory)).sort(), ['20260101-deadbeef.json', 'evil.json']);
});
