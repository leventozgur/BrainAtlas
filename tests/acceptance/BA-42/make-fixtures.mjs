// SPDX-License-Identifier: MIT
// BA-42 independent blind acceptance fixture generator. Written from the brief only; the developer's ba42 tests were not read.
// Deterministic: running it again rewrites identical bytes. It writes ./fixtures (vaults, fake repository), fixtures/labels.json
// (ground truth, produced before any product run) and fixtures/MANIFEST.json (sha256 freeze of every fixture file).
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const DEMO_SRC = resolve(HERE, '../../../demo-vault');
const N = (s) => String(s).normalize('NFC');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hexN = (seed, n) => {
  let s = '';
  for (let i = 0; s.length < n; i++) s += sha(`${seed}#${i}`);
  return s.slice(0, n);
};
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const COMMIT = /^[0-9a-f]{7,64}$/iu;
const WORD = '[\\p{L}\\p{N}_]';
const stripCommit = (ref) => {
  const at = ref.lastIndexOf('@');
  return at > 0 && COMMIT.test(ref.slice(at + 1)) ? ref.slice(0, at) : ref;
};
const containsWord = (text, name) =>
  new RegExp(`(?<!${WORD})${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?!${WORD})`, 'u').test(text);

// ---- Fake repository: path -> exported symbols (text is generated from these; old names never appear in it).
const REPO = new Map(
  Object.entries({
    'services/billing/invoice.ts': ['createInvoice', 'calcTax', 'issueCredit'],
    'services/billing/tax_rules.ts': ['calcVatRate', 'applyDiscount2'],
    'services/billing/ledger01.ts': ['postEntry', 'reconcileBatch'],
    'services/billing/refund/service.ts': ['refundPayment', 'settleRefund'],
    'services/auth/session.py': ['issue_token', 'validate_token', 'end_session'],
    'services/auth/policy.py': ['evaluate_policy'],
    'services/search/indexer.go': ['FlushQueue', 'buildIndexAsync'],
    'services/search/query.go': ['ParseQuery', 'RankResults'],
    'services/notify/mailer.ts': ['sendReceipt', 'renderTemplate'],
    'services/notify/sms.ts': ['sendSms'],
    'ops/runbooks/restore.sh': [],
    'ops/runbooks/rotate_keys.sh': ['rotate_keys'],
    'ops/deploy/k8s.yaml': [],
    'ops/deploy/helm/values.yaml': [],
    'docs/decisions/0001-queue.md': [],
    'docs/decisions/0002-cache.md': [],
    'docs/ödeme/akış-notları.md': [],
    'docs/ops/şifreleme_notu.md': [],
    'lib/util/strings.ts': ['slugify', 'collapseSpaces'],
    'lib/util/clock.ts': ['nowUtc'],
    'lib/config/loader.ts': ['loadConfig', 'mergeEnv'],
    'cmd/server/main.go': ['startServer'],
    'cmd/worker/main.go': ['runWorker'],
    'pkg/v2/retry_policy.go': ['BackoffDelay', 'maxAttempts'],
    'src/Modül/ÖzelDosya.ts': ['kayıtGüncelle'],
    'tests/fixtures/sample.json': [],
  }).map(([k, v]) => [N(k), v.map(N)])
);
const SYMLINK_IN_REPO = ['lib/legacy-link.ts', 'util/strings.ts']; // link path, relative target (inside lib/)

function repoBody(path, symbols) {
  const marker = `REPOBODY_${hexN(path, 10).toUpperCase()}_SECRET`;
  const ext = path.split('.').pop();
  if (ext === 'json') return `{"note": "${marker}"}\n`;
  if (ext === 'md') return `# ${path}\n\n${marker}\n`;
  if (ext === 'yaml') return `# ${marker}\nname: example\n`;
  const comment = ext === 'py' || ext === 'sh' || ext === 'yaml' ? '#' : '//';
  const lines = [`${comment} ${marker}`];
  if (path === 'services/notify/mailer.ts') lines.push('// renderTemplate replaces the sendLegacyBody flow'); // spec-edge: plain-text mention
  for (const s of symbols) {
    if (ext === 'ts') lines.push(`export function ${s}(): void {}`);
    else if (ext === 'py') lines.push(`def ${s}():`, '    pass');
    else if (ext === 'go') lines.push(`func ${s}() {}`);
    else if (ext === 'sh') lines.push(`${s}() { :; }`);
  }
  return lines.join('\n') + '\n';
}

