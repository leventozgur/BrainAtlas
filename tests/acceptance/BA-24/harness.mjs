// SPDX-License-Identifier: MIT
import { mkdtemp, mkdir, cp, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { vaultId } from '../../../packages/core/src/paths/index.mjs';

export const WT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
export const MAIN =
  process.env.BA24_MAIN_ROOT ||
  dirname(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: WT,
      encoding: 'utf8',
    }).trim()
  );
export const DIMS = 8;

export const SETTINGS = Object.freeze({
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'ba24-fake-embed',
  dims: DIMS,
  queryPrefix: 'task: search result | query: ',
  documentPrefix: 'title: none | text: ',
  minScore: -1,
  mode: 'semantic-primary',
  timeoutMs: 5000,
  indexTimeoutMs: 120000,
  indexBatchSize: 32,
  allowRemote: false,
});

export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function fold(text) {
  return text.replace(/[ıİ]/g, 'i').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function fakeVector(text) {
  const vector = new Array(DIMS).fill(0.05);
  for (const token of fold(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!token) continue;
    let hash = 2166136261;
    for (const ch of token) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
    vector[(hash >>> 0) % DIMS] += 1;
  }
  return vector;
}

export function fetchWithMode(state) {
  return async (_url, options) => {
    state.calls = (state.calls ?? 0) + 1;
    if (state.mode === 'error') return { ok: false, status: 500, json: async () => ({}) };
    if (state.mode === 'throw') throw new Error('ba24 fake network failure');
    if (state.mode === 'hang') return new Promise(() => {});
    const input = JSON.parse(options.body).input;
    return { ok: true, status: 200, json: async () => ({ embeddings: input.map(fakeVector) }) };
  };
}

export const PAGES = {
  'tr/cozum.md': `---
title: Çözüm Ağacı
generated: "2026-01-01"
status: confirmed
stale_after: "2001-01-01"
---
# Çözüm Ağacı

Çözüm ağacı probe ölçüm kararları ve kayıtları.

## Ölçüm Notları

Ölçüm sonuçları ağaç yapısı için probe kullanılır.

## Ölçüm Notları

Tekrarlanan başlık ağaç ölçüm probe.

## Ölçüm Notları

Üçüncü bölüm ağaç ölçüm için ayrıldı probe.
`,
  'emoji/astral.md': `---
title: Roket Başlangıç
generated: "2026-01-01"
---
# 🚀 Başlangıç

🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂 roket astral probe 𝒜𝒷𝒸𝒹𝒺𝒻𝒼𝒽𝒾𝒿𝓀𝓁𝓂𝓃𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏 başlangıç notları probe

## 🙂 Notlar 🙂

🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂 astral probe roket notlar 𝒜𝒷𝒸𝒹𝒺𝒻𝒼𝒽𝒾𝒿𝓀𝓁𝓂𝓃𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏

## Notlar

notlar probe roket

## 🙂🚀✨

symbol probe ✨✨ 🙂🙂

## 🙂🚀✨

second symbol probe 🚀🚀
`,
  'punct/hata.md': `---
title: Hata Kaydı
generated: "2026-01-01"
---
# Hata: 404!? (kritik) — özet

hata kodu 404 kritik probe özet.

## C++ & C#: notlar

C++ ve C# notları hata probe.

## 2026-01-05 Güncel durum

güncel durum hata probe 2026.
`,
  'emoji/kesim.md': `---
title: Kesim
generated: "2026-01-01"
---
# Kesim

🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂 kesim probe
`,
  'stale/expired-quoted.md': `---
title: Expired Quoted
generated: "2026-01-01"
stale_after: "2001-01-01"
---
# Expired Quoted

stale probe expired quoted page.
`,
  'stale/expired-unquoted.md': `---
title: Expired Unquoted
generated: "2026-01-01"
stale_after: 2001-01-01
---
# Expired Unquoted

stale probe unquoted page.
`,
  'stale/future.md': `---
title: Future
generated: "2026-01-01"
stale_after: "2099-01-01"
---
# Future

stale probe future page.
`,
  'stale/undated.md': `---
title: Undated
---
# Undated

stale probe undated page.
`,
  'stale/pnd-expired.md': `---
title: PnD Expired
generated: "2020-01-01"
stale_after: P30D
---
# PnD Expired

stale probe pnd expired page.
`,
  'stale/pnd-fresh.md': `---
title: PnD Fresh
generated: "2099-01-01"
stale_after: P30D
---
# PnD Fresh

stale probe pnd fresh page.
`,
};

export async function makeWorkspace() {
  const ws = await mkdtemp(join(tmpdir(), 'ba24-accept-'));
  const wiki = join(ws, 'vault', 'wiki');
  for (const [rel, text] of Object.entries(PAGES)) {
    await mkdir(join(wiki, rel, '..'), { recursive: true });
    await writeFile(join(wiki, rel), text);
  }
  return ws;
}

export async function loadTree(name, root, ws) {
  const mcp = await import(pathToFileURL(join(root, 'packages/mcp/src/index.mjs')).href);
  const sem = await import(pathToFileURL(join(root, 'modules/semantic/src/index.mjs')).href);
  const releasesDir = join(ws, name, 'releases'),
    release = join(releasesDir, 'v1'),
    currentDir = join(ws, name, 'current');
  await mkdir(join(release, 'modules'), { recursive: true });
  await cp(join(root, 'modules/semantic'), join(release, 'modules/semantic'), { recursive: true });
  await symlink(join(root, 'packages'), join(release, 'packages'));
  await symlink(release, currentDir);
  return {
    name,
    root,
    createServer: mcp.createServer,
    sem,
    releasesDir,
    currentDir,
    stateRoot: join(ws, name, 'state'),
  };
}

export function makeConfig(ws, over = {}) {
  const { semantic = {}, ...rest } = over;
  return {
    schemaVersion: 1,
    profile: 'custom',
    vault: { path: join(ws, 'vault') },
    modules: ['semantic'],
    agents: [],
    scope: 'global',
    retrieval: { budgetChars: 4000, abstainThreshold: 0.35 },
    hooks: { mode: 'normal', deadlineMs: 1000 },
    safety: { secretFilter: true, extraDenyGlobs: [], allow: [] },
    okf: { level: 'warn' },
    sync: { transport: null, options: {} },
    telemetry: false,
    readOnly: true,
    node: { path: 'node' },
    ...rest,
    semantic: { ...SETTINGS, ...semantic },
  };
}

const indexDirOf = (tree, stateDir, ws) => (tree.name === 'wt' ? join(stateDir, vaultId(join(ws, 'vault'))) : stateDir);

export async function buildIndex(tree, stateDir, ws) {
  const fetchState = { mode: 'ok' };
  const provider = tree.sem.createOllamaProvider({
    ...SETTINGS,
    batchSize: SETTINGS.indexBatchSize,
    timeoutMs: SETTINGS.indexTimeoutMs,
    fetchImpl: fetchWithMode(fetchState),
  });
  await tree.sem.updateSemanticIndex({
    corpusDir: join(ws, 'vault', 'wiki'),
    stateDir: indexDirOf(tree, stateDir, ws),
    provider,
    indexBatchSize: SETTINGS.indexBatchSize,
    chunkMarkdown: tree.sem.markdownChunks,
  });
}

export async function startServer(tree, ws, { stateDir, over = {}, fetchState = { mode: 'ok' } }) {
  const config = makeConfig(ws, over);
  const server = tree.createServer({
    config,
    paths: { stateDir, releasesDir: tree.releasesDir, currentDir: tree.currentDir },
    env: { HOME: ws },
    fetchImpl: fetchWithMode(fetchState),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ba24-acceptance', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
  };
  return {
    fetchState,
    config,
    call,
    query: async (query, extra = {}) => (await call('wiki_query', { query, ...extra })).data,
    queryRaw: (query, extra = {}) => call('wiki_query', { query, ...extra }),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function oracleSections(content) {
  const seen = new Set(),
    out = [],
    ancestors = [];
  let fence = null;
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const f = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^(#{1,3})[\t ]+(.+)$/);
    if (!h) continue;
    const level = h[1].length,
      title = h[2].trim();
    ancestors.length = level - 1;
    ancestors[level - 1] = title;
    const base = /[\p{L}\p{N}]/u.test(title)
      ? fold(title)
          .replace(/[^\p{L}\p{N}_\- ]/gu, '')
          .replace(/ /g, '-')
      : 'section';
    let anchor = base,
      n = 0;
    while (seen.has(anchor)) anchor = `${base}-${++n}`;
    seen.add(anchor);
    out.push({ heading: title, anchor, headingPath: ancestors.filter(Boolean).join(' > ') });
  }
  return out;
}

export const QUERIES = [
  'probe',
  'ölçüm',
  'olcum notları',
  'üçüncü',
  'tekrarlanan',
  'roket',
  'başlangıç',
  'baslangic',
  'astral',
  'notlar',
  'hata',
  'kritik',
  'güncel',
  'guncel durum',
  'C++',
  'hata kodu 404',
  'roket astral',
  'ağaç ölçüm',
  'agac olcum',
  'symbol',
  'xyznomatch',
];
