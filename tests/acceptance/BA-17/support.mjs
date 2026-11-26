// SPDX-License-Identifier: MIT
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKTREE_ROOT = path.resolve(here, '../../..');
export const ROOT = process.env.BA17_ROOT ? path.resolve(process.env.BA17_ROOT) : WORKTREE_ROOT;
export const retrievalUrl = pathToFileURL(path.join(ROOT, 'packages/core/src/retrieval/index.mjs')).href;
export const configUrl = pathToFileURL(path.join(ROOT, 'packages/core/src/config/index.mjs')).href;
export const mcpBin = path.join(ROOT, 'packages/mcp/bin/brainatlas-mcp.mjs');
export const goldenFile = path.join(here, 'fixtures/golden-search.json');

export const NOW = new Date('2026-11-11T00:00:00Z');

export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

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
