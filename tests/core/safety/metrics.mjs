// SPDX-License-Identifier: MIT
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanText } from '../../../packages/core/src/safety/index.mjs';

/**
 * Fixture placeholders keep provider-format synthetic keys out of the repository's plain text (so hosting-side secret scanners
 * do not flag test data); they are expanded only in memory while testing.
 * @param {string} text
 */
export function expandFixture(text) {
  // Prefixes are assembled from parts so this file never contains a provider-format literal either.
  const prefixes = {
    SK_DASH: ['s', 'k-'], GH_P: ['gh', 'p_'], GH_O: ['gh', 'o_'], GH_S: ['gh', 's_'], GH_R: ['gh', 'r_'], GH_U: ['gh', 'u_'], GH_PAT: ['git', 'hub_pat_'],
    XOX_B: ['xo', 'xb-'], XOX_P: ['xo', 'xp-'], XOX_A: ['xo', 'xa-'], XOX_R: ['xo', 'xr-'], XOX_S: ['xo', 'xs-'],
    AWS_AKIA: ['AK', 'IA'], GOOGLE_AIZA: ['AI', 'za'], PEM_BEGIN: ['-----BEG', 'IN'], PEM_END: ['-----E', 'ND'],
  };
  return text
    .replace(/\{\{(SK|RK)_(LIVE|TEST)\}\}/g, (_, kind, mode) => `${kind.toLowerCase()}_${mode.toLowerCase()}_`)
    .replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => (prefixes[name] ? prefixes[name].join('') : whole));
}

/** Count per-file detections; never emit corpus contents or file names. */
export async function metrics(dir) {
  const count = async (name) => {
    const root = join(dir, name);
    const files = (await readdir(root)).filter((file) => file.endsWith('.txt'));
    let detected = 0;
    for (const file of files) if (scanText(expandFixture(await readFile(join(root, file), 'utf8'))).length) detected++;
    return { total: files.length, detected };
  };
  const positive = await count('positive'), negative = await count('negative');
  if (!positive.total || !negative.total) throw new Error('Corpus requires positive and negative examples');
  return { positive, negative, recall: positive.detected / positive.total, falsePositiveRate: negative.detected / negative.total };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await metrics(resolve(process.argv[2] ?? new URL('fixtures', import.meta.url).pathname));
  console.log(JSON.stringify(result));
}