// ---- Attribution plan. Ground truth: a repo reference is valid when its file is a regular file and its symbol is a word in it.
const VALID_SOURCES = [
  ['services/billing/invoice.ts', ''],
  ['services/billing/invoice.ts', 'a1b2c3d'],
  ['services/billing/tax_rules.ts', '0123456789ab'],
  ['services/billing/ledger01.ts', hexN('ledger01', 40)],
  ['services/billing/refund/service.ts', hexN('refund', 64)],
  ['services/auth/session.py', 'ABCDEF0'],
  ['services/auth/policy.py', 'deadbeef'],
  ['services/search/indexer.go', ''],
  ['services/search/query.go', '1234567'],
  ['services/notify/mailer.ts', ''],
  ['services/notify/sms.ts', 'fedcba9876543210'],
  ['ops/runbooks/restore.sh', ''],
  ['ops/runbooks/rotate_keys.sh', '0a1b2c3'],
  ['ops/deploy/k8s.yaml', ''],
  ['ops/deploy/helm/values.yaml', ''],
  ['docs/decisions/0001-queue.md', ''],
  ['docs/decisions/0002-cache.md', '9f8e7d6'],
  ['docs/ödeme/akış-notları.md', ''],
  ['docs/ops/şifreleme_notu.md', ''],
  ['lib/util/strings.ts', ''],
  ['lib/util/clock.ts', 'aaaaaaa'],
  ['lib/config/loader.ts', ''],
  ['cmd/server/main.go', hexN('server', 40)],
  ['cmd/worker/main.go', 'abcdef0123'],
  ['pkg/v2/retry_policy.go', ''],
  ['src/Modül/ÖzelDosya.ts', ''],
  ['tests/fixtures/sample.json', ''],
  ['services/billing/invoice.ts', hexN('invoice-upper', 64).toUpperCase()],
  ['lib/util/strings.ts', '1234567890'],
  ['services/notify/mailer.ts', '0000000'],
].map(([p, c]) => ({ form: 'source', path: N(p), commit: c }));

const VALID_SYMBOLS = [
  ['str', 'services/billing/invoice.ts', 'createInvoice'],
  ['obj', 'services/billing/invoice.ts', 'calcTax'],
  ['str', 'services/billing/tax_rules.ts', 'calcVatRate'],
  ['str', 'services/billing/tax_rules.ts', 'applyDiscount2'],
  ['obj', 'services/billing/ledger01.ts', 'postEntry'],
  ['str', 'services/billing/ledger01.ts', 'reconcileBatch'],
  ['str', 'services/billing/refund/service.ts', 'refundPayment'],
  ['str', 'services/billing/refund/service.ts', 'settleRefund'],
  ['obj', 'services/billing/invoice.ts', 'issueCredit'],
  ['obj', 'services/auth/session.py', 'issue_token'],
  ['str', 'services/auth/session.py', 'validate_token'],
  ['str', 'services/auth/session.py', 'end_session'],
  ['obj', 'services/auth/policy.py', 'evaluate_policy'],
  ['str', 'services/search/indexer.go', 'FlushQueue'],
  ['str', 'services/search/indexer.go', 'buildIndexAsync'],
  ['str', 'services/search/query.go', 'ParseQuery'],
  ['obj', 'services/search/query.go', 'RankResults'],
  ['str', 'services/notify/mailer.ts', 'sendReceipt'],
  ['str', 'services/notify/mailer.ts', 'renderTemplate'],
  ['obj', 'services/notify/sms.ts', 'sendSms'],
  ['str', 'ops/runbooks/rotate_keys.sh', 'rotate_keys'],
  ['str', 'lib/util/strings.ts', 'slugify'],
  ['obj', 'lib/util/strings.ts', 'collapseSpaces'],
  ['str', 'lib/util/clock.ts', 'nowUtc'],
  ['str', 'lib/config/loader.ts', 'loadConfig'],
  ['obj', 'lib/config/loader.ts', 'mergeEnv'],
  ['str', 'cmd/server/main.go', 'startServer'],
  ['str', 'cmd/worker/main.go', 'runWorker'],
  ['obj', 'pkg/v2/retry_policy.go', 'maxAttempts'],
  ['str', 'pkg/v2/retry_policy.go', 'BackoffDelay'],
  ['str', 'src/Modül/ÖzelDosya.ts', 'kayıtGüncelle'],
].map(([form, p, name]) => ({ form: form === 'str' ? 'sym-str' : 'sym-obj', path: N(p), name: N(name) }));

