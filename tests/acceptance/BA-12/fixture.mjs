// SPDX-License-Identifier: MIT
// BA-12 blind acceptance fixture: a seeded defective vault built at test time (no repo files are read or copied).
// Seeds are defects with a known kind and page. Companions and allowed findings are not scored as false positives.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MARKER = 'BA12MARK-7f3a-body-only';
export const KINDS = ['stale', 'superseded-broken', 'broken-link', 'orphan', 'index-missing', 'index-stale', 'oversized', 'update-sprawl'];

// key: a short target string expected in the finding's detail (for broken-link and index-stale).
// path: vault-relative path of the page or index that holds the defect.
export const SEEDS = [
  { id: 'stale-date', kind: 'stale', path: 'wiki/concepts/st-date.md' },
  { id: 'stale-pnd', kind: 'stale', path: 'wiki/concepts/st-pnd.md' },
  { id: 'stale-pnw', kind: 'stale', path: 'wiki/entities/st-pnw.md' },
  { id: 'stale-timestamp', kind: 'stale', path: 'wiki/sources/st-ts.md' },
  { id: 'stale-unquoted', kind: 'stale', path: 'wiki/summaries/st-unquoted.md' },
  { id: 'sup-no-field', kind: 'superseded-broken', path: 'wiki/concepts/sup-no-field.md' },
  { id: 'sup-no-target', kind: 'superseded-broken', path: 'wiki/concepts/sup-no-target.md' },
  { id: 'sup-replacement-superseded', kind: 'superseded-broken', path: 'wiki/concepts/sup-chain-a.md' },
  { id: 'sup-loop-a', kind: 'superseded-broken', path: 'wiki/concepts/loop-a.md' },
  { id: 'sup-loop-b', kind: 'superseded-broken', path: 'wiki/concepts/loop-b.md' },
  { id: 'link-wikilink-missing', kind: 'broken-link', path: 'wiki/concepts/bl-wiki.md', key: 'zz-no-such-page' },
  { id: 'link-relative-missing', kind: 'broken-link', path: 'wiki/entities/bl-rel.md', key: 'zz-gone' },
  { id: 'link-anchor-target-missing', kind: 'broken-link', path: 'wiki/concepts/bl-anchor.md', key: 'zz-absent' },
  { id: 'link-wikilink-ambiguous', kind: 'broken-link', path: 'wiki/sources/bl-amb.md', key: 'dupname' },
  { id: 'orphan-1', kind: 'orphan', path: 'wiki/concepts/orph-1.md' },
  { id: 'orphan-2', kind: 'orphan', path: 'wiki/entities/orph-2.md' },
  { id: 'orphan-3', kind: 'orphan', path: 'wiki/summaries/orph-3.md' },
  { id: 'index-missing-1', kind: 'index-missing', path: 'wiki/concepts/im-1.md' },
  { id: 'index-missing-2', kind: 'index-missing', path: 'wiki/entities/im-2.md' },
  { id: 'index-missing-3', kind: 'index-missing', path: 'wiki/sources/im-3.md' },
  { id: 'index-stale-1', kind: 'index-stale', path: 'wiki/index.md', key: 'zz-removed' },
  { id: 'index-stale-2', kind: 'index-stale', path: 'wiki/index.md', key: 'zz-old-name' },
  { id: 'index-stale-3', kind: 'index-stale', path: 'wiki/index.md', key: 'zz-gone' },
  { id: 'oversized-1', kind: 'oversized', path: 'wiki/concepts/big-1.md' },
  { id: 'oversized-2', kind: 'oversized', path: 'wiki/entities/big-2.md' },
  { id: 'oversized-3', kind: 'oversized', path: 'wiki/sources/big-3.md' },
  { id: 'sprawl-6', kind: 'update-sprawl', path: 'wiki/concepts/us-6.md' },
  { id: 'sprawl-8-mixed', kind: 'update-sprawl', path: 'wiki/entities/us-8.md' },
  { id: 'sprawl-6-summary', kind: 'update-sprawl', path: 'wiki/summaries/us-6b.md' },
];

