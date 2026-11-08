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
export function reciprocalRankFusion(resultLists, { k = 60 } = {}) {
  if (!Array.isArray(resultLists) || !Number.isFinite(k) || k < 1) throw new TypeError('Invalid fusion input.');
  const fused = new Map();
  for (const list of resultLists) {
    if (!Array.isArray(list)) throw new TypeError('Fusion lists must be arrays.');
    const seen = new Set();
    list.forEach((item, rank) => {
      const key = item?.path;
      if (typeof key !== 'string' || seen.has(key)) return;
      seen.add(key);
      const value = fused.get(key) ?? { ...item, path: key, rrfScore: 0, sourceRanks: [] };
      value.rrfScore += 1 / (k + rank + 1);
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
export async function searchHybrid({ query, pages, entries, provider, limit = 5, k = 60, asOf = new Date() }) {
  if (typeof query !== 'string' || !Array.isArray(pages) || !Array.isArray(entries)) throw new TypeError('Invalid hybrid search input.');
  const lexicalIndex = buildIndex(pages);
  const lexical = search(lexicalIndex, query, { limit: Math.max(limit * 4, 20) }).results;
  const eligiblePages = new Map(lexicalIndex.docs.map(({ page }) => [page.path, page]));
  try {
    const [queryVector] = await provider.embed([query]);
    const bestByPath = new Map();
    for (const entry of entries) {
      const page = eligiblePages.get(entry?.path);
      if (!page) continue;
      const score = cosineSimilarity(queryVector, entry.vector);
      if (!bestByPath.has(entry.path) || score > bestByPath.get(entry.path).semanticScore) {
        bestByPath.set(entry.path, { path: entry.path, title: page.title, status: typeof page.frontmatter?.status === 'string' ? page.frontmatter.status : null,
          stale: stale(page.frontmatter || {}, asOf), semanticScore: score });
      }
    }
    const semantic = [...bestByPath.values()].filter((item) => item.semanticScore > 0)
      .sort((a, b) => b.semanticScore - a.semanticScore || a.path.localeCompare(b.path));
    return reciprocalRankFusion([lexical, semantic], { k }).slice(0, limit);
  } catch {
    // Semantic retrieval is an optional enhancement; provider failures leave BM25F usable.
    return lexical.slice(0, limit);
  }
}
