// SPDX-License-Identifier: MIT
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SYLLABLES = ['ka', 'lo', 'mi', 'ren', 'tu', 'sa', 'vel', 'dor', 'qua', 'fin', 'bro', 'zel', 'nim', 'hap', 'ose', 'tri', 'gul', 'ash', 'wen', 'pax'];

/**
 * Seeded PRNG (mulberry32). The same seed always yields the same sequence.
 * @param {number} seed
 * @returns {() => number} values in [0, 1)
 */
export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWord(rng) {
  const count = 2 + Math.floor(rng() * 3);
  let word = '';
  for (let i = 0; i < count; i++) word += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
  return word;
}

/**
 * Generate a deterministic synthetic vault of Markdown pages with no real content.
 * Every page has frontmatter, a title, three headed sections and a fixed-size body.
 * @param {string} dir existing empty directory
 * @param {{pages:number,seed?:number,wordsPerPage?:number,queryCount?:number}} options
 * @returns {{paths:string[],queries:string[]}} page paths and queries drawn from page vocabulary
 */
export function writeSyntheticCorpus(dir, {pages, seed = 1, wordsPerPage = 120, queryCount = 30}) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 50000) throw new Error('Invalid page count');
  const rng = createRng(seed);
  const pageWords = [];
  const paths = [];
  for (let i = 0; i < pages; i++) {
    const relPath = `topic-${String(i % 40).padStart(2, '0')}/page-${String(i).padStart(5, '0')}.md`;
    const words = [];
    for (let w = 0; w < wordsPerPage; w++) words.push(makeWord(rng));
    const title = `${words[0]} ${words[1]} notes`;
    const sections = [0, 1, 2].map((s) => `## ${words[3 + s * 5]} ${words[4 + s * 5]}\n${words.slice(10 + s * 30, 40 + s * 30).join(' ')}`).join('\n\n');
    const body = `# ${title}\n\n${sections}\n`;
    const full = join(dir, relPath);
    mkdirSync(dirname(full), {recursive: true});
    writeFileSync(full, `---\ntitle: ${title}\nstatus: active\ngenerated: "2026-01-01"\n---\n${body}`, 'utf8');
    paths.push(relPath);
    pageWords.push(words);
  }
  const queries = [];
  for (let q = 0; q < queryCount; q++) {
    const words = pageWords[Math.floor(rng() * pageWords.length)];
    const first = words[Math.floor(rng() * 10)];
    const second = words[10 + Math.floor(rng() * 20)];
    queries.push(`${first} ${second}`);
  }
  return {paths, queries};
}

/**
 * Deterministic fixed-length vectors for the fake embedding provider.
 * @param {number} seed
 * @param {number} count
 * @param {number} dims
 * @returns {number[][]}
 */
export function fixedVectors(seed, count, dims) {
  const rng = createRng(seed);
  return Array.from({length: count}, () => Array.from({length: dims}, () => rng() * 2 - 1));
}