// [category, form, ...]: source -> raw reference; sym -> path, name.
const BROKEN = [
  ['deleted', 'sym-obj', 'services/legacy/old_mailer.ts', 'sendLegacy'],
  ['deleted', 'source', 'ops/runbooks/restore_v1.sh'],
  ['deleted', 'source', 'docs/eski/çıkarılan-karar.md'],
  ['deleted', 'sym-str', 'services/search/bm25.go', 'Score'],
  ['deleted', 'source', 'lib/util/hash_legacy.ts@1a2b3c4'],
  ['deleted', 'source', 'cmd/cron/main.go'],
  ['deleted', 'source', 'pkg/v1/retry_policy.go'],
  ['moved', 'source', 'services/billing/refunds.ts@fedcba9'],
  ['moved', 'source', 'services/notify/email.ts'],
  ['moved', 'source', 'ops/runbooks/rotate.sh'],
  ['moved', 'source', 'docs/ops/sifreleme.md'],
  ['moved', 'source', 'lib/config.ts'],
  ['moved', 'source', 'services/search/rank.go'],
  ['moved', 'sym-obj', 'src/Modul/OzelDosya.ts', 'kayıtGüncelle'],
  ['symbol-renamed', 'sym-str', 'services/billing/invoice.ts', 'computeTax'],
  ['symbol-renamed', 'sym-obj', 'services/auth/session.py', 'revoke_session'],
  ['symbol-renamed', 'sym-str', 'services/search/indexer.go', 'BuildIndex'],
  ['symbol-renamed', 'sym-str', 'services/notify/sms.ts', 'sendText'],
  ['symbol-renamed', 'sym-obj', 'lib/util/strings.ts', 'trimSpaces'],
  ['symbol-renamed', 'sym-str', 'pkg/v2/retry_policy.go', 'Backoff'],
  ['symbol-renamed', 'sym-str', 'src/Modül/ÖzelDosya.ts', 'kayıtOluştur'],
  ['symbol-removed', 'sym-str', 'services/billing/ledger01.ts', 'postEntryLegacy'],
  ['symbol-removed', 'sym-obj', 'services/auth/policy.py', 'legacy_check'],
  ['symbol-removed', 'sym-str', 'services/search/query.go', 'ParseQueryOld'],
  ['symbol-removed', 'sym-str', 'lib/util/clock.ts', 'nowLocal'],
  ['symbol-removed', 'sym-obj', 'cmd/server/main.go', 'startLegacy'],
  ['symbol-removed', 'sym-str', 'services/billing/tax_rules.ts', 'applyDiscount'],
  ['symbol-removed', 'sym-str', 'lib/config/loader.ts', 'readLegacyEnv'],
].map((row) => {
  if (row[1] === 'source') {
    const raw = N(row[2]);
    return { category: row[0], form: 'source', raw, path: stripCommit(raw) };
  }
  return { category: row[0], form: row[1], path: N(row[2]), name: N(row[3]) };
});

// Spec-edge cases: not counted in the detection or false-positive rates; each has an explicit expectation.
const K_MISSING = (p) => `src-missing:${p}`;
const EDGE_SOURCES = [
  { raw: 'lib/legacy-link.ts', expect: K_MISSING('lib/legacy-link.ts'), note: 'symlink is not followed' },
  { raw: 'services/billing', expect: K_MISSING('services/billing'), note: 'directory is not a file' },
  { raw: '../secret.txt', expect: 'src-rejected', note: 'parent segment' },
  { raw: '/services/billing/invoice.ts', expect: 'src-rejected', note: 'absolute path' },
  { raw: 'services\\billing\\invoice.ts', expect: 'src-rejected', note: 'backslash' },
  { raw: 'services/billing/invoice.ts/', expect: 'src-rejected', note: 'trailing slash' },
  {
    raw: 'services/billing/invoice.ts@main',
    expect: K_MISSING('services/billing/invoice.ts@main'),
    note: 'branch suffix is part of the path',
  },
  {
    raw: 'services/billing/invoice.ts@abcdef',
    expect: K_MISSING('services/billing/invoice.ts@abcdef'),
    note: '6 hex digits is not a commit',
  },
  {
    raw: 'services/billing/invoice.ts@xyz1234',
    expect: K_MISSING('services/billing/invoice.ts@xyz1234'),
    note: 'non-hex suffix',
  },
  {
    raw: `services/billing/invoice.ts@${hexN('too-long', 65)}`,
    expect: K_MISSING(`services/billing/invoice.ts@${hexN('too-long', 65)}`),
    note: '65 hex digits is not a commit',
  },
  { raw: '', expect: 'src-rejected', note: 'empty repo path (entry is "repo:")' },
  { raw: 'lib/util/strings.ts@', expect: K_MISSING('lib/util/strings.ts@'), note: 'empty suffix' },
];

