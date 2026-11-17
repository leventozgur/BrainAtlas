// SPDX-License-Identifier: MIT
// BA-41: incremental index update must equal a from-scratch build (spec items 1-6).
// Oracle: a searcher built from the same vault with a new stateDir. Run against another tree with BA_ROOT=<tree>.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.BA_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const mod = await import(pathToFileURL(path.join(root, 'packages/core/src/retrieval/index.mjs')).href);
const { createSearcher, buildIndex, loadPagesDetailed, search } = mod;

const now = new Date('2026-03-01T00:00:00Z');
const EXCLUDE = ['excl/**', '**/*.draft.md'];
const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});
function tempRoot(prefix = 'ba41v') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  tmpRoots.push(dir);
  const vault = path.join(dir, 'vault'),
    state = path.join(dir, 'state');
  fs.mkdirSync(vault);
  return { dir, vault, state };
}

// ---------------- deterministik rastgele ----------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
];
const QUERIES = [
  ['alpha', { limit: 10 }],
  ['alpha bravo', { limit: 10 }],
  ['delta echo foxtrot', { limit: 20 }],
  ['golf heading', { limit: 5 }],
  ['hotel india juliet', { limit: 10, abstainThreshold: 0.3 }],
  ['zzqxunknown', {}],
  ['E_ERR_3 kilo', { limit: 10 }],
  ['lima mike november oscar', { limit: 3 }],
  ['verified papa', { limit: 10 }],
  ['title0 alpha', { limit: 10 }],
];

// ---------------- sayfa modeli ----------------
let clock = 1_800_000_000; // monoton artan mtime (saniye)
function stamp(file) {
  clock += 1;
  fs.utimesSync(file, clock, clock);
}
function render(m, self) {
  if (m.broken) return `---\ntitle: ${m.title}\ntitle: duplicate\n---\n# ${m.title}\nbroken ${m.words.join(' ')}\n`;
  const fm = [];
  if (m.hasTitle) fm.push(`title: ${m.title}`);
  if (m.aliases.length) fm.push(`aliases: [${m.aliases.join(', ')}]`);
  if (m.keywords.length) fm.push(`keywords: [${m.keywords.join(', ')}]`);
  if (m.status) fm.push(`status: ${m.status}`);
  if (m.verified === 'valid')
    fm.push(
      'verified:',
      '  - date: "2026-01-15"',
      '    evidence: unit test',
      '    scope: retrieval',
      '    source: tests'
    );
  if (m.verified === 'invalid') fm.push('verified:', '  - date: "2026-13-45"', '    evidence: x');
  if (m.supersededBy) fm.push(`superseded_by: ${m.supersededBy}`);
  if (m.never) fm.push('inject: never');
  if (m.stale) fm.push('stale_after: P1D', 'generated: "2020-01-01"');
  const head = fm.length ? `---\n${fm.join('\n')}\n---\n` : '';
  const links = m.links.map((n) => `See [[${n}]] for more.`);
  const md = m.mdLinks.map((p) => `Read [doc](${path.posix.relative(path.posix.dirname(self), p)}).`);
  return `${head}# ${m.title}\n\n${m.words.join(' ')} ${m.ident ? `E_ERR_${m.ident}` : ''}\n\n${links.join('\n')}\n${md.join('\n')}\n\n## Section ${m.words[0]}\n${m.words.slice(0, 4).join(' ')} ${m.words.slice(2).join(' ')}\n`;
}
const nameOf = (p) => path.posix.basename(p, '.md');