// Companion findings that the contract implies for an orphan page (an orphan is also not in the index).
export const COMPANIONS = [
  { kind: 'index-missing', path: 'wiki/concepts/orph-1.md' },
  { kind: 'index-missing', path: 'wiki/entities/orph-2.md' },
  { kind: 'index-missing', path: 'wiki/summaries/orph-3.md' },
];

// Hard case: linked from a hub but not in the index. The contract says index-missing applies; it must NOT be an orphan.
// Scored neither way (the brief lists it as a non-defect, the contract as index-missing). Reported separately.
export const AMBIGUOUS = [{ kind: 'index-missing', path: 'wiki/summaries/hn-linked-unindexed.md' }];

// Pages that must produce no finding at all (hard negatives).
export const CLEAN_PATHS = [
  'wiki/concepts/c-ok-1.md','wiki/concepts/c-ok-2.md', 'wiki/concepts/c-successor.md', 'wiki/concepts/st-future.md',
  'wiki/concepts/paren(x).md', 'wiki/entities/angle page.md', 'wiki/entities/e-ok.md', 'wiki/sources/s-ok.md',
  'wiki/concepts/dupname.md', 'wiki/entities/dupname.md', 'wiki/concepts/sup-chain-b.md', 'wiki/concepts/big-ok.md',
  'wiki/sources/us-5.md',
];

/** Content pages in the seeded vault (index and log excluded). */
export const contentPageCount = () => PAGES.length;

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'kappa', 'sigma', 'omega', 'vector', 'graph', 'note'];

function words(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(WORDS[i % WORDS.length]);
    if (i % 40 === 39) out.push('\n');
  }
  return out.join(' ');
}

function frontmatter({ type, status = 'proposed', generated = '"2026-10-01"', stale = '"2999-12-31"', superseded }) {
  const lines = [
    '---',
    `type: ${type}`,
    `generated: ${generated}`,
    `status: ${status}`,
    'sources:',
    '  - raw/synthetic-source.md',
    'verified: []',
    `stale_after: ${stale}`,
    'aliases: []',
    'keywords: []',
  ];
  if (superseded !== undefined) lines.push(`superseded_by: ${superseded}`);
  lines.push('---', '');
  return lines.join('\n');
}

const dated = (n, prefix) => Array.from({ length: n }, (_, i) => `## ${prefix} 2026-03-0${i + 1}: synthetic note\n\nShort dated text ${i + 1}.\n`).join('\n');

const HUB_BODY = [
  'Hub page with synthetic links. Marker ' + MARKER + '.',
  '',
  'Alias wikilink: [[c-ok-2|Alias label]]. Anchored wikilink: [[c-ok-2#intro]]. Anchored relative: [anchor](c-ok-2.md#sec).',
  'Non-markdown: [pdf](../../raw/file.pdf). External: [ext](https://example.com/missing.md).',
  'Leaves the vault: [outside](../../../../../../../../../outside-vault.md).',
  '',
  '```text',
  '[[no-fence-target]] and [gone](gone-in-fence.md)',
  '```',
  '',
  'Inline code: `[[no-inline-target]]`.',
  '',
  'Seeded pages linked here: [[st-date]] [[st-pnd]] [[st-pnw]] [[st-ts]] [[st-unquoted]] [[sup-no-field]] [[sup-no-target]]',
  '[[sup-chain-a]] [[sup-chain-b]] [[loop-a]] [[loop-b]] [[bl-wiki]] [[bl-anchor]] [[im-1]] [[im-2]] [[im-3]]',
  '[[big-1]] [[big-2]] [[big-3]] [[us-6]] [[us-8]] [[us-6b]] [[c-successor]] [[st-future]] [[big-ok]] [[us-5]] [[e-ok]] [[s-ok]] [[angle page]]',
  '[relative](../entities/bl-rel.md) [hn](../summaries/hn-linked-unindexed.md) [dupname](dupname.md) [dup entity](../entities/dupname.md) [paren](paren(x).md)',
].join('\n');