// ---- Build pages.
const TOPICS = ['billing', 'auth', 'search', 'notify', 'ops', 'docs', 'lib', 'cmd', 'pkg', 'src'];
const DIRS = ['runbooks', 'decisions', 'services', 'runbooks', 'decisions', 'services'];
const TYPE_OF_DIR = { runbooks: 'summary', decisions: 'concept', services: 'entity' };
const topicOf = (p) => {
  if (p.startsWith('services/')) {
    const seg = p.split('/')[1];
    return seg === 'legacy' ? 'notify' : seg;
  }
  const seg = p.split('/')[0];
  return seg === 'tests' ? 'lib' : seg;
};

const ITEMS = []; // label records
const pageSources = new Map(); // page rel -> yaml lines
const pageSymbols = new Map();
const pageType = new Map();
const pageTitle = new Map();
const addLine = (map, rel, line) => {
  if (!map.has(rel)) map.set(rel, []);
  map.get(rel).push(line);
};
const registerPage = (rel, type, title) => {
  pageType.set(rel, type);
  pageTitle.set(rel, title);
  if (!pageSources.has(rel)) pageSources.set(rel, []);
  if (!pageSymbols.has(rel)) pageSymbols.set(rel, []);
};

for (const t of TOPICS)
  for (let k = 0; k < 6; k++) {
    const dir = DIRS[k];
    registerPage(`wiki/${dir}/${t}-${k}.md`, TYPE_OF_DIR[dir], `${t} ${k} ${dir.slice(0, -1)}`);
  }
for (let i = 1; i <= 4; i++) registerPage(`wiki/concepts/concept-0${i}.md`, 'concept', `Concept ${i}`);

const expectedOf = (it) => {
  if (it.form === 'source') return REPO.has(it.path) ? null : K_MISSING(it.path);
  if (!REPO.has(it.path)) return K_MISSING(it.path);
  return REPO.get(it.path).includes(it.name) && containsWord(repoBody(it.path, REPO.get(it.path)), it.name)
    ? null
    : `sym-missing:${it.path}#${it.name}`;
};
const counters = new Map(TOPICS.map((t) => [t, 0]));
const place = (it) => {
  const t = topicOf(it.path);
  const c = counters.get(t);
  counters.set(t, c + 1);
  const k = c % 6;
  return `wiki/${DIRS[k]}/${t}-${k}.md`;
};
const yamlFor = (it) => {
  if (it.form === 'source') return q(`repo:${it.raw ?? it.path + (it.commit ? `@${it.commit}` : '')}`);
  if (it.form === 'sym-str') return q(`${it.path}#${it.name}`);
  return `{path: ${q(it.path)}, name: ${q(it.name)}}`;
};
const addItem = (it, group, category, page, expect) => {
  const rec = {
    id: '',
    group,
    category,
    page,
    form: it.form,
    path: it.path,
    name: it.name ?? null,
    raw: it.form === 'source' ? (it.raw ?? `${it.path}${it.commit ? `@${it.commit}` : ''}`) : null,
    expect,
    yaml: yamlFor(it),
  };
  ITEMS.push(rec);
  addLine(it.form === 'source' ? pageSources : pageSymbols, page, `  - ${rec.yaml}`);
  return rec;
};

