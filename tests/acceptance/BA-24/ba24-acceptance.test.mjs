// SPDX-License-Identifier: MIT
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  WT,
  MAIN,
  LONE_SURROGATE,
  QUERIES,
  makeWorkspace,
  loadTree,
  buildIndex,
  startServer,
  oracleSections,
} from './harness.mjs';

const ws = await makeWorkspace();
after(() => rm(ws, { recursive: true, force: true }));
const wt = await loadTree('wt', WT, ws);
const main = await loadTree('main', MAIN, ws);
const trees = [wt, main];

const indexed = new Map();
async function indexDir(tree, slug) {
  const dir = join(tree.stateRoot, slug);
  await buildIndex(tree, dir, ws);
  return dir;
}
async function indexedDir(tree) {
  if (!indexed.has(tree.name)) indexed.set(tree.name, await indexDir(tree, 'indexed'));
  return indexed.get(tree.name);
}
const semMode = (mode) => ({ semantic: { mode } });

const DEGRADED = [
  { name: 'semantic disabled', over: { semantic: { enabled: false } }, index: false, reason: undefined },
  { name: 'module not configured', over: { modules: [] }, index: true, reason: undefined },
  { name: 'lite profile', over: { profile: 'lite' }, index: true, reason: undefined },
  { name: 'provider HTTP error', over: {}, index: true, mode: 'error', reason: 'provider-error' },
  { name: 'provider network throw', over: {}, index: true, mode: 'throw', reason: 'provider-error' },
  {
    name: 'provider timeout',
    over: { semantic: { timeoutMs: 30 } },
    index: true,
    mode: 'hang',
    reason: 'provider-error',
  },
  { name: 'index missing', over: {}, index: false, mode: 'throw', reason: 'index-missing', queries: ['probe'] },
  {
    name: 'fingerprint mismatch',
    over: { semantic: { queryPrefix: 'other prefix | query: ' } },
    index: true,
    mode: 'ok',
    reason: 'fingerprint-mismatch',
  },
  {
    name: 'abstention by minScore',
    over: { semantic: { minScore: 1 } },
    index: true,
    mode: 'ok',
    reason: undefined,
    abstain: true,
  },
];

test('criterion 4: degraded paths answer byte-identically to main', async (t) => {
  for (const scenario of DEGRADED) {
    const queries = scenario.queries ?? ['probe', 'ölçüm', 'roket', 'xyznomatch', 'hata kodu 404'];
    const texts = {};
    for (const tree of trees) {
      const stateDir = scenario.index
        ? await indexDir(tree, `deg-${scenario.name.replace(/\W+/g, '-')}`)
        : join(tree.stateRoot, `none-${scenario.name.replace(/\W+/g, '-')}`);
      const server = await startServer(tree, ws, {
        stateDir,
        over: scenario.over,
        fetchState: { mode: scenario.mode ?? 'ok' },
      });
      try {
        texts[tree.name] = [];
        for (const q of queries) {
          const r = await server.queryRaw(q, { limit: 20 });
          texts[tree.name].push(r.text);
        }
        if (scenario.reason !== undefined) {
          const data = JSON.parse(texts[tree.name][0]);
          assert.equal(
            data.semantic?.fallbackReason,
            scenario.reason,
            `${scenario.name}: wrong path reached in worktree`
          );
          assert.equal(data.semantic?.used, false, `${scenario.name}: semantic must be unused`);
          assert.equal(data.mode, 'lexical', `${scenario.name}: mode must be lexical`);
        }
        if (scenario.abstain) {
          const data = JSON.parse(texts[tree.name][0]);
          assert.equal(data.semantic?.used, true, 'abstention scenario must reach the hybrid module');
          const lexicalServer = await startServer(tree, ws, {
            stateDir: join(tree.stateRoot, 'abstain-lex'),
            over: { semantic: { enabled: false } },
          });
          try {
            const lexical = await lexicalServer.query(queries[0], { limit: 20 });
            assert.deepEqual(
              data.results.map((r) => r.path),
              lexical.results.map((r) => r.path),
              'abstention must answer with the lexical order'
            );
          } finally {
            await lexicalServer.close();
          }
        }
        if (scenario.reason === undefined && !scenario.abstain) {
          const data = JSON.parse(texts[tree.name][0]);
          assert.equal(data.semantic, undefined, `${scenario.name}: response must keep the original shape`);
        }
      } finally {
        await server.close();
      }
    }
    assert.deepEqual(texts.wt, texts.main, `${scenario.name}: worktree output differs from main`);
    t.diagnostic(`${scenario.name}: ${texts.wt.length} responses identical`);
  }
});