const PAGES = [
  // Hub and clean pages
  { path: 'concepts/c-ok-1.md', title: 'Hub', fm: { type: 'concept' }, body: HUB_BODY },
  { path: 'concepts/c-ok-2.md', title: 'C OK 2', fm: { type: 'concept' }, body: '## Intro\n\nClean text.\n\n## Sec\n\nMore clean text.' },
  { path: 'concepts/c-successor.md', title: 'Successor', fm: { type: 'concept' }, body: 'Replacement page.' },
  { path: 'concepts/st-future.md', title: 'Future', fm: { type: 'concept', generated: '"2999-01-01"', stale: 'P30D' }, body: 'Future generated date, not expired.' },
  { path: 'concepts/paren(x).md', title: 'Paren file', fm: { type: 'concept' }, body: 'Escaped name page.' },
  { path: 'entities/angle page.md', title: 'Angle page', fm: { type: 'entity' }, body: 'Spaced name page.' },
  { path: 'entities/e-ok.md', title: 'E OK', fm: { type: 'entity' }, body: 'Clean entity.' },
  { path: 'sources/s-ok.md', title: 'S OK', fm: { type: 'source' }, body: 'Clean source.' },
  { path: 'concepts/dupname.md', title: 'Dup concept', fm: { type: 'concept' }, body: 'Concept with a duplicated file name.' },
  { path: 'entities/dupname.md', title: 'Dup entity', fm: { type: 'entity' }, body: 'Entity with a duplicated file name.' },
  { path: 'concepts/sup-chain-b.md', title: 'Chain B', fm: { type: 'concept', status: 'superseded', superseded: 'wiki/concepts/c-successor.md' }, body: 'Valid superseded page.' },
  { path: 'concepts/big-ok.md', title: 'Big OK', fm: { type: 'concept' }, body: words(2500) },
  { path: 'sources/us-5.md', title: 'US 5', fm: { type: 'source' }, body: dated(5, 'Update') + '\nThe word Update appears in ordinary text here.' },
  { path: 'summaries/hn-linked-unindexed.md', title: 'HN linked', fm: { type: 'summary' }, body: 'Linked from the hub but not in the index.' },

  // Stale seeds
  { path: 'concepts/st-date.md', title: 'Stale date', fm: { type: 'concept', stale: '"2000-01-01"' }, body: 'Expired date.' },
  { path: 'concepts/st-pnd.md', title: 'Stale PnD', fm: { type: 'concept', generated: '"2000-01-01"', stale: 'P30D' }, body: 'Expired duration in days.' },
  { path: 'entities/st-pnw.md', title: 'Stale PnW', fm: { type: 'entity', generated: '"2000-01-01"', stale: 'P2W' }, body: 'Expired duration in weeks.' },
  { path: 'sources/st-ts.md', title: 'Stale timestamp', fm: { type: 'source', stale: '"2000-01-01T00:00:00Z"' }, body: 'Expired timestamp.' },
  { path: 'summaries/st-unquoted.md', title: 'Stale unquoted', fm: { type: 'summary', stale: '2000-01-01' }, body: 'Expired unquoted date.' },

  // Superseded seeds
  { path: 'concepts/sup-no-field.md', title: 'No field', fm: { type: 'concept', status: 'superseded' }, body: 'Superseded with no successor field.' },
  { path: 'concepts/sup-no-target.md', title: 'No target', fm: { type: 'concept', status: 'superseded', superseded: 'wiki/concepts/does-not-exist.md' }, body: 'Successor is missing.' },
  { path: 'concepts/sup-chain-a.md', title: 'Chain A', fm: { type: 'concept', status: 'superseded', superseded: 'wiki/concepts/sup-chain-b.md' }, body: 'Successor is itself superseded.' },
  { path: 'concepts/loop-a.md', title: 'Loop A', fm: { type: 'concept', status: 'superseded', superseded: 'wiki/concepts/loop-b.md' }, body: 'Loop member.' },
  { path: 'concepts/loop-b.md', title: 'Loop B', fm: { type: 'concept', status: 'superseded', superseded: 'wiki/concepts/loop-a.md' }, body: 'Loop member.' },

  // Broken link seeds
  { path: 'concepts/bl-wiki.md', title: 'BL wiki', fm: { type: 'concept' }, body: 'Broken wikilink: [[zz-no-such-page]].' },
  { path: 'entities/bl-rel.md', title: 'BL rel', fm: { type: 'entity' }, body: 'Broken relative link: [gone](../concepts/zz-gone.md).' },
  { path: 'concepts/bl-anchor.md', title: 'BL anchor', fm: { type: 'concept' }, body: 'Missing target with anchor: [gone part](../sources/zz-absent.md#part).' },
  { path: 'sources/bl-amb.md', title: 'BL ambiguous', fm: { type: 'source' }, body: 'Ambiguous wikilink: [[dupname]].' },

  // Orphans (not linked, not indexed)
  { path: 'concepts/orph-1.md', title: 'Orphan 1', fm: { type: 'concept' }, body: 'Nothing links here.' },
  { path: 'entities/orph-2.md', title: 'Orphan 2', fm: { type: 'entity' }, body: 'Nothing links here.' },
  { path: 'summaries/orph-3.md', title: 'Orphan 3', fm: { type: 'summary' }, body: 'Nothing links here.' },

  // Index-missing seeds (linked from the hub, not indexed)
  { path: 'concepts/im-1.md', title: 'IM 1', fm: { type: 'concept' }, body: 'Linked but not indexed.' },
  { path: 'entities/im-2.md', title: 'IM 2', fm: { type: 'entity' }, body: 'Linked but not indexed.' },
  { path: 'sources/im-3.md', title: 'IM 3', fm: { type: 'source' }, body: 'Linked but not indexed.' },

  // Oversized seeds
  { path: 'concepts/big-1.md', title: 'Big 1', fm: { type: 'concept' }, body: `${MARKER} ${words(3400)}` },
  { path: 'entities/big-2.md', title: 'Big 2', fm: { type: 'entity' }, body: words(3400) },
  { path: 'sources/big-3.md', title: 'Big 3', fm: { type: 'source' }, body: words(3400) },

  // Update sprawl seeds
  { path: 'concepts/us-6.md', title: 'US 6', fm: { type: 'concept' }, body: `${MARKER}\n\n${dated(6, 'Update')}` },
  {
    path: 'entities/us-8.md', title: 'US 8', fm: { type: 'entity' },
    body: Array.from({ length: 8 }, (_, i) => `## ${i % 2 ? 'Update' : 'Güncelleme'} 2026-04-0${i + 1}: synthetic note\n\nText ${i + 1}.\n`).join('\n'),
  },
  { path: 'summaries/us-6b.md', title: 'US 6b', fm: { type: 'summary' }, body: dated(6, 'Update') },
];