let vIdx = 0;
for (const it of VALID_SOURCES) {
  const rel = place(it);
  const exp = expectedOf({ ...it, raw: undefined });
  if (exp !== null) throw new Error(`valid source not valid: ${it.path}`);
  const rec = addItem(it, 'valid', 'valid-source', rel, null);
  rec.id = `V${String(++vIdx).padStart(2, '0')}`;
  rec.wouldKey = K_MISSING(it.path);
}
for (const it of VALID_SYMBOLS) {
  const rel = place(it);
  if (expectedOf(it) !== null) throw new Error(`valid symbol not valid: ${it.path}#${it.name}`);
  const rec = addItem(it, 'valid', 'valid-symbol', rel, null);
  rec.id = `V${String(++vIdx).padStart(2, '0')}`;
  rec.wouldKey = `sym-missing:${it.path}#${it.name}`;
}
let bIdx = 0;
for (const it of BROKEN) {
  const rel = place(it);
  const exp = expectedOf(it);
  if (exp === null) throw new Error(`broken item is actually valid: ${it.path} ${it.name ?? ''}`);
  const rec = addItem(it.form === 'source' ? { ...it, commit: undefined } : it, 'broken', it.category, rel, exp);
  rec.id = `B${String(++bIdx).padStart(2, '0')}`;
}

// Edge pages, fixed placement.
registerPage('wiki/services/edge-sources.md', 'entity', 'Edge sources');
registerPage('wiki/runbooks/edge-symbols.md', 'summary', 'Edge symbols');
registerPage('wiki/runbooks/edge-malformed.md', 'summary', 'Edge malformed symbols');
registerPage('wiki/services/edge-nonarray.md', 'entity', 'Edge non-array fields');
registerPage('wiki/services/edge-dedupe.md', 'entity', 'Edge duplicate findings');
registerPage('wiki/services/edge-valid.md', 'entity', 'Edge valid variants');
let eIdx = 0;
for (const e of EDGE_SOURCES) {
  const page = 'wiki/services/edge-sources.md';
  const yaml = q(`repo:${e.raw}`); // quoted for every entry: an unquoted "repo:" is read as a YAML mapping, not a string
  addLine(pageSources, page, `  - ${yaml}`);
  ITEMS.push({
    id: `E${String(++eIdx).padStart(2, '0')}`,
    group: 'edge',
    category: e.note,
    page,
    form: 'source',
    path: e.raw,
    name: null,
    raw: e.raw,
    expect: e.expect,
    yaml,
  });
}
addLine(pageSources, 'wiki/services/edge-sources.md', `  - 'raw/demo-source.md'`);
ITEMS.push({
  id: `E${String(++eIdx).padStart(2, '0')}`,
  group: 'edge',
  category: 'non-repo entry is ignored',
  page: 'wiki/services/edge-sources.md',
  form: 'source',
  path: 'raw/demo-source.md',
  name: null,
  raw: 'raw/demo-source.md',
  expect: null,
  yaml: q('raw/demo-source.md'),
});

