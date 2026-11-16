// SPDX-License-Identifier: MIT
// BA-21: page slugs transliterate Turkish and accented Latin letters to ASCII.
import * as wiki from '@llmwiki/core';

// Turkish mapping runs before lowercasing: 'İ'.toLowerCase() yields a combining dot.
const TURKISH = {
  'ç': 'c', 'Ç': 'c', 'ğ': 'g', 'Ğ': 'g', 'ı': 'i', 'İ': 'i',
  'ö': 'o', 'Ö': 'o', 'ş': 's', 'Ş': 's', 'ü': 'u', 'Ü': 'u'
};

/** Pure: name -> ASCII slug, or '' when no letter or digit is left. */
export function pageSlug(name) {
  const mapped = Array.from(name, (ch) => TURKISH[ch] ?? ch).join('');
  const decomposed = mapped.normalize('NFKD').replace(/\p{M}/gu, '');
  return wiki.slugify(decomposed);
}
