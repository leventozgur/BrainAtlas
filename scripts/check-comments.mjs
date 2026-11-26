// SPDX-License-Identifier: MIT
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const DIRECTIVE = /^\/[/*]+!?\s*(?:eslint-|@ts-|prettier-ignore|c8\b|istanbul\b|node:coverage\b)/;
const TAG = /^\s*\*?\s*@(?:type|typedef|template|callback|satisfies|import|param|returns|property|throws)\b/;
const SPDX = /^\/\/ SPDX-License-Identifier:/;
const EXCLUDED = /(^|\/)(vendor|node_modules|fixtures)\/|^release\/dist\//;

function blockLines(text) {
  const lines = text.split('\n');
  return lines.map((raw, i) => {
    let line = raw;
    if (i === 0) line = line.replace(/^\/\*\*?/, '');
    if (i === lines.length - 1) line = line.replace(/\*\/\s*$/, '');
    return line;
  });
}

function violations(comment, source) {
  const text = source.slice(comment.range[0], comment.range[1]);
  if (comment.type === 'Hashbang' && comment.range[0] === 0) return [];
  if (SPDX.test(text) && (comment.range[0] === 0 || (source.startsWith('#!') && comment.loc.start.line === 2)))
    return [];
  if (DIRECTIVE.test(text)) return [];
  if (text.startsWith('/**')) {
    const lines = blockLines(text);
    if (!lines.some((line) => TAG.test(line))) return [comment.loc.start.line];
    return lines.flatMap((line, i) => (line.trim() && !TAG.test(line) ? [comment.loc.start.line + i] : []));
  }
  return [comment.loc.start.line];
}

export function findCommentViolations(root, only = null) {
  const out = [];
  const files =
    only ??
    execFileSync('git', ['ls-files', '*.mjs', '*.js'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file && !EXCLUDED.test(file));
  for (const file of files) {
    let source;
    try {
      source = readFileSync(only ? resolve(file) : join(root, file), 'utf8');
    } catch {
      if (only) out.push({ file, line: 1, problem: 'file not found' });
      continue;
    }
    let ast;
    try {
      ast = /** @type {any} */ (
        espree.parse(source, {
          ecmaVersion: 'latest',
          sourceType: 'module',
          comment: true,
          range: true,
          loc: true,
        })
      );
    } catch (error) {
      out.push({ file, line: error.lineNumber ?? 1, problem: 'parse error' });
      continue;
    }
    for (const comment of ast.comments) for (const line of violations(comment, source)) out.push({ file, line });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  const findings = findCommentViolations(root, args.length ? args : null);
  for (const finding of findings)
    console.log(`${finding.file}:${finding.line}${finding.problem ? ` ${finding.problem}` : ''}`);
  if (findings.length) process.exitCode = 1;
}