test('criterion 3: hybrid result order equals main in rrf and semantic-primary', async (t) => {
  const stateWt = await indexedDir(wt),
    stateMain = await indexedDir(main);
  let hybridAnswers = 0;
  for (const mode of ['semantic-primary', 'rrf']) {
    const a = await startServer(wt, ws, { stateDir: stateWt, over: semMode(mode) });
    const b = await startServer(main, ws, { stateDir: stateMain, over: semMode(mode) });
    try {
      for (const q of QUERIES) {
        const x = await a.query(q, { limit: 20 }),
          y = await b.query(q, { limit: 20 });
        assert.deepEqual(
          x.results.map((r) => r.path),
          y.results.map((r) => r.path),
          `${mode} order differs for "${q}"`
        );
        assert.equal(x.abstained, y.abstained, `${mode} abstention differs for "${q}"`);
        assert.deepEqual(x.semantic, y.semantic, `${mode} semantic status differs for "${q}"`);
        assert.equal(x.mode, y.mode, `${mode} mode field differs for "${q}"`);
        if (x.semantic?.used === true && !x.abstained) hybridAnswers++;
      }
    } finally {
      await a.close();
      await b.close();
    }
  }
  assert.ok(hybridAnswers >= 30, `too few hybrid answers to test ordering: ${hybridAnswers}`);
  t.diagnostic(`hybrid answers compared: ${hybridAnswers}`);
});

test('criterion 3: score is the active mode key, non-increasing, extra fields only added', async (t) => {
  const stateWt = await indexedDir(wt),
    stateMain = await indexedDir(main);
  for (const mode of ['semantic-primary', 'rrf']) {
    const a = await startServer(wt, ws, { stateDir: stateWt, over: semMode(mode) });
    const b = await startServer(main, ws, { stateDir: stateMain, over: semMode(mode) });
    try {
      for (const q of QUERIES) {
        const x = await a.query(q, { limit: 20 }),
          y = await b.query(q, { limit: 20 });
        if (x.semantic?.used !== true || x.abstained) continue;
        const results = x.results;
        for (const [i, r] of results.entries()) {
          assert.equal(typeof r.rrfScore, 'number', `${mode} "${q}" #${i}: rrfScore must always be present`);
          if (mode === 'rrf') assert.equal(r.score, r.rrfScore, `${mode} "${q}" #${i}: score must equal rrfScore`);
          else
            assert.equal(
              r.score,
              r.semanticScore ?? 0,
              `${mode} "${q}" #${i}: score must equal semanticScore (0 when lexical-only)`
            );
          if (r.semanticScore !== undefined) assert.equal(typeof r.semanticScore, 'number');
          for (const key of Object.keys(y.results[i]))
            assert.ok(key in r, `${mode} "${q}" #${i}: main key ${key} missing`);
          for (const key of Object.keys(r)) {
            const known = Object.keys(y.results[i]).includes(key) || key === 'rrfScore' || key === 'semanticScore';
            assert.ok(known, `${mode} "${q}" #${i}: unexpected key ${key}`);
          }
          if (i > 0) assert.ok(r.score <= results[i - 1].score, `${mode} "${q}" #${i}: score must not increase`);
        }
        if (mode === 'semantic-primary') {
          const firstLexicalOnly = results.findIndex((r) => r.semanticScore === undefined);
          if (firstLexicalOnly >= 0)
            assert.ok(
              results.slice(firstLexicalOnly).every((r) => r.semanticScore === undefined),
              `${q}: lexical-only hits must come last`
            );
        }
      }
    } finally {
      await a.close();
      await b.close();
    }
  }
  t.diagnostic('score contract checked in both modes');
});

