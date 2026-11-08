// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Split markdown by heading sections, then by a conservative word limit. */
export function markdownChunks(markdown, sourcePath, { maxWords = 180 } = {}) {
  if (typeof markdown !== 'string' || typeof sourcePath !== 'string' || !Number.isInteger(maxWords) || maxWords < 1) {
    throw new TypeError('Invalid chunking input.');
  }
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const content = lines.slice(fmEnd >= 0 ? fmEnd + 1 : 0);
  const title = content.find((line) => /^#\s+/u.test(line))?.replace(/^#\s+/u, '').trim()
    || sourcePath.split('/').at(-1).replace(/\.md$/iu, '');
  const sections = [];
  const stack = [];
  let body = [];
  const flush = () => {
    const text = body.join(' ').trim();
    if (text) sections.push({ headingPath: stack.filter(Boolean).join(' > '), text });
    body = [];
  };
  for (const line of content) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      flush();
      stack.length = heading[1].length - 1;
      stack[stack.length] = heading[2].trim();
    } else if (line.trim()) body.push(line.trim());
  }
  flush();
  if (sections.length === 0) sections.push({ headingPath: '', text: content.join(' ').trim() });

  const chunks = [];
  for (const section of sections) {
    const words = section.text.split(/\s+/u).filter(Boolean);
    for (let start = 0; start < words.length; start += maxWords) {
      const text = words.slice(start, start + maxWords).join(' ');
      chunks.push({
        id: sha256(`${sourcePath}\u001f${section.headingPath}\u001f${start}\u001f${text}`).slice(0, 32),
        path: sourcePath,
        title,
        headingPath: section.headingPath,
        text,
      });
    }
  }
  return chunks;
}
