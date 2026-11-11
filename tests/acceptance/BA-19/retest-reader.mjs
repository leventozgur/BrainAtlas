// SPDX-License-Identifier: MIT
// BA-19 retest helper: an independent inline-link reader written for this run. It does not import the product or the
// vendored parser. It reads `[text](destination)` the way CommonMark does, including both destination forms:
//   - bare: balanced unescaped parentheses belong to it; whitespace or a control character may only be followed by `)`;
//   - angle-bracket `<...>`: spaces, tabs and other characters are allowed, an unescaped `<` or a line ending is not.
// A backslash before ASCII punctuation is an escape. Fenced code blocks (``` or ~~~) are skipped.
// Node 20 APIs only.

const PUNCT = /[!-/:-@[-`{-~]/;
const CONTROL = /[\x00-\x1f\x7f]/;

/** Inline link destinations of a Markdown text, unescaped. Lines are split on '\n' with a trailing '\r' removed. */
export function readLinks(text) {
  const out = [];
  let fence = null;
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null;
      return;
    }
    if (marker && !(marker[1][0] === '`' && line.slice(marker[0].length).includes('`'))) {
      fence = marker[1];
      return;
    }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] !== '[') continue;
      const close = closeBracket(line, i + 1);
      if (close < 0 || line[close + 1] !== '(') continue;
      const parsed = destinationAt(line, close + 2);
      if (parsed !== null) out.push({ dest: parsed, line: index + 1 });
    }
  });
  return out;
}

function closeBracket(line, from) {
  let depth = 0;
  for (let j = from; j < line.length; j++) {
    if (line[j] === '\\') { j++; continue; }
    if (line[j] === '[') depth++;
    else if (line[j] === ']') {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

function destinationAt(line, start) {
  if (line[start] === '<') {
    let value = '';
    for (let k = start + 1; k < line.length; k++) {
      const c = line[k];
      if (c === '\\' && k + 1 < line.length && PUNCT.test(line[k + 1])) { value += line[k + 1]; k++; continue; }
      if (c === '<') return null;
      if (c === '>') return /^[ \t]*\)/.test(line.slice(k + 1)) ? value : null;
      value += c;
    }
    return null;
  }
  let depth = 0;
  let value = '';
  for (let k = start; k < line.length; k++) {
    const c = line[k];
    if (c === '\\' && k + 1 < line.length && PUNCT.test(line[k + 1])) { value += line[k + 1]; k++; continue; }
    if (/\s/.test(c) || CONTROL.test(c)) {
      return value.length && /^[ \t]*\)/.test(line.slice(k)) ? value : null;
    }
    if (c === '(') { depth++; value += c; continue; }
    if (c === ')') {
      if (depth === 0) return value;
      depth--;
    }
    value += c;
  }
  return null;
}

/** The page path a destination names: `#fragment` and `?query` are not part of it. */
export const pagePathOf = (dest) => dest.replace(/[#?][\s\S]*$/, '');

/** Destinations that are not local page paths: anchor-only, scheme URLs, scheme-relative and absolute paths, empty. */
export const isNonPageDestination = (dest) => dest === '' || dest.startsWith('#') || dest.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(dest);

/** Set of local page paths named by any link in the text (escaped, angle-bracket, anchored or query forms). */
export function linkedPages(text) {
  return new Set(readLinks(text).map((x) => x.dest).filter((d) => !isNonPageDestination(d)).map(pagePathOf).filter(Boolean));
}
