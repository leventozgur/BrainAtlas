// SPDX-License-Identifier: MIT
// Shared helpers for the BA-17 blind acceptance tests. Hermetic: no network, temp directories only.
// BA17_ROOT selects the product checkout under test (default: this worktree). Pointing it at the main checkout
// reproduces the pre-fix behaviour for the FAIL evidence; nothing else changes.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKTREE_ROOT = path.resolve(here, '../../..');
export const ROOT = process.env.BA17_ROOT ? path.resolve(process.env.BA17_ROOT) : WORKTREE_ROOT;
export const retrievalUrl = pathToFileURL(path.join(ROOT, 'packages/core/src/retrieval/index.mjs')).href;
export const configUrl = pathToFileURL(path.join(ROOT, 'packages/core/src/config/index.mjs')).href;
export const mcpBin = path.join(ROOT, 'packages/mcp/bin/brainatlas-mcp.mjs');
export const goldenFile = path.join(here, 'fixtures/golden-search.json');

// Fixed clock: results never depend on the wall clock.
export const NOW = new Date('2026-11-11T00:00:00Z');

// A lone surrogate: a high surrogate not followed by a low one, or a low one not preceded by a high one.
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// Deterministic PRNG (mulberry32) so generated cases are reproducible.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function page(p, body, extra = {}) {
  return {
    path: p,
    title: extra.title ?? 'Page',
    aliases: extra.aliases ?? [],
    keywords: extra.keywords ?? [],
    headings: extra.headings ?? [],
    body,
    frontmatter: extra.frontmatter ?? {},
  };
}

export async function loadRetrieval() {
  return import(retrievalUrl);
}
