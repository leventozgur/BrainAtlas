// SPDX-License-Identifier: MIT
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = ['knowledge', 'operational', 'followup', 'long-brief', 'pasted-error'];
export const DEFAULT_META = ['index.md', 'log.md', 'AGENTS.md', 'CLAUDE.md'];
const ID = /^[\w-]{1,64}$/u;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const USER_PATH = /\/Users\/|\/home\/|^[A-Za-z]:\\/u;
const HEADING_LINE = /^#{1,3}[\t ]+(.+)$/u;

export function caseKind(item) {
  return KINDS.includes(item?.kind) ? item.kind : 'knowledge';
}

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

export function loadMetaPredicate(corpusDir) {
  const file = join(corpusDir, 'eval-meta.json');
  let globs = DEFAULT_META;
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray(value.meta) ||
      !value.meta.every((g) => typeof g === 'string' && g.length > 0 && g.length <= 200)
    )
      throw new Error('Invalid eval-meta');
    globs = value.meta;
  }
  const patterns = globs.map(globToRegExp);
  return (relPath) => patterns.some((pattern) => pattern.test(relPath));
}

export function isPoisonPage(frontmatter) {
  return frontmatter?.eval_poison === true || frontmatter?.eval_poison === 'true';
}

function headingExists(body, heading) {
  return String(body)
    .split('\n')
    .some((line) => {
      const match = line.match(HEADING_LINE);
      return Boolean(match) && match[1].trim() === heading;
    });
}

export function validateCase(item, { paths, projects = null }) {
  const fail = (rule) => {
    throw new Error(`${item?.id ?? '?'}: ${rule}`);
  };
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('case is not an object');
  if (typeof item.id !== 'string' || !ID.test(item.id)) fail('id');
  if (typeof item.query !== 'string' || !item.query.trim()) fail('query');
  if (!Array.isArray(item.relevant) || !item.relevant.every((p) => typeof p === 'string')) fail('relevant');
  for (const relPath of item.relevant) if (!paths.has(relPath)) fail(`relevant ${relPath} exists`);
  if (item.abstain !== undefined && typeof item.abstain !== 'boolean') fail('abstain type');
  if ((item.abstain === true) !== (item.relevant.length === 0)) fail('abstain consistency');
  if (item.kind !== undefined && !KINDS.includes(item.kind)) fail('kind');
  if (item.kind === 'operational' && item.abstain !== true) fail('operational cases abstain');
  if (item.category !== undefined && (typeof item.category !== 'string' || !item.category)) fail('category');
  if (item.poison !== undefined) fail('poison is a corpus page flag (eval_poison), not a case field');
  if (item.cwd !== undefined) {
    if (typeof item.cwd !== 'string' || !item.cwd.startsWith('/') || item.cwd.length > 200 || USER_PATH.test(item.cwd))
      fail('cwd');
  }
  if (item.project !== undefined) {
    if (typeof item.project !== 'string' || !PROJECT.test(item.project)) fail('project');
    if (projects && !projects.has(item.project)) fail('project is a corpus project directory');
    if (item.relevant.length && !item.relevant[0].startsWith(`${item.project}/`)) fail('project matches relevant page');
    if (item.cwd !== undefined && item.cwd.split('/').pop() !== item.project) fail('cwd basename matches project');
  }
  if (item.expectedHeading !== undefined) {
    if (typeof item.expectedHeading !== 'string' || !item.expectedHeading.trim()) fail('expectedHeading');
    if (!item.relevant.length || item.abstain === true) fail('expectedHeading only on answerable cases');
    if (!headingExists(paths.get(item.relevant[0]).body, item.expectedHeading))
      fail('expectedHeading is a heading line of relevant[0]');
  }
  if (item.excluded !== undefined) {
    if (!Array.isArray(item.excluded) || !item.excluded.every((p) => typeof p === 'string' && paths.has(p)))
      fail('excluded exists');
    if (item.excluded.some((p) => item.relevant.includes(p))) fail('excluded disjoint from relevant');
    if (item.project && item.excluded.some((p) => p.startsWith(`${item.project}/`)))
      fail('excluded outside the case project');
  }
  if (item.requireAll !== undefined && typeof item.requireAll !== 'boolean') fail('requireAll');
  return item;
}