class Vault {
  constructor(vault, r) {
    this.vault = vault;
    this.r = r;
    this.pages = new Map();
    this.counter = 0;
    this.edits = 0;
    this.log = [];
  }
  pick(list) {
    return list[Math.floor(this.r() * list.length)];
  }
  words(n = 3 + Math.floor(this.r() * 6)) {
    return Array.from({ length: n }, () => this.pick(WORDS));
  }
  freshModel() {
    const r = this.r;
    return {
      title: `title${Math.floor(r() * 6)} ${this.pick(WORDS)}`,
      hasTitle: r() < 0.7,
      aliases: r() < 0.2 ? [this.pick(WORDS)] : [],
      keywords: r() < 0.25 ? [this.pick(WORDS), this.pick(WORDS)] : [],
      status: r() < 0.4 ? this.pick(['active', 'confirmed', 'proposed', 'disputed']) : null,
      verified: r() < 0.3 ? this.pick(['valid', 'invalid']) : null,
      supersededBy: null,
      never: r() < 0.05,
      stale: r() < 0.15,
      words: this.words(),
      links: [],
      mdLinks: [],
      ident: r() < 0.3 ? Math.floor(r() * 5) : 0,
      broken: false,
    };
  }
  newPath() {
    const dir = this.pick(['', '', 'sub/', 'sub/', 'excl/']);
    const suffix = this.r() < 0.08 ? '.draft' : '';
    return `${dir}p${this.counter++}${suffix}.md`;
  }
  write(p) {
    const file = path.join(this.vault, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, render(this.pages.get(p), p));
    stamp(file);
  }
  paths() {
    return [...this.pages.keys()].sort();
  }
  add() {
    const p = this.newPath();
    this.pages.set(p, this.freshModel());
    this.write(p);
    this.log.push(`add ${p}`);
  }
  apply(kind) {
    const ps = this.paths();
    if (!ps.length && kind !== 'add') kind = 'add';
    const r = this.r,
      p = ps.length ? this.pick(ps) : null,
      m = p && this.pages.get(p);
    switch (kind) {
      case 'add':
        this.add();
        break;
      case 'delete':
        fs.rmSync(path.join(this.vault, p));
        this.pages.delete(p);
        this.log.push(`delete ${p}`);
        break;
      case 'content':
        m.words = this.words();
        m.ident = r() < 0.3 ? Math.floor(r() * 5) : 0;
        this.write(p);
        this.log.push(`content ${p}`);
        break;
      case 'frontmatter':
        Object.assign(m, {
          title: `title${Math.floor(r() * 6)} ${this.pick(WORDS)}`,
          hasTitle: r() < 0.7,
          aliases: r() < 0.3 ? [this.pick(WORDS)] : [],
          keywords: r() < 0.3 ? [this.pick(WORDS)] : [],
          never: r() < 0.1,
          stale: r() < 0.3,
        });
        this.write(p);
        this.log.push(`frontmatter ${p}`);
        break;
      case 'rename': {
        const to = this.newPath();
        fs.mkdirSync(path.dirname(path.join(this.vault, to)), { recursive: true });
        fs.renameSync(path.join(this.vault, p), path.join(this.vault, to));
        this.pages.set(to, m);
        this.pages.delete(p);
        for (const o of this.pages.values()) {
          o.links = o.links.map((n) => (n === nameOf(p) ? nameOf(to) : n));
          o.mdLinks = o.mdLinks.filter((x) => x !== p);
          if (o.supersededBy === p) o.supersededBy = to;
        }
        this.log.push(`rename ${p} -> ${to}`);
        if (r() < 0.5) {
          this.write(to);
          for (const [q] of this.pages) if (q !== to && r() < 0.4) this.write(q);
        }
        break;
      }
      case 'linkadd': {
        const t = this.pick(ps);
        m.links.push(nameOf(t));
        if (r() < 0.4) m.mdLinks.push(t);
        this.write(p);
        this.log.push(`linkadd ${p} -> ${t}`);
        break;
      }
      case 'linkrm':
        m.links.pop();
        m.mdLinks.pop();
        this.write(p);
        this.log.push(`linkrm ${p}`);
        break;
      case 'supersede': {
        m.status = r() < 0.7 ? 'superseded' : m.status;
        m.supersededBy = this.pick(ps);
        this.write(p);
        this.log.push(`supersede ${p} -> ${m.supersededBy}`);
        break;
      }
      case 'unsupersede':
        m.supersededBy = null;
        if (m.status === 'superseded') m.status = 'active';
        this.write(p);
        this.log.push(`unsupersede ${p}`);
        break;
      case 'deletetarget': {
        const targets = ps.filter((q) => [...this.pages.values()].some((o) => o.supersededBy === q));
        const t = targets.length ? this.pick(targets) : p;
        fs.rmSync(path.join(this.vault, t));
        this.pages.delete(t);
        this.log.push(`deletetarget ${t}`);
        break;
      }
      case 'trust':
        m.status = this.pick(['confirmed', 'proposed', 'disputed', 'active', null]);
        m.verified = this.pick(['valid', 'invalid', null]);
        this.write(p);
        this.log.push(`trust ${p}`);
        break;
      case 'break':
        m.broken = true;
        this.write(p);
        this.log.push(`break ${p}`);
        break;
      case 'restore': {
        const hit = [...this.pages].find(([, o]) => o.broken);
        if (!hit) return this.apply('content');
        hit[1].broken = false;
        this.write(hit[0]);
        this.log.push(`restore ${hit[0]}`);
        break;
      }
      case 'excludeio': {
        const base = path.posix.basename(p),
          to = p.startsWith('excl/') ? `${this.r() < 0.5 ? '' : 'sub/'}x${this.counter++}${base}` : `excl/${base}`;
        if (this.pages.has(to)) return this.apply('add');
        fs.mkdirSync(path.dirname(path.join(this.vault, to)), { recursive: true });
        fs.renameSync(path.join(this.vault, p), path.join(this.vault, to));
        this.pages.set(to, m);
        this.pages.delete(p);
        for (const o of this.pages.values()) {
          o.links = o.links.map((n) => (n === nameOf(p) ? nameOf(to) : n));
          o.mdLinks = o.mdLinks.filter((x) => x !== p);
          if (o.supersededBy === p) o.supersededBy = to;
        }
        this.log.push(`excludeio ${p} -> ${to}`);
        break;
      }
      case 'clear':
        for (const q of ps) fs.rmSync(path.join(this.vault, q));
        this.pages.clear();
        this.log.push('clear');
        this.add();
        break;
      default:
        throw new Error(kind);
    }
    this.edits++;
  }
  step() {
    const r = this.r,
      roll = r();
    const kinds = [
      ['add', 0.14],
      ['delete', 0.08],
      ['content', 0.16],
      ['frontmatter', 0.08],
      ['rename', 0.07],
      ['linkadd', 0.1],
      ['linkrm', 0.05],
      ['supersede', 0.06],
      ['unsupersede', 0.03],
      ['deletetarget', 0.03],
      ['trust', 0.06],
      ['break', 0.04],
      ['restore', 0.04],
      ['excludeio', 0.05],
      ['clear', 0.01],
    ];
    let acc = 0,
      kind = 'content';
    for (const [k, w] of kinds) {
      acc += w;
      if (roll < acc) {
        kind = k;
        break;
      }
    }
    if (this.pages.size > 42 && kind === 'add') kind = 'delete';
    const times = r() < 0.15 ? 2 + Math.floor(r() * 3) : 1; // ayni duzenlemede birden cok sayfa
    for (let i = 0; i < times; i++) this.apply(i === 0 ? kind : kinds[Math.floor(r() * (kinds.length - 1))][0]);
  }
}