async function anchorViolations(tree, stateDir) {
  const lex = await startServer(tree, ws, {
    stateDir: join(tree.stateRoot, 'anchor-lex'),
    over: { semantic: { enabled: false } },
  });
  const modes = [];
  for (const mode of ['semantic-primary', 'rrf'])
    modes.push({ mode, server: await startServer(tree, ws, { stateDir, over: semMode(mode) }) });
  const sections = new Map();
  const sectionsOf = async (path) => {
    if (!sections.has(path))
      sections.set(path, oracleSections((await lex.call('wiki_read_page', { path })).data.content));
    return sections.get(path);
  };
  const violations = [];
  try {
    for (const q of QUERIES) {
      const lexical = await lex.query(q, { limit: 20 });
      const lexByPath = new Map(lexical.results.map((r) => [r.path, r]));
      for (const { mode, server } of modes) {
        const hybrid = await server.query(q, { limit: 20 });
        if (hybrid.semantic?.used !== true || hybrid.abstained) continue;
        for (const r of hybrid.results) {
          if (!('heading' in r)) continue;
          const where = `${mode} "${q}" ${r.path}`;
          const oracle = await sectionsOf(r.path);
          if (r.anchor === null || r.anchor === undefined) {
            if (r.heading !== null && !oracle.some((s) => s.heading === r.heading))
              violations.push(`${where}: heading "${r.heading}" not a page heading`);
          } else if (
            !oracle.some((s) => s.heading === r.heading && s.anchor === r.anchor && s.headingPath === r.headingPath)
          ) {
            violations.push(`${where}: anchor "${r.anchor}" for "${r.heading}" (${r.headingPath}) not in core rule`);
          }
          const lr = lexByPath.get(r.path);
          if (lr)
            for (const key of ['heading', 'anchor', 'headingPath']) {
              if ((lr[key] ?? null) !== (r[key] ?? null))
                violations.push(`${where}: ${key} "${r[key]}" differs from lexical "${lr[key]}"`);
            }
        }
      }
    }
  } finally {
    await lex.close();
    for (const { server } of modes) await server.close();
  }
  return violations;
}

test('criterion 1: hybrid section anchors follow the core rule and agree with lexical', async (t) => {
  const violations = await anchorViolations(wt, await indexedDir(wt));
  assert.deepEqual(violations, []);
  t.diagnostic('anchor oracle and lexical agreement checked for all queries in both modes');
});

