// SPDX-License-Identifier: MIT
// BA-04 tester helpers: in-memory pages shaped like loadPages output. No file access, no network.
import { buildIndex, search } from '../../../packages/core/src/retrieval/index.mjs';

export const NOW = new Date('2026-11-11T00:00:00Z');

/** A page as loadPages would shape it, built from a path, a Markdown body and optional frontmatter. */
export function page(relPath, body, frontmatter = {}) {
  const headings = [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim());
  const title = typeof frontmatter.title === 'string' ? frontmatter.title : (headings[0] || relPath.replace(/\.md$/, ''));
  return { path: relPath, title, aliases: [], keywords: [], headings, body, frontmatter };
}

export function indexOf(pages) {
  return buildIndex(pages, { now: NOW });
}

/** Search an in-memory page set at the fixed as-of date. */
export function run(pages, query, options = {}) {
  return search(indexOf(pages), query, { limit: 10, asOf: NOW, ...options });
}
