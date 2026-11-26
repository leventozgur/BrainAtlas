// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRootFromUrl } from '../../core/src/paths/index.mjs';

export const SEMANTIC_BUDGET_MS = 350;
const EXPIRED = Symbol('expired');

export function semanticRequested(config) {
  return (
    config?.semantic?.enabled === true &&
    config.profile !== 'lite' &&
    Boolean(config.modules?.includes('*') || config.modules?.includes('semantic'))
  );
}

export function semanticEntryUrl() {
  return pathToFileURL(join(packageRootFromUrl(import.meta.url), 'modules', 'semantic', 'src', 'index.mjs')).href;
}

export async function semanticHits({
  searcher,
  query,
  limit,
  abstainThreshold,
  lexical,
  settings,
  stateDir,
  prepare,
  entryUrl = semanticEntryUrl(),
  budgetMs = SEMANTIC_BUDGET_MS,
  fetchImpl = globalThis.fetch,
  loadModule = (url) => import(url),
}) {
  const started = Date.now();
  const fallback = (reason) => ({ results: lexical, semantic: `fallback:${reason}` });
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), budgetMs);
  });
  const work = (async () => {
    const module = await loadModule(entryUrl);
    module.validateConfiguredProvider(settings);
    const provider = module.createOllamaProvider({
      ...settings,
      timeoutMs: Math.max(1, budgetMs - (Date.now() - started)),
      fetchImpl,
    });
    const index = await module.readSemanticIndex(stateDir);
    if (!index || index.entries.length === 0) return { fallback: 'index-missing' };
    if (index.providerFingerprint !== provider.fingerprint || index.dims !== provider.dims)
      return { fallback: 'fingerprint-mismatch' };
    const snapshot = searcher.snapshot();
    const docs = snapshot.index.docs;
    const pagePaths = new Set(docs.map(({ page }) => page.path));
    const trustByPath = new Map(
      docs.filter(({ trust }) => trust === 'verified' || trust === 'weak').map(({ page, trust }) => [page.path, trust])
    );
    const lexicalRows = /** @type {any[]} */ (lexical);
    const synthesizedRows = new Map(
      lexicalRows.filter((result) => result.synthesized === true).map((result) => [result.path, result])
    );
    const synthesizedHit = (item) => {
      if (item.synthesized === true) return true;
      const row = synthesizedRows.get(item.path);
      if (!row) return false;
      if (typeof item.anchor === 'string' && item.anchor !== '' && item.anchor === row.anchor) return true;
      if (typeof item.heading === 'string' && item.heading !== '' && item.heading === row.heading) return true;
      if (typeof item.headingPath !== 'string' || item.headingPath === '') return false;
      return (
        item.headingPath === row.headingPath ||
        (typeof row.heading === 'string' && row.heading !== '' && item.headingPath.split(' > ').at(-1) === row.heading)
      );
    };
    const entries = index.entries.flatMap((entry) => {
      const path = [`wiki/${entry.path}`, entry.path].find((candidate) => pagePaths.has(candidate));
      return path ? [{ ...entry, path }] : [];
    });
    const hits = await module.searchHybrid({
      query,
      pages: snapshot.pages,
      lexicalIndex: snapshot.index,
      entries,
      provider,
      limit,
      indexMeta: index,
      mode: settings.mode,
      minSemanticScore: settings.minScore,
      abstainThreshold,
    });
    if (hits.fallbackReason) return { fallback: hits.fallbackReason };
    if (hits.abstained) return { results: lexical };
    const results = hits.map((item) => {
      const synthesized = synthesizedHit(item);
      const trust = item.trust ?? trustByPath.get(item.path);
      const row = { ...item, ...(trust === 'verified' || trust === 'weak' ? { trust } : {}) };
      if (synthesized) {
        row.synthesized = true;
        if (row.trust === 'verified') delete row.trust;
      }
      return prepare(row);
    });
    return { results };
  })().catch((error) => ({
    fallback: error?.fallbackReason ?? (error?.code === 'ERR_MODULE_NOT_FOUND' ? 'module-missing' : 'provider-error'),
  }));
  try {
    const outcome = await Promise.race([work, expired]);
    if (outcome === EXPIRED || Date.now() - started > budgetMs) return fallback('deadline');
    if (outcome.fallback) return fallback(outcome.fallback);
    return { results: outcome.results, semantic: 'used' };
  } finally {
    clearTimeout(timer);
  }
}