const INDEX = [
  '# Wiki index',
  '',
  '## Pages',
  '- [Hub](concepts/c-ok-1.md)',
  '- [C OK 2](concepts/c-ok-2.md#intro)',
  '- [Successor](concepts/c-successor.md)',
  '- [Future](concepts/st-future.md)',
  '- [Paren](concepts/paren\\(x\\).md)',
  '- [Angle](<entities/angle page.md>)',
  '- [E OK](entities/e-ok.md)',
  '- [S OK](sources/s-ok.md)',
  '- [Dup concept](concepts/dupname.md)',
  '- [Dup entity](entities/dupname.md)',
  '- [Chain B](concepts/sup-chain-b.md)',
  '- [Big OK](concepts/big-ok.md)',
  '- [US 5](sources/us-5.md)',
  '- [Stale date](concepts/st-date.md)',
  '- [Stale PnD](concepts/st-pnd.md)',
  '- [Stale PnW](entities/st-pnw.md)',
  '- [Stale timestamp](sources/st-ts.md)',
  '- [Stale unquoted](summaries/st-unquoted.md)',
  '- [No field](concepts/sup-no-field.md)',
  '- [No target](concepts/sup-no-target.md)',
  '- [Chain A](concepts/sup-chain-a.md)',
  '- [Loop A](concepts/loop-a.md)',
  '- [Loop B](concepts/loop-b.md)',
  '- [BL wiki](concepts/bl-wiki.md)',
  '- [BL rel](entities/bl-rel.md)',
  '- [BL anchor](concepts/bl-anchor.md)',
  '- [BL ambiguous](sources/bl-amb.md)',
  '- [Big 1](concepts/big-1.md)',
  '- [Big 2](entities/big-2.md)',
  '- [Big 3](sources/big-3.md)',
  '- [US 6](concepts/us-6.md)',
  '- [US 8](entities/us-8.md)',
  '- [US 6b](summaries/us-6b.md)',
  '- [Removed](concepts/zz-removed.md)',
  '- [Old name](entities/zz-old-name.md)',
  '- [Gone part](sources/zz-gone.md#part)',
  '',
  '```text',
  '- [Fake fenced](concepts/zz-fenced-fake.md)',
  '```',
  '',
].join('\n');

