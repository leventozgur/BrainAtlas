// SPDX-License-Identifier: MIT
export const reciprocalRank = (results, relevant, limit) => {
  const rank = results.slice(0, limit).findIndex((result) => relevant.includes(result.path));
  return rank < 0 ? 0 : 1 / (rank + 1);
};
export const ndcg = (results, relevant) => {
  let dcg = 0;
  for (const [index, result] of results.slice(0, 10).entries()) {
    if (relevant.includes(result.path)) dcg += 1 / Math.log2(index + 2);
  }
  const idealCount = Math.min(relevant.length, 10);
  let ideal = 0;
  for (let index = 0; index < idealCount; index++) ideal += 1 / Math.log2(index + 2);
  return ideal ? dcg / ideal : 0;
};
export const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};