const EDGE_SYMBOLS = [
  {
    form: 'sym-obj',
    path: 'lib/legacy-link.ts',
    name: 'slugify',
    expect: K_MISSING('lib/legacy-link.ts'),
    note: 'symlink used as symbol file',
  },
  { form: 'sym-obj', path: '../x.ts', name: 'a', expect: 'src-rejected', note: 'parent segment in symbol path' },
  {
    form: 'sym-obj',
    path: 'services/notify/mailer.ts',
    name: 'sendLegacyBody',
    expect: null,
    note: 'plain-text mention in a comment counts as present',
  },
  {
    form: 'sym-str',
    path: 'services/billing/tax_rules.ts',
    name: 'calcVat',
    expect: 'sym-missing:services/billing/tax_rules.ts#calcVat',
    note: 'prefix of a longer word is not a match',
  },
  {
    form: 'sym-obj',
    path: 'lib/util/strings.ts',
    name: 'slugify ',
    expect: null,
    note: 'name is trimmed before the lookup',
  },
];
for (const e of EDGE_SYMBOLS) {
  const rec = {
    id: `E${String(++eIdx).padStart(2, '0')}`,
    group: 'edge',
    category: e.note,
    page: 'wiki/runbooks/edge-symbols.md',
    form: e.form,
    path: e.path,
    name: e.name,
    raw: null,
    expect: e.expect,
    yaml: e.form === 'sym-str' ? q(`${e.path}#${e.name}`) : `{path: ${q(e.path)}, name: ${q(e.name)}}`,
  };
  ITEMS.push(rec);
  addLine(pageSymbols, rec.page, `  - ${rec.yaml}`);
}
const MALFORMED = [
  '42',
  'null',
  `{path: ${q('lib/util/strings.ts')}}`,
  `{name: ${q('slugify')}}`,
  q('lib/util/strings.ts#'),
  q('nohash'),
  '[]',
  `{path: ${q('lib/util/strings.ts')}, name: "a\\nb"}`,
  `{path: ${q('lib/util/strings.ts')}, name: ${q('x'.repeat(201))}}`,
  `{path: '', name: ${q('slugify')}}`,
];
MALFORMED.forEach((yaml, i) => {
  const rec = {
    id: `M${String(i + 1).padStart(2, '0')}`,
    group: 'edge',
    category: 'malformed symbol entry is ignored',
    page: 'wiki/runbooks/edge-malformed.md',
    form: 'malformed',
    path: null,
    name: null,
    raw: null,
    expect: null,
    yaml,
  };
  ITEMS.push(rec);
  addLine(pageSymbols, rec.page, `  - ${yaml}`);
});
ITEMS.push({
  id: 'N01',
  group: 'edge',
  category: 'non-array sources is ignored',
  page: 'wiki/services/edge-nonarray.md',
  form: 'malformed',
  path: null,
  name: null,
  raw: null,
  expect: null,
  yaml: q('repo:services/billing/invoice.ts'),
});
ITEMS.push({
  id: 'N02',
  group: 'edge',
  category: 'non-array symbols is ignored',
  page: 'wiki/services/edge-nonarray.md',
  form: 'malformed',
  path: null,
  name: null,
  raw: null,
  expect: null,
  yaml: q('lib/util/strings.ts#slugify'),
});
ITEMS.push({
  id: 'D01',
  group: 'edge',
  category: 'one missing file reported once per page',
  page: 'wiki/services/edge-dedupe.md',
  form: 'source',
  path: 'services/legacy/gone.ts',
  name: null,
  raw: 'services/legacy/gone.ts',
  expect: K_MISSING('services/legacy/gone.ts'),
  yaml: q('repo:services/legacy/gone.ts'),
});
ITEMS.push({
  id: 'D02',
  group: 'edge',
  category: 'same missing file as symbol, reported once per page',
  page: 'wiki/services/edge-dedupe.md',
  form: 'sym-obj',
  path: 'services/legacy/gone.ts',
  name: 'a',
  raw: null,
  expect: null,
  yaml: `{path: ${q('services/legacy/gone.ts')}, name: 'a'}`,
});
ITEMS.push({
  id: 'W01',
  group: 'edge',
  category: 'dot segment is normalized, valid',
  page: 'wiki/services/edge-valid.md',
  form: 'source',
  path: 'lib/util/strings.ts',
  name: null,
  raw: './lib/util/strings.ts',
  expect: null,
  yaml: q('repo:./lib/util/strings.ts'),
});
// Items with explicit page placement are reflected in the page builders below.
addLine(pageSources, 'wiki/services/edge-nonarray.md', 'NONARRAY_SOURCES');
addLine(pageSymbols, 'wiki/services/edge-nonarray.md', 'NONARRAY_SYMBOLS');
addLine(pageSources, 'wiki/services/edge-dedupe.md', `  - ${q('repo:services/legacy/gone.ts')}`);
addLine(pageSymbols, 'wiki/services/edge-dedupe.md', `  - {path: ${q('services/legacy/gone.ts')}, name: 'a'}`);
addLine(pageSymbols, 'wiki/services/edge-dedupe.md', `  - ${q('services/legacy/gone.ts#b')}`);
addLine(pageSources, 'wiki/services/edge-valid.md', `  - ${q('repo:./lib/util/strings.ts')}`);
addLine(pageSymbols, 'wiki/services/edge-valid.md', `  - {path: ${q('lib/util/strings.ts')}, name: ${q('slugify ')}}`);

// ---- Page text.
function pageText(rel) {
  const type = pageType.get(rel);
  const title = pageTitle.get(rel);
  const srcs = pageSources.get(rel).filter((l) => l !== 'NONARRAY_SOURCES');
  const syms = pageSymbols.get(rel).filter((l) => l !== 'NONARRAY_SYMBOLS');
  const lines = ['---', `type: ${type}`, `generated: '2026-11-01T00:00:00Z'`, 'status: proposed'];
  if (rel === 'wiki/services/edge-nonarray.md') {
    lines.push(`sources: ${q('repo:services/billing/invoice.ts')}`, `symbols: ${q('lib/util/strings.ts#slugify')}`);
  } else {
    lines.push(srcs.length ? 'sources:' : 'sources: []', ...srcs);
    if (syms.length) lines.push('symbols:', ...syms);
  }
  lines.push('verified: []', `stale_after: '2099-12-31'`);
  if (type === 'entity' || type === 'concept') lines.push('aliases: []', 'keywords: []');
  lines.push(
    '---',
    '',
    `# ${title}`,
    '',
    `Synthetic fixture page (BA-42). VAULTBODY_${hexN(rel, 10).toUpperCase()}_SECRET`,
    ''
  );
  return lines.join('\n');
}
const CONCEPT_EXTRA = [];