function renderPage(p) {
  return `${frontmatter(p.fm)}# ${p.title}\n\n${p.body}\n`;
}

/** Write the seeded defective vault under `root` (creates root/wiki). */
export function buildSeededVault(root) {
  const wiki = join(root, 'wiki');
  for (const p of PAGES) {
    const file = join(wiki, p.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPage(p));
  }
  writeFileSync(join(wiki, 'index.md'), INDEX);
  writeFileSync(join(wiki, 'log.md'), '# Log\n\n- synthetic seed\n');
  return root;
}

/** Scoring. Returns { seeds, detected, perKind, falsePositives, companionsSeen, ambiguousSeen, totalFindings, strictFp }. */
export function score(findings) {
  const used = new Set();
  const matchOf = (seed, pass) => findings.findIndex((f, i) => {
    if (used.has(i) || f.kind !== seed.kind) return false;
    if (pass === 1) return f.path === seed.path || (seed.key !== undefined && JSON.stringify(f.detail ?? '').includes(seed.key)) || (seed.key !== undefined && f.path.includes(seed.key));
    return f.path === seed.path;
  });
  const seedHit = new Map();
  for (const seed of SEEDS) {
    let idx = matchOf(seed, 1);
    if (idx < 0) idx = matchOf(seed, 2);
    if (idx >= 0) { used.add(idx); seedHit.set(seed.id, findings[idx]); }
  }
  const isIn = (list, f) => list.some((x) => x.kind === f.kind && x.path === f.path);
  const perKind = Object.fromEntries(KINDS.map((k) => [k, { seeds: 0, detected: 0, falsePositives: 0 }]));
  for (const seed of SEEDS) { perKind[seed.kind].seeds += 1; if (seedHit.has(seed.id)) perKind[seed.kind].detected += 1; }
  const falsePositives = []; const companionsSeen = []; const ambiguousSeen = [];
  findings.forEach((f, i) => {
    if (used.has(i)) return;
    if (isIn(COMPANIONS, f)) { companionsSeen.push(f); return; }
    if (isIn(AMBIGUOUS, f)) { ambiguousSeen.push(f); return; }
    falsePositives.push(f);
    if (perKind[f.kind]) perKind[f.kind].falsePositives += 1;
  });
  const detected = seedHit.size;
  return {
    seeds: SEEDS.length,
    detected,
    perKind,
    falsePositives,
    companionsSeen,
    ambiguousSeen,
    missed: SEEDS.filter((s) => !seedHit.has(s.id)).map((s) => s.id),
    totalFindings: findings.length,
    strictFp: falsePositives.length + companionsSeen.length,
  };
}

/** Synthetic large vault: n pages, all indexed and chained, with one broken wikilink every 100 pages. */
export function buildLargeVault(root, n) {
  const wiki = join(root, 'wiki');
  mkdirSync(wiki, { recursive: true });
  const index = ['# Wiki index', ''];
  for (let i = 0; i < n; i += 1) {
    const rel = `concepts/p${String(i).padStart(4, '0')}.md`;
    const next = i + 1 < n ? `[[p${String(i + 1).padStart(4, '0')}]]` : '';
    const broken = i % 100 === 99 ? ' [[zz-broken-large]]' : '';
    const body = `Page ${i} body with some words for measurement. ${next}${broken}\n`;
    mkdirSync(join(wiki, 'concepts'), { recursive: true });
    writeFileSync(join(wiki, rel), `${frontmatter({ type: 'concept' })}# P ${i}\n\n${body}`);
    index.push(`- [P ${i}](${rel})`);
  }
  writeFileSync(join(wiki, 'index.md'), `${index.join('\n')}\n`);
  return { pages: n, expectedBroken: Math.floor(n / 100) };
}
