// SPDX-License-Identifier: MIT
// BA-02 shared case generator: deterministic synthetic vault (no network), fixed fake provider.
// runHybridCases(root) returns sha256 digests of every output so two code trees can be compared byte-for-byte.
// Digests are key-order independent (object keys are sorted before hashing).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])]));
  return x;
}
const h = (s) => createHash('sha256').update(s).digest('hex');
function seedOf(text) { let s = 2166136261; for (const c of text) s = Math.imul(s ^ c.charCodeAt(0), 16777619) >>> 0; return s || 1; }

export async function runHybridCases(root, { pages: n = 300 } = {}) {
  const R = resolve(root);
  const retrieval = await import(join(R, 'packages/core/src/retrieval/index.mjs'));
  const hybrid = await import(join(R, 'modules/semantic/src/hybrid.mjs'));
  const synth = await import(join(R, 'eval/lib/synthetic-corpus.mjs'));
  const base = mkdtempSync(join(tmpdir(), 'ba02-cases-'));
  try {
    const vault = join(base, 'vault'), stateDir = join(base, 'state');
    mkdirSync(vault); mkdirSync(stateDir);
    const { paths, queries } = synth.writeSyntheticCorpus(vault, { pages: n, seed: 7, queryCount: 40 });
    // Edge pages: superseded (must be excluded), stale_after in the past (stale flag), aliases/keywords, empty body.
    writeFileSync(join(vault, 'superseded-note.md'), '---\ntitle: Superseded note\nstatus: superseded\nsuperseded_by: wiki/x.md\n---\n# Superseded\ntopic-zero word one two\n');
    writeFileSync(join(vault, 'stale-note.md'), '---\ntitle: Stale note\nstatus: active\ngenerated: "2020-01-01"\nstale_after: P1D\naliases: [oldname]\nkeywords: [legacy]\n---\n# Stale\n## Part\nlegacy content here\n');
    writeFileSync(join(vault, 'empty-note.md'), '---\ntitle: Empty\n---\n');
    const lexicalPages = retrieval.loadPages(vault);
    const relPaths = lexicalPages.map((p) => p.path);
    const vectors = synth.fixedVectors(7, relPaths.length, 8);
    const entries = relPaths.map((path, i) => ({ path, vector: vectors[i], text: path, headingPath: 'Top > Part' }));
    entries.push({ path: 'superseded-note.md', vector: vectors[0], text: 'x', headingPath: '' });
    entries.push({ path: 'missing-page.md', vector: vectors[1], text: 'x', headingPath: '' });
    entries.push({ path: relPaths[2], vector: [0, 0, 0, 0, 0, 0, 0, 0], text: 'zero', headingPath: '' });
    const providerFor = (q, variant) => {
      if (variant === 'fail') return { fingerprint: 'ba02-golden', embedQuery: async () => { throw new Error('boom'); } };
      return { fingerprint: 'ba02-golden', embedQuery: async () => synth.fixedVectors(seedOf(q), 1, 8)[0] };
    };
    const queryList = [...queries.slice(0, 25), '', '   ', 'the and', 'zzzqqq nothing', 'legacy', 'oldname', 'Top Part', 'topic-zero word'];
    const optionSets = [
      { limit: 5 }, { limit: 1, mode: 'semantic-primary' }, { limit: 5, minSemanticScore: 0.2 },
      { limit: 5, minMargin: 0.05 }, { limit: 3, abstainThreshold: 0.5 }, { limit: 5, weights: [2, 1], k: 10 },
      { limit: 0 }, { limit: 5, minSemanticScore: 0.99, minMargin: 0.5 },
    ];
    const asOf = new Date('2026-02-01T00:00:00Z');
    const lexicalIndex = retrieval.buildIndex(lexicalPages, { now: new Date('2026-02-01T00:00:00Z') });
    const lines = { core: [], plain: [], indexed: [] };
    const hasSnapshot = typeof retrieval.createSearcher === 'function';
    const searcher = retrieval.createSearcher({ vaultDir: vault, stateDir, now: new Date('2026-02-01T00:00:00Z') });
    for (const q of queryList) {
      for (const opts of optionSets) {
        lines.core.push(JSON.stringify(canon({ q, opts, out: retrieval.search(lexicalIndex, q, { ...opts, asOf }) })));
        lines.core.push(JSON.stringify(canon({ q, opts, viaSearcher: searcher.search(q, { ...opts, asOf }) })));
        for (const variant of ['ok', 'fail']) {
          for (const meta of [undefined, { providerFingerprint: 'other' }]) {
            const provider = providerFor(q, variant);
            const common = { query: q, entries, provider, indexMeta: meta, asOf, ...opts };
            const run = async (extra) => {
              const out = await hybrid.searchHybrid({ ...common, ...extra });
              return canon({ q, opts, variant, meta: meta ? 'mismatch' : 'none', abstained: out.abstained ?? false, reason: out.reason ?? null,
                fallbackReason: out.fallbackReason ?? null, results: out.map((r) => ({ ...r })) });
            };
            lines.plain.push(JSON.stringify(await run({ pages: lexicalPages })));
            if (hasSnapshot && searcher.snapshot) {
              const snap = searcher.snapshot();
              lines.indexed.push(JSON.stringify(await run({ pages: snap.pages, lexicalIndex: snap.index })));
            } else {
              lines.indexed.push(JSON.stringify(await run({ pages: lexicalPages, lexicalIndex })));
            }
          }
        }
      }
    }
    // Also exercise a fingerprint-matching path (indexMeta equal to provider fingerprint).
    const matchMeta = { providerFingerprint: 'ba02-golden' };
    lines.plain.push(JSON.stringify(canon(await hybrid.searchHybrid({ query: queryList[0], pages: lexicalPages, entries, provider: providerFor('', 'ok'), indexMeta: matchMeta, asOf, limit: 5 }))));
    return {
      caseCount: lines.plain.length,
      core: h(lines.core.join('\n')), plain: h(lines.plain.join('\n')), indexed: h(lines.indexed.join('\n')),
      pageCount: lexicalPages.length, supportsSnapshot: Boolean(hasSnapshot && searcher.snapshot),
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await runHybridCases(process.argv[2] ?? '.')));
}