const CONCEPTS = [1, 2, 3, 4].map((i) => `wiki/concepts/concept-0${i}.md`);
const EDGE_PAGES = [
  'wiki/services/edge-sources.md',
  'wiki/runbooks/edge-symbols.md',
  'wiki/runbooks/edge-malformed.md',
  'wiki/services/edge-nonarray.md',
  'wiki/services/edge-dedupe.md',
  'wiki/services/edge-valid.md',
];
const CONTENT = [...pageType.keys()].sort();
void CONCEPTS;
void EDGE_PAGES;
void CONCEPT_EXTRA;

function indexText(pages) {
  const sections = [
    ['Runbooks', 'runbooks'],
    ['Decisions', 'decisions'],
    ['Services', 'services'],
    ['Concepts', 'concepts'],
    ['Summaries', 'summaries'],
  ];
  const lines = ['# Wiki index', ''];
  for (const [heading, dir] of sections) {
    const entries = pages.filter((p) => p.startsWith(`wiki/${dir}/`));
    if (!entries.length) continue;
    lines.push(`## ${heading}`, '');
    for (const p of entries)
      lines.push(`- [${pageTitle.get(p) ?? p.split('/').pop().replace(/\.md$/, '')}](${p.slice('wiki/'.length)})`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- vault-edge: baseline defects (no repo needed), plus repo references for the --repo run.
function edgeVault() {
  const page = (rel, body, fm = []) => [rel, ['---', ...fm, '---', '', body, ''].join('\n')];
  const base = (type, status, extra = []) => [
    `type: ${type}`,
    `generated: '2026-11-01T00:00:00Z'`,
    `status: ${status}`,
    'sources: []',
    'verified: []',
    `stale_after: '2099-12-31'`,
    ...extra,
  ];
  const files = [
    page('wiki/concepts/bad-yaml.md', '# Bad yaml', ['type: concept', 'key: [unclosed']),
    page('wiki/decisions/loop-a.md', 'Loop A.', [
      ...base('concept', 'superseded', ["superseded_by: 'wiki/decisions/loop-b.md'"]),
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/decisions/loop-b.md', 'Loop B.', [
      ...base('concept', 'superseded', ["superseded_by: 'wiki/decisions/loop-a.md'"]),
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/decisions/gone.md', 'Gone.', [
      ...base('concept', 'superseded', ["superseded_by: 'wiki/decisions/missing.md'"]),
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/decisions/chain-1.md', 'Chain 1.', [
      ...base('concept', 'superseded', ["superseded_by: 'wiki/decisions/chain-2.md'"]),
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/decisions/chain-2.md', 'Chain 2.', [
      ...base('concept', 'superseded', ["superseded_by: 'wiki/decisions/chain-3.md'"]),
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/decisions/chain-3.md', 'Chain 3.', [...base('concept', 'proposed'), 'aliases: []', 'keywords: []']),
    page('wiki/runbooks/broken-links.md', 'See [[nonexistent-page]] and [x](missing-page.md) and [[unlisted]].', [
      ...base('summary', 'proposed'),
    ]),
    page('wiki/services/oversized.md', 'lorem ipsum '.repeat(1550), [
      ...base('entity', 'proposed'),
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/services/orphan.md', 'Nobody links here.', [
      ...base('entity', 'proposed'),
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/concepts/stale.md', 'Old review.', [
      'type: concept',
      `generated: '2026-11-01T00:00:00Z'`,
      'status: proposed',
      'sources: []',
      'verified: []',
      `stale_after: '2020-01-01'`,
      'aliases: []',
      'keywords: []',
    ]),
    page('wiki/concepts/unlisted.md', 'Linked but not indexed.', [
      ...base('concept', 'proposed'),
      'aliases: []',
      'keywords: []',
    ]),
    page(
      'wiki/summaries/updates.md',
      [
        '## Update 2026-02-01',
        'a',
        '## Update 2026-02-02',
        'b',
        '## Update 2026-02-03',
        'c',
        '## Update 2026-02-04',
        'd',
        '## Update 2026-02-05',
        'e',
        '## Update 2026-02-06',
        'f',
      ].join('\n'),
      [...base('summary', 'proposed')]
    ),
    page('wiki/services/with-repo.md', 'Repo references for the --repo run.', [
      ...base('entity', 'proposed', []).filter((l) => !l.startsWith('sources:')),
      'sources:',
      "  - 'repo:services/billing/invoice.ts@a1b2c3d'",
      "  - 'repo:services/gone.ts'",
      'aliases: []',
      'keywords: []',
      'symbols:',
      "  - {path: 'services/billing/invoice.ts', name: 'calcTax'}",
    ]),
  ];
  const indexed = files
    .map(([rel]) => rel)
    .filter((rel) => !['wiki/services/orphan.md', 'wiki/concepts/unlisted.md'].includes(rel));
  const index = indexText(indexed.map((r) => r)) + '\n- [Ghost](concepts/ghost.md)\n';
  return { files, index };
}

// ---- Write everything.
async function writeTree(root, files) {
  for (const [rel, text] of files) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
  }
}
async function main() {
  await rm(FIX, { recursive: true, force: true });
  await mkdir(FIX, { recursive: true });

  // Main vault: 70 content pages, every page indexed, no baseline defects.
  const mainFiles = [];
  for (const rel of CONTENT) mainFiles.push([rel, pageText(rel)]);
  mainFiles.push(['wiki/index.md', indexText(CONTENT)]);
  mainFiles.push(['wiki/log.md', '# Wiki log\n\n- 2026-11-01 synthetic BA-42 fixture written.\n']);
  await writeTree(join(FIX, 'vault-main'), mainFiles);

  // Fake repository: 26 regular files in subdirectories, one symlink.
  const repoFiles = [];
  for (const [path, symbols] of REPO) repoFiles.push([path, repoBody(path, symbols)]);
  await writeTree(join(FIX, 'repo-main'), repoFiles);
  await symlink(SYMLINK_IN_REPO[1], join(FIX, 'repo-main', SYMLINK_IN_REPO[0]));

  // Demo vault: a copy of the product's demo vault (read-only input).
  await cp(DEMO_SRC, join(FIX, 'vault-demo'), { recursive: true });

  // Edge vault.
  const edge = edgeVault();
  await writeTree(join(FIX, 'vault-edge'), [...edge.files, ['wiki/index.md', edge.index]]);

  // Labels: expected multiset per page (what a correct tool reports), written before any product run.
  const labels = {
    version: 'ba42-labels-1',
    note: 'ground truth from the generator plan; keys: src-missing:<path>, sym-missing:<path>#<name>, src-rejected',
    items: ITEMS.map((r) => ({ ...r })),
  };
  await writeFile(join(FIX, 'labels.json'), JSON.stringify(labels, null, 2) + '\n', 'utf8');

  // Manifest: sha256 of every fixture entry (regular files and symlink targets), excluding itself.
  const entries = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const abs = join(dir, name);
      const info = await lstat(abs);
      const rel = relative(FIX, abs);
      if (rel === 'MANIFEST.json') continue;
      if (info.isSymbolicLink()) entries.push({ path: rel, type: 'symlink', target: await readlink(abs) });
      else if (info.isDirectory()) await walk(abs);
      else entries.push({ path: rel, type: 'file', sha256: sha(await readFile(abs)), size: info.size });
    }
  }
  await walk(FIX);
  const digest = sha(JSON.stringify(entries));
  await writeFile(
    join(FIX, 'MANIFEST.json'),
    JSON.stringify({ version: 'ba42-manifest-1', digest, entries }, null, 2) + '\n',
    'utf8'
  );

  const counts = ITEMS.reduce((acc, r) => {
    acc[r.group] = (acc[r.group] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    JSON.stringify({
      contentPages: CONTENT.length,
      repoRegularFiles: REPO.size,
      symlinks: 1,
      items: counts,
      broken: BROKEN.length,
      validSources: VALID_SOURCES.length,
      validSymbols: VALID_SYMBOLS.length,
      digest,
    })
  );
}
await main();