test('criterion 1: explicit Turkish, repeated and emoji headings get the expected anchors', async () => {
  const lex = await startServer(wt, ws, {
    stateDir: join(wt.stateRoot, 'explicit-lex'),
    over: { semantic: { enabled: false } },
  });
  const sp = await startServer(wt, ws, { stateDir: await indexedDir(wt), over: semMode('semantic-primary') });
  try {
    const cases = [
      ['üçüncü', 'tr/cozum.md', 'Ölçüm Notları', 'olcum-notlari-2', 'Çözüm Ağacı > Ölçüm Notları'],
      ['tekrarlanan', 'tr/cozum.md', 'Ölçüm Notları', 'olcum-notlari-1', 'Çözüm Ağacı > Ölçüm Notları'],
    ];
    for (const [q, path, heading, anchor, headingPath] of cases) {
      const lr = (await lex.query(q, { limit: 20 })).results.find((r) => r.path === path);
      assert.ok(lr, `lexical answer for "${q}" lacks ${path}`);
      assert.deepEqual(
        [lr.heading, lr.anchor, lr.headingPath],
        [heading, anchor, headingPath],
        `lexical anchor for "${q}"`
      );
      const hr = (await sp.query(q, { limit: 20 })).results.find((r) => r.path === path);
      if (hr)
        assert.deepEqual(
          [hr.heading, hr.anchor, hr.headingPath],
          [heading, anchor, headingPath],
          `hybrid anchor for "${q}"`
        );
      // eslint-disable-next-line no-undef -- the outer test callback has no `t`; keeping this branch a hard failure avoids masking a regression
      else t.diagnostic(`hybrid did not return ${path} for "${q}" (not a defect by itself)`);
    }
    const emoji = (await sp.query('symbol', { limit: 20 })).results.find((r) => r.path === 'emoji/astral.md');
    if (emoji) assert.doesNotMatch(emoji.anchor ?? '', /\p{Extended_Pictographic}/u);
  } finally {
    await lex.close();
    await sp.close();
  }
});

async function snippetViolations(tree, stateDir, mode, budgets) {
  const out = { lone: [], overBudget: [], notPrefix: [], exercised: 0 };
  const full = await startServer(tree, ws, {
    stateDir,
    over: { ...semMode(mode), retrieval: { budgetChars: 4000, abstainThreshold: 0.35 } },
  });
  const fullByQuery = new Map();
  const probeQueries = ['kesim', 'roket astral', 'probe', 'notlar', 'symbol'];
  try {
    for (const q of probeQueries)
      fullByQuery.set(
        q,
        (await full.query(q, { limit: 20 })).results.map((r) => [r.path, r.snippet])
      );
  } finally {
    await full.close();
  }
  for (const b of budgets) {
    const server = await startServer(tree, ws, {
      stateDir,
      over: { ...semMode(mode), retrieval: { budgetChars: b, abstainThreshold: 0.35 } },
    });
    try {
      for (const q of probeQueries) {
        const data = await server.query(q, { limit: 20 });
        const hybrid = data.semantic?.used === true && !data.abstained;
        let total = 0;
        const fullMap = new Map(fullByQuery.get(q));
        if (
          q === 'kesim' &&
          hybrid &&
          data.results[0]?.path === 'emoji/kesim.md' &&
          data.results[0].snippet.length === b &&
          b > 0
        )
          out.exercised++;
        for (const r of data.results) {
          total += r.snippet.length;
          if (LONE_SURROGATE.test(r.snippet)) out.lone.push(`${mode} b=${b} "${q}" ${r.path}`);
          if (hybrid && fullMap.has(r.path) && !fullMap.get(r.path).startsWith(r.snippet))
            out.notPrefix.push(`${mode} b=${b} "${q}" ${r.path}`);
        }
        if (hybrid && total > b) out.overBudget.push(`${mode} b=${b} "${q}" total=${total}`);
      }
    } finally {
      await server.close();
    }
  }
  return out;
}

test('criterion 2: no lone surrogate in any snippet at any budget (hybrid and lexical)', async (t) => {
  const budgets = Array.from({ length: 71 }, (_, i) => i);
  const stateDir = await indexedDir(wt);
  for (const mode of ['semantic-primary', 'rrf']) {
    const v = await snippetViolations(wt, stateDir, mode, budgets);
    assert.deepEqual(v.lone, [], `lone surrogate snippets (${mode})`);
    assert.deepEqual(v.overBudget, [], `hybrid snippets over budget (${mode})`);
    assert.deepEqual(v.notPrefix, [], `hybrid snippets not a prefix of the full snippet (${mode})`);
    assert.ok(
      v.exercised >= 20,
      `emoji snippet was cut at only ${v.exercised} budgets (${mode}); fixture does not exercise the cut`
    );
  }
  const lexServer = async (b) =>
    startServer(wt, ws, {
      stateDir: join(wt.stateRoot, 'snip-lex'),
      over: { semantic: { enabled: false }, retrieval: { budgetChars: b, abstainThreshold: 0.35 } },
    });
  for (const b of budgets) {
    const server = await lexServer(b);
    try {
      for (const q of ['roket astral', 'probe', 'notlar', 'symbol']) {
        const data = await server.query(q, { limit: 20 });
        for (const r of data.results)
          assert.equal(LONE_SURROGATE.test(r.snippet), false, `lexical b=${b} "${q}" ${r.path}`);
      }
    } finally {
      await server.close();
    }
  }
  t.diagnostic(`budgets 0..70 checked for both modes and lexical`);
});

