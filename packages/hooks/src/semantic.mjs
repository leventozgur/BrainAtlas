// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The semantic step runs inside the retrieval worker after the lexical search. It has its own budget, so a slow or
// unavailable provider can never consume the whole prompt deadline; on any failure the caller keeps the BM25 list.
export const SEMANTIC_BUDGET_MS = 350;
const EXPIRED = Symbol('expired');

/** Semantic retrieval is requested only with an explicit opt-in on a non-Lite profile that includes the module. */
export function semanticRequested(config) {
  return config?.semantic?.enabled === true && config.profile !== 'lite' && Boolean(config.modules?.includes('*') || config.modules?.includes('semantic'));
}

/**
 * The module is loaded only from the installed release tree, and only by dynamic import inside the worker.
 * The path is built from this file's location, so it stays inside the release that contains this hook.
 */
export function semanticEntryUrl() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  return pathToFileURL(join(root, 'modules', 'semantic', 'src', 'index.mjs')).href;
}

/**
 * Hybrid retrieval for the prompt hook. Returns `{results, semantic}` where `semantic` is 'used' or 'fallback:<reason>'.
 * Any fallback returns the lexical list exactly as the caller computed it.
 * @param {object} options
 * @param {object} options.searcher core searcher (`snapshot()` supplies the lexical index it shares with the module)
 * @param {Array<object>} options.lexical finished lexical results (BM25, same as the semantic-off path)
 * @param {object} options.settings merged semantic settings (SEMANTIC_DEFAULTS + config.semantic)
 * @param {string} options.stateDir global BrainAtlas state directory (the index lives in its `semantic/` subdirectory)
 * @param {(result: object) => object} options.prepare finishing step (redaction and excerpt cap) for hybrid results
 */
export async function semanticHits({ searcher, query, limit, abstainThreshold, lexical, settings, stateDir, prepare, entryUrl = semanticEntryUrl(), budgetMs = SEMANTIC_BUDGET_MS, fetchImpl = globalThis.fetch, loadModule = url => import(url) }) {
  const started = Date.now();
  const fallback = reason => ({ results: lexical, semantic: `fallback:${reason}` });
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(EXPIRED), budgetMs); });
  const work = (async () => {
    const module = await loadModule(entryUrl);
    module.validateConfiguredProvider(settings);
    const provider = module.createOllamaProvider({ ...settings, timeoutMs: Math.max(1, budgetMs - (Date.now() - started)), fetchImpl });
    const index = await module.readSemanticIndex(stateDir);
    if (!index || index.entries.length === 0) return { fallback: 'index-missing' };
    if (index.providerFingerprint !== provider.fingerprint || index.dims !== provider.dims) return { fallback: 'fingerprint-mismatch' };
    const snapshot = searcher.snapshot();
    const docs = snapshot.index.docs;
    const pagePaths = new Set(docs.map(({ page }) => page.path));
    const trustByPath = new Map(docs.filter(({ trust }) => trust === 'verified' || trust === 'weak').map(({ page, trust }) => [page.path, trust]));
    // The semantic index is built over the Wiki folder (`wiki/`), while the hook's lexical corpus is the vault root.
    const entries = index.entries.flatMap(entry => {
      const path = [`wiki/${entry.path}`, entry.path].find(candidate => pagePaths.has(candidate));
      return path ? [{ ...entry, path }] : [];
    });
    const hits = await module.searchHybrid({ query, pages: snapshot.pages, lexicalIndex: snapshot.index, entries, provider, limit, indexMeta: index,
      mode: settings.mode, minSemanticScore: settings.minScore, abstainThreshold });
    if (hits.fallbackReason) return { fallback: hits.fallbackReason };
    // Abstention keeps the lexical list, as the MCP path does.
    if (hits.abstained) return { results: lexical };
    const results = hits.map(item => {
      const trust = item.trust ?? trustByPath.get(item.path);
      return prepare({ ...item, ...(trust === 'verified' || trust === 'weak' ? { trust } : {}) });
    });
    return { results };
  })().catch(error => ({ fallback: error?.fallbackReason ?? (error?.code === 'ERR_MODULE_NOT_FOUND' ? 'module-missing' : 'provider-error') }));
  try {
    const outcome = await Promise.race([work, expired]);
    // A result that arrives after the budget (a synchronous step that finished late) is not used.
    if (outcome === EXPIRED || Date.now() - started > budgetMs) return fallback('deadline');
    if (outcome.fallback) return fallback(outcome.fallback);
    return { results: outcome.results, semantic: 'used' };
  } finally { clearTimeout(timer); }
}
