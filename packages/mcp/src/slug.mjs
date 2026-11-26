// SPDX-License-Identifier: MIT
import * as wiki from '@llmwiki/core';

const TURKISH = {
  ç: 'c',
  Ç: 'c',
  ğ: 'g',
  Ğ: 'g',
  ı: 'i',
  İ: 'i',
  ö: 'o',
  Ö: 'o',
  ş: 's',
  Ş: 's',
  ü: 'u',
  Ü: 'u',
};

export function pageSlug(name) {
  const mapped = Array.from(name, (ch) => TURKISH[ch] ?? ch).join('');
  const decomposed = mapped.normalize('NFKD').replace(/\p{M}/gu, '');
  return wiki.slugify(decomposed);
}