// ---------------- esdegerlik ----------------
const entries = (o) => (o instanceof Map ? [...o.entries()] : Object.entries(o ?? {}));
const plain = (v) => JSON.parse(JSON.stringify(v));
function normIndex(index) {
  const docs = index.docs;
  const pathOf = (id) => docs[id].page.path;
  const out = {
    version: index.version,
    now: index.now,
    averages: index.averages,
    docCount: docs.length,
    docs: docs
      .map((d) => ({
        path: d.page.path,
        lengths: d.lengths,
        trust: d.trust,
        restricted: d.restricted === true,
        excluded: d.excluded === true,
        page: plain(d.page),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    supersedes: Object.fromEntries(
      entries(index.supersedes)
        .map(([k, v]) => [k, [...v]])
        .sort(([a], [b]) => (a < b ? -1 : 1))
    ),
    postings: {},
    exact: {},
    links: {},
  };
  for (const [term, list] of entries(index.postings).sort(([a], [b]) => (a < b ? -1 : 1))) {
    let items = list;
    if (typeof list[0] === 'number') {
      items = [];
      for (let i = 0; i < list.length; i += 5) items.push([list[i], list.slice(i + 1, i + 5)]);
    }
    out.postings[term] = items.map(([id, counts]) => [pathOf(id), [...counts]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  for (const [key, ids] of entries(index.exact).sort(([a], [b]) => (a < b ? -1 : 1)))
    out.exact[key] = ids.map(pathOf).sort();
  const links = entries(index.links)
    .map(([id, ns]) => [pathOf(Number(id)), ns.map(pathOf).sort()])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  out.links = Object.fromEntries(links);
  // df ve doc sayisi ayrica acik alan olarak (spec madde 1 listesi)
  out.df = Object.fromEntries(Object.entries(out.postings).map(([t, l]) => [t, l.length]));
  return out;
}
const normPages = (pages) => plain([...pages].sort((a, b) => (a.path < b.path ? -1 : 1)));
const coverage = {
  related: 0,
  supersedes: 0,
  verified: 0,
  weak: 0,
  never: 0,
  abstained: 0,
  linkVia: 0,
  results: 0,
  stale: 0,
  brokenSteps: 0,
  empty: 0,
};
function recordCoverage(out) {
  if (out.abstained) coverage.abstained++;
  if (!out.results.length) coverage.empty++;
  for (const r of out.results) {
    coverage.results++;
    if (r.related) coverage.related++;
    if (r.supersedes) coverage.supersedes++;
    if (r.trust === 'verified') coverage.verified++;
    if (r.trust === 'weak') coverage.weak++;
    if (r.inject === 'never') coverage.never++;
    if (r.via === 'link') coverage.linkVia++;
    if (r.stale) coverage.stale++;
  }
}
let freshSeq = 0;
function freshSearcher(vault, base, exclude) {
  const sd = path.join(base, `fresh-${freshSeq++}`);
  const s = createSearcher({ vaultDir: vault, stateDir: sd, now, ...(exclude ? { exclude } : {}) });
  return { s, done: () => fs.rmSync(sd, { recursive: true, force: true }) };
}
function assertEquivalent(inc, vault, base, exclude, label, { snapshot = true, second = false } = {}) {
  const { s: oracle, done } = freshSearcher(vault, base, exclude);
  try {
    for (const [q, opts] of QUERIES) {
      const got = inc.search(q, opts);
      recordCoverage(got);
      assert.deepStrictEqual(got, oracle.search(q, opts), `${label}: search "${q}"`);
    }
    if (snapshot) {
      const a = inc.snapshot(),
        b = oracle.snapshot();
      assert.deepStrictEqual(normIndex(a.index), normIndex(b.index), `${label}: snapshot().index`);
      assert.deepStrictEqual(normPages(a.pages), normPages(b.pages), `${label}: snapshot().pages`);
    }
    if (second) {
      const idx = buildIndex(loadPagesDetailed(vault).pages, { now, ...(exclude ? { exclude } : {}) });
      for (const [q, opts] of QUERIES)
        assert.deepStrictEqual(
          inc.search(q, opts),
          search(idx, q, opts),
          `${label}: search "${q}" (buildIndex oracle)`
        );
    }
  } finally {
    done();
  }
}

// ---------------- okuma/yazma izleme ----------------
function trackReads(t, roots) {
  const seen = [];
  const note = (p) => {
    if (typeof p === 'string' && /\.md$/iu.test(p) && roots.some((r) => p === r || p.startsWith(r + path.sep)))
      seen.push(
        path
          .relative(
            roots.find((r) => p.startsWith(r)),
            p
          )
          .split(path.sep)
          .join('/')
      );
  };
  const rf = fs.readFileSync,
    op = fs.openSync;
  const m1 = t.mock.method(fs, 'readFileSync', function (...a) {
    note(a[0]);
    return rf.apply(this, a);
  });
  const m2 = t.mock.method(fs, 'openSync', function (...a) {
    note(a[0]);
    return op.apply(this, a);
  });
  return {
    seen,
    stop() {
      m1.mock.restore();
      m2.mock.restore();
    },
  };
}
function dirDigest(dir) {
  const out = {};
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name),
        r = rel + e.name;
      if (e.isDirectory()) walk(p, r + '/');
      else {
        const st = fs.statSync(p);
        out[r] = [st.size, st.mtimeMs, st.ino, createHash('sha256').update(fs.readFileSync(p)).digest('hex')].join(':');
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
function seedVault(v, n) {
  for (let i = 0; i < n; i++) v.add();
}

// ================= seeded random edit sequences (smaller than the acceptance run) =================
for (const [seed, steps, exclude, size] of [
  [9001, 130, EXCLUDE, 24],
  [9002, 90, undefined, 18],
]) {
  test(`random edits seed ${seed}: incremental equals fresh after every edit (${steps} edits)`, () => {
    const { dir, vault, state } = tempRoot();
    const v = new Vault(vault, rng(seed));
    seedVault(v, size);
    const inc = createSearcher({ vaultDir: vault, stateDir: state, now, ...(exclude ? { exclude } : {}) });
    assertEquivalent(inc, vault, dir, exclude, 'start');
    for (let step = 1; step <= steps; step++) {
      const mark = v.log.length;
      v.step();
      const label = `seed ${seed} step ${step} [${v.log.slice(mark).join(' | ')}]`;
      assert.equal(inc.refreshIfChanged(), true, `${label}: change reported`);
      assert.equal(inc.refreshIfChanged(), false, `${label}: second check is false`);
      assertEquivalent(inc, vault, dir, exclude, label, { snapshot: step % 2 === 0, second: step % 15 === 0 });
    }
    // a new process on the same stateDir agrees as well
    assertEquivalent(
      createSearcher({ vaultDir: vault, stateDir: state, now, ...(exclude ? { exclude } : {}) }),
      vault,
      dir,
      exclude,
      'new process'
    );
  });
}

// ================= unchanged vault =================
test('unchanged vault: refreshIfChanged is false, no page is read, the state directory is untouched', (t) => {
  const { vault, state } = tempRoot();
  const v = new Vault(vault, rng(5));
  seedVault(v, 10);
  const s = createSearcher({ vaultDir: vault, stateDir: state, now });
  const before = dirDigest(state);
  const tr = trackReads(t, [vault]);
  try {
    for (let i = 0; i < 3; i++) assert.equal(s.refreshIfChanged(), false);
    s.search('alpha');
  } finally {
    tr.stop();
  }
  assert.deepEqual(tr.seen, []);
  assert.deepStrictEqual(dirDigest(state), before);
});

// ================= changed vault reads only what changed =================
function readsOnly(name, seed, mutate) {
  test(`changed vault (${name}) reads only the changed or added pages`, (t) => {
    const { dir, vault, state } = tempRoot();
    const v = new Vault(vault, rng(seed));
    seedVault(v, 24);
    const s = createSearcher({ vaultDir: vault, stateDir: state, now });
    const allowed = new Set(mutate(v));
    const tr = trackReads(t, [vault]);
    try {
      assert.equal(s.refreshIfChanged(), true);
    } finally {
      tr.stop();
    }
    assert.deepEqual(
      [...new Set(tr.seen)].filter((p) => !allowed.has(p)),
      []
    );
    assertEquivalent(s, vault, dir, undefined, name);
  });
}
readsOnly('content edit', 71, (v) => {
  const p = v.paths()[4];
  v.pages.get(p).words = ['quartz', 'quartz'];
  v.write(p);
  return [p];
});
readsOnly('add and delete', 72, (v) => {
  const p = v.paths()[6];
  fs.rmSync(path.join(v.vault, p));
  v.pages.delete(p);
  v.add();
  return [v.log.at(-1).slice(4)];
});
readsOnly('link added to a neighbour', 73, (v) => {
  const [a, b] = [v.paths()[1], v.paths()[9]];
  v.pages.get(a).links.push(nameOf(b));
  v.write(a);
  return [a];
});

test('a new process after an edit starts from the cache and reads only the changed page', (t) => {
  const { dir, vault, state } = tempRoot();
  const v = new Vault(vault, rng(74));
  seedVault(v, 20);
  createSearcher({ vaultDir: vault, stateDir: state, now });
  const p = v.paths()[3];
  v.pages.get(p).words = ['yankee'];
  v.write(p);
  const tr = trackReads(t, [vault]);
  let s;
  try {
    s = createSearcher({ vaultDir: vault, stateDir: state, now });
  } finally {
    tr.stop();
  }
  assert.deepEqual(
    [...new Set(tr.seen)].filter((x) => x !== p),
    []
  );
  assertEquivalent(s, vault, dir, undefined, 'new process');
});

// ================= caches =================
test('corrupt, foreign, stale and structurally invalid caches rebuild to an equivalent result', () => {
  const { dir, vault, state } = tempRoot();
  const v = new Vault(vault, rng(81));
  seedVault(v, 14);
  createSearcher({ vaultDir: vault, stateDir: state, now });
  const target = fs.readdirSync(state).map((f) => path.join(state, f))[0];
  const good = fs.readFileSync(target, 'utf8');
  const data = JSON.parse(good);
  const variants = [
    '',
    '{"broken":',
    '[]',
    'null',
    '{}',
    good.slice(0, good.length >> 1),
    JSON.stringify({ ...data, foreign: [1, 2, 3] }),
    ...Object.keys(data).map((k) => JSON.stringify({ ...data, [k]: null })),
  ];
  for (const [i, text] of variants.entries()) {
    fs.writeFileSync(target, text);
    assertEquivalent(createSearcher({ vaultDir: vault, stateDir: state, now }), vault, dir, undefined, `variant ${i}`, {
      snapshot: i % 2 === 0,
    });
  }
  // stale: an older cache restored after more edits
  fs.writeFileSync(target, good);
  for (let i = 0; i < 6; i++) v.step();
  assertEquivalent(createSearcher({ vaultDir: vault, stateDir: state, now }), vault, dir, undefined, 'stale cache');
});

test('an unwritable state directory does not stop search, and nothing is written into the vault', () => {
  const { dir, vault } = tempRoot();
  const v = new Vault(vault, rng(82));
  seedVault(v, 8);
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'file');
  const s = createSearcher({ vaultDir: vault, stateDir: path.join(blocked, 'x'), now });
  for (let i = 0; i < 4; i++) {
    v.step();
    assert.equal(s.refreshIfChanged(), true);
    assertEquivalent(s, vault, dir, undefined, `step ${i}`);
  }
  assert.deepEqual(Object.keys(dirDigest(vault)).sort(), v.paths());
});

// ================= specific edit kinds =================
function mk(dir, rel, text) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  stamp(f);
}

test('valid frontmatter -> broken -> valid: the broken page behaves as if absent, then returns', () => {
  const { dir, vault, state } = tempRoot();
  mk(vault, 'a.md', '# A\nquokka alpha');
  mk(vault, 'b.md', '---\ntitle: B\n---\n# B\nquokka bravo bravo');
  const s = createSearcher({ vaultDir: vault, stateDir: state, now });
  mk(vault, 'b.md', '---\ntitle: B\ntitle: again\n---\n# B\nquokka bravo bravo');
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(
    s.search('quokka', { limit: 5 }).results.map((r) => r.path),
    ['a.md']
  );
  assertEquivalent(s, vault, dir, undefined, 'broken');
  mk(vault, 'b.md', '---\ntitle: B\n---\n# B\nquokka bravo bravo');
  assert.equal(s.refreshIfChanged(), true);
  assert.equal(s.search('quokka', { limit: 5 }).results.length, 2);
  assertEquivalent(s, vault, dir, undefined, 'valid again');
});

test('superseded chain: deleting the final target and restoring it', () => {
  const { dir, vault, state } = tempRoot();
  mk(vault, 'a.md', '---\nstatus: superseded\nsuperseded_by: b.md\n---\n# A\nzinc a');
  mk(vault, 'b.md', '---\nstatus: superseded\nsuperseded_by: c.md\n---\n# B\nzinc b');
  mk(vault, 'c.md', '# C\nzinc c');
  const s = createSearcher({ vaultDir: vault, stateDir: state, now });
  assert.deepEqual(s.search('zinc c', { limit: 3 }).results[0].supersedes, ['a.md', 'b.md']);
  fs.rmSync(path.join(vault, 'c.md'));
  assert.equal(s.refreshIfChanged(), true);
  assertEquivalent(s, vault, dir, undefined, 'target deleted');
  mk(vault, 'c.md', '# C\nzinc c');
  assert.equal(s.refreshIfChanged(), true);
  assertEquivalent(s, vault, dir, undefined, 'target restored');
  assert.deepEqual(s.search('zinc c', { limit: 3 }).results[0].supersedes, ['a.md', 'b.md']);
});

test('a page moving into and out of the exclude rule stays in the statistics but leaves the results', () => {
  const { dir, vault, state } = tempRoot();
  mk(vault, 'a.md', '# A\nsaffron one');
  mk(vault, 'b.md', '# B\nsaffron two');
  const s = createSearcher({ vaultDir: vault, stateDir: state, now, exclude: EXCLUDE });
  fs.mkdirSync(path.join(vault, 'excl'));
  fs.renameSync(path.join(vault, 'b.md'), path.join(vault, 'excl/b.md'));
  assert.equal(s.refreshIfChanged(), true);
  assert.deepEqual(
    s.search('saffron', { limit: 5 }).results.map((r) => r.path),
    ['a.md']
  );
  assert.equal(s.snapshot().index.docs.length, 2);
  assertEquivalent(s, vault, dir, EXCLUDE, 'moved in');
  fs.renameSync(path.join(vault, 'excl/b.md'), path.join(vault, 'b.md'));
  assert.equal(s.refreshIfChanged(), true);
  assert.equal(s.search('saffron', { limit: 5 }).results.length, 2);
  assertEquivalent(s, vault, dir, EXCLUDE, 'moved out');
});

test('empty vault <-> single page', () => {
  const { dir, vault, state } = tempRoot();
  const s = createSearcher({ vaultDir: vault, stateDir: state, now });
  mk(vault, 'only.md', '# Only\nsolitary');
  assert.equal(s.refreshIfChanged(), true);
  assertEquivalent(s, vault, dir, undefined, 'one page');
  fs.rmSync(path.join(vault, 'only.md'));
  assert.equal(s.refreshIfChanged(), true);
  assertEquivalent(s, vault, dir, undefined, 'empty again');
});
