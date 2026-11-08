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

/** Combine the core BM25F results with page-level cosine-ranked chunks. */
export async function searchHybrid({ query, pages, entries, provider, limit = 5, k = 60 }) {
  if (typeof query !== 'string' || !Array.isArray(pages) || !Array.isArray(entries)) throw new TypeError('Invalid hybrid search input.');
  const lexicalIndex = buildIndex(pages);
  const lexical = search(lexicalIndex, query, { limit: Math.max(limit * 4, 20) }).results;
  const [queryVector] = await provider.embed([query]);
  const bestByPath = new Map();
  for (const entry of entries) {
    const score = cosineSimilarity(queryVector, entry.vector);
    if (!bestByPath.has(entry.path) || score > bestByPath.get(entry.path).semanticScore) {
      bestByPath.set(entry.path, { path: entry.path, title: entry.title, semanticScore: score });
    }
  }
  const semantic = [...bestByPath.values()].filter((item) => item.semanticScore > 0)
    .sort((a, b) => b.semanticScore - a.semanticScore || a.path.localeCompare(b.path));
  return reciprocalRankFusion([lexical, semantic], { k }).slice(0, limit);
}
