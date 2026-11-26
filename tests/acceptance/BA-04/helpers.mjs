// SPDX-License-Identifier: MIT
import { buildIndex, search } from '../../../packages/core/src/retrieval/index.mjs';

export const NOW = new Date('2026-11-11T00:00:00Z');

export function page(relPath, body, frontmatter = {}) {
  const headings = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim());
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : headings[0] || relPath.replace(/\.md$/, '');
  return { path: relPath, title, aliases: [], keywords: [], headings, body, frontmatter };
}

export function indexOf(pages) {
  return buildIndex(pages, { now: NOW });
}

export function run(pages, query, options = {}) {
  return search(indexOf(pages), query, { limit: 10, asOf: NOW, ...options });
}
