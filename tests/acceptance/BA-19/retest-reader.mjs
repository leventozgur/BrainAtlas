// SPDX-License-Identifier: MIT

const PUNCT = /[!-/:-@[-`{-~]/;
// eslint-disable-next-line no-control-regex -- the fixture asserts control-character handling on purpose
const CONTROL = /[\x00-\x1f\x7f]/;

export function readLinks(text) {
  const out = [];
  let fence = null;
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1])
        fence = null;
      return;
    }
    if (marker && !(marker[1][0] === '`' && line.slice(marker[0].length).includes('`'))) {
      fence = marker[1];
      return;
    }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') {
        i++;
        continue;
      }
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
    if (line[j] === '\\') {
      j++;
      continue;
    }
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
      if (c === '\\' && k + 1 < line.length && PUNCT.test(line[k + 1])) {
        value += line[k + 1];
        k++;
        continue;
      }
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
    if (c === '\\' && k + 1 < line.length && PUNCT.test(line[k + 1])) {
      value += line[k + 1];
      k++;
      continue;
    }
    if (/\s/.test(c) || CONTROL.test(c)) {
      return value.length && /^[ \t]*\)/.test(line.slice(k)) ? value : null;
    }
    if (c === '(') {
      depth++;
      value += c;
      continue;
    }
    if (c === ')') {
      if (depth === 0) return value;
      depth--;
    }
    value += c;
  }
  return null;
}

export const pagePathOf = (dest) => dest.replace(/[#?][\s\S]*$/, '');

export const isNonPageDestination = (dest) =>
  dest === '' || dest.startsWith('#') || dest.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(dest);

export function linkedPages(text) {
  return new Set(
    readLinks(text)
      .map((x) => x.dest)
      .filter((d) => !isNonPageDestination(d))
      .map(pagePathOf)
      .filter(Boolean)
  );
}