test('criterion 5: stale is the same on the hybrid and lexical paths and matches the expected truth', async (t) => {
  const expected = {
    'tr/cozum.md': true,
    'stale/expired-quoted.md': true,
    'stale/expired-unquoted.md': true,
    'stale/pnd-expired.md': true,
    'stale/future.md': false,
    'stale/pnd-fresh.md': false,
    'stale/undated.md': false,
  };
  for (const tree of trees) {
    const lex = await startServer(tree, ws, {
      stateDir: join(tree.stateRoot, 'stale-lex'),
      over: { semantic: { enabled: false } },
    });
    const sp = await startServer(tree, ws, { stateDir: await indexedDir(tree), over: semMode('semantic-primary') });
    const rrf = await startServer(tree, ws, { stateDir: await indexedDir(tree), over: semMode('rrf') });
    try {
      const lexical = new Map((await lex.query('probe', { limit: 20 })).results.map((r) => [r.path, r.stale]));
      for (const server of [sp, rrf]) {
        const hybrid = await server.query('probe', { limit: 20 });
        assert.equal(hybrid.semantic?.used, true, `${tree.name} hybrid must answer for stale check`);
        const hmap = new Map(hybrid.results.map((r) => [r.path, r.stale]));
        for (const [path, value] of Object.entries(expected)) {
          assert.ok(hmap.has(path), `${tree.name}: ${path} missing from hybrid results`);
          assert.equal(hmap.get(path), value, `${tree.name} ${server.config.semantic.mode}: stale for ${path}`);
          assert.equal(lexical.get(path), value, `${tree.name} lexical: stale for ${path}`);
        }
        for (const [path, value] of hmap)
          if (lexical.has(path)) assert.equal(value, lexical.get(path), `${tree.name}: stale differs for ${path}`);
      }
    } finally {
      await lex.close();
      await sp.close();
      await rrf.close();
    }
  }
  t.diagnostic('stale checked for expired quoted/unquoted/PnD, future, PnD fresh, undated');
});

test('criterion 5: a single stale() definition remains in product code', () => {
  let out = '';
  try {
    out = execFileSync(
      'grep',
      ['-rnE', 'function stale\\s*\\(', 'packages', 'modules', '--include=*.mjs', '--exclude-dir=node_modules'],
      { cwd: WT, encoding: 'utf8' }
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const defs = out.split('\n').filter(Boolean);
  assert.equal(defs.length, 1, `stale definitions:\n${defs.join('\n')}`);
  assert.match(defs[0], /^packages\/core\/src\/retrieval\/index\.mjs:/);
});

test('baseline (informational): main on the same fixture', async (t) => {
  const stateMain = await indexedDir(main);
  const anchors = await anchorViolations(main, stateMain);
  const surrogates = await snippetViolations(
    main,
    stateMain,
    'semantic-primary',
    Array.from({ length: 71 }, (_, i) => i)
  );
  t.diagnostic(`main anchor violations: ${anchors.length}${anchors[0] ? ` (first: ${anchors[0]})` : ''}`);
  t.diagnostic(
    `main lone-surrogate snippets: ${surrogates.lone.length}${surrogates.lone[0] ? ` (first: ${surrogates.lone[0]})` : ''}`
  );
});
