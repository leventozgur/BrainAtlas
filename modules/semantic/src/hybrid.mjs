// SPDX-License-Identifier: MIT
import { buildIndex, search } from '../../../packages/core/src/retrieval/index.mjs';

export function cosineSimilarity(left, right) {
  if ((!Array.isArray(left) && !(left instanceof Float32Array))
    || (!Array.isArray(right) && !(right instanceof Float32Array))
    || left.length === 0 || left.length !== right.length) throw new TypeError('Vectors must have matching non-empty dimensions.');
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new TypeError('Vectors must contain finite values.');
    dot += left[i] * right[i]; leftNorm += left[i] ** 2; rightNorm += right[i] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

/** Reciprocal-rank fusion; duplicate paths within each list count only once. */
export function reciprocalRankFusion(resultLists, { k = 60, weights = resultLists.map(() => 1) } = {}) {
  if (!Array.isArray(resultLists) || !Array.isArray(weights) || weights.length !== resultLists.length || weights.some((weight) => !Number.isFinite(weight) || weight < 0) || !Number.isFinite(k) || k < 1) throw new TypeError('Invalid fusion input.');
  const fused = new Map();
  for (const [listIndex, list] of resultLists.entries()) {
    if (!Array.isArray(list)) throw new TypeError('Fusion lists must be arrays.');
    const seen = new Set();
    list.forEach((item, rank) => {
      const key = item?.path;
      if (typeof key !== 'string' || seen.has(key)) return;
      seen.add(key);
      const value = fused.get(key) ?? { ...item, path: key, rrfScore: 0, sourceRanks: [] };
      value.rrfScore += weights[listIndex] / (k + rank + 1);
      value.sourceRanks.push(rank + 1);
      for (const [field, fieldValue] of Object.entries(item)) if (value[field] == null && fieldValue != null) value[field] = fieldValue;
      fused.set(key, value);
    });
  }
  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore || a.path.localeCompare(b.path));
}

function stale(fm, asOf) {
  let expiry = fm.stale_after instanceof Date ? fm.stale_after.toISOString().slice(0, 10) : fm.stale_after;
  if (!expiry) return false;
  if (typeof expiry === 'string' && /^P\d+[DW]$/.test(expiry)) {
    const generated = fm.generated instanceof Date ? fm.generated.toISOString().slice(0, 10) : fm.generated;
    const base = new Date(generated);
    if (!Number.isFinite(base.getTime())) return false;
    const days = Number(expiry.slice(1, -1)) * (expiry.endsWith('W') ? 7 : 1);
    expiry = new Date(base.getTime() + days * 86400000);
  }
  const time = new Date(expiry).getTime();
  return Number.isFinite(time) && time < asOf.getTime();
}

/** Combine the core BM25F results with page-level cosine-ranked chunks. */
export async function searchHybrid({ query, pages, entries, provider, limit = 5, k = 60, asOf = new Date(), indexMeta, weights = [1, 1], mode = 'rrf', minSemanticScore, minMargin, abstainThreshold }) {
  if (typeof query !== 'string' || !Array.isArray(pages) || !Array.isArray(entries)) throw new TypeError('Invalid hybrid search input.');
  if (!Array.isArray(weights) || weights.length !== 2 || weights.some((w) => !Number.isFinite(w) || w <= 0) || !['rrf', 'semantic-primary'].includes(mode) || (minSemanticScore !== undefined && (!Number.isFinite(minSemanticScore) || minSemanticScore < -1 || minSemanticScore > 1)) || (minMargin !== undefined && (!Number.isFinite(minMargin) || minMargin < 0 || minMargin > 2))) throw new TypeError('Invalid hybrid search options.');
  const lexicalIndex = buildIndex(pages);
  const lexical = search(lexicalIndex, query, { limit: Math.max(limit * 4, 20), abstainThreshold }).results;
  const eligiblePages = new Map(lexicalIndex.docs.map(({ page }) => [page.path, page]));
  const fallback = (reason) => { const results = lexical.slice(0, limit); results.fallbackReason = reason; return results; };
  if (indexMeta != null && (!provider?.fingerprint || !indexMeta.providerFingerprint || provider.fingerprint !== indexMeta.providerFingerprint)) return fallback('fingerprint-mismatch');
  try {
    const queryVector = typeof provider.embedQuery === 'function' ? await provider.embedQuery(query) : (await provider.embed([query]))[0];
    const bestByPath = new Map();
    for (const entry of entries) {
      const page = eligiblePages.get(entry?.path);
      if (!page) continue;
      const score = cosineSimilarity(queryVector, entry.vector);
      if (!bestByPath.has(entry.path) || score > bestByPath.get(entry.path).semanticScore) {
        bestByPath.set(entry.path, { path: entry.path, title: page.title, status: typeof page.frontmatter?.status === 'string' ? page.frontmatter.status : null,
          stale: stale(page.frontmatter || {}, asOf), semanticScore: score, snippet: entry.text, headingPath: entry.headingPath });
      }
    }
    const ranked = [...bestByPath.values()].sort((a, b) => b.semanticScore - a.semanticScore || a.path.localeCompare(b.path));
    const abstain = (reason) => { const result = []; result.abstained = true; result.reason = reason; return result; };
    if ((minSemanticScore !== undefined || minMargin !== undefined) && !ranked.length) return abstain('no-semantic-results');
    if (minSemanticScore !== undefined && ranked[0].semanticScore < minSemanticScore) return abstain('min-semantic-score');
    // A single candidate has the maximum possible cosine margin.
    if (minMargin !== undefined && (ranked.length > 1 ? ranked[0].semanticScore - ranked[1].semanticScore : 2) < minMargin) return abstain('min-margin');
    const semantic = ranked.filter((item) => item.semanticScore > 0);
    const fused = reciprocalRankFusion([lexical, semantic], { k, weights });
    if (mode === 'semantic-primary') {
      const rank = new Map(lexical.map((item, i) => [item.path, i]));
      fused.sort((a, b) => (b.semanticScore ?? -Infinity) - (a.semanticScore ?? -Infinity)
        || (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity) || a.path.localeCompare(b.path));
    }
    return fused.slice(0, limit);
  } catch {
    // Semantic retrieval is an optional enhancement; provider failures leave BM25F usable.
    return fallback('provider-error');
  }
}
