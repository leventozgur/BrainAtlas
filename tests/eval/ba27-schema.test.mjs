// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KINDS,
  caseKind,
  globToRegExp,
  isPoisonPage,
  loadMetaPredicate,
  validateCase,
} from '../../eval/lib/case-schema.mjs';

const pages = new Map([
  ['kestrel-api/tokens.md', { body: '# Tokens\nrotation text\n## Overlap window\nten minutes\n' }],
  ['lumen-web/routing.md', { body: '# Routing\nroute text\n' }],
  ['index.md', { body: '# Index\n' }],
]);
const projects = new Set(['kestrel-api', 'lumen-web']);
const base = { id: 'c-1', query: 'token rotation overlap', relevant: ['kestrel-api/tokens.md'] };
const check = (item) => validateCase(item, { paths: pages, projects });

test('caseKind defaults to knowledge and accepts only the documented kinds', () => {
  assert.deepEqual(KINDS, ['knowledge', 'operational', 'followup', 'long-brief', 'pasted-error']);
  assert.equal(caseKind({}), 'knowledge');
  assert.equal(caseKind({ kind: 'nonsense' }), 'knowledge');
  assert.equal(caseKind({ kind: 'followup' }), 'followup');
});

test('globs: ** crosses directories, * and ? do not, other characters are literal', () => {
  assert.equal(globToRegExp('planning/**').test('planning/backlog.md'), true);
  assert.equal(globToRegExp('planning/**').test('planning/q4/plan.md'), true);
  assert.equal(globToRegExp('planning/**').test('notes/planning/a.md'), false);
  assert.equal(globToRegExp('index.md').test('index.md'), true);
  assert.equal(globToRegExp('index.md').test('sub/index.md'), false);
  assert.equal(globToRegExp('a*.md').test('a/b.md'), false);
  assert.equal(globToRegExp('a?.md').test('ab.md'), true);
  assert.equal(globToRegExp('a.md').test('axmd'), false);
});

test('meta predicate uses the root defaults without eval-meta.json and the file when present', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba27-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let isMeta = loadMetaPredicate(dir);
  assert.equal(isMeta('index.md'), true);
  assert.equal(isMeta('log.md'), true);
  assert.equal(isMeta('AGENTS.md'), true);
  assert.equal(isMeta('CLAUDE.md'), true);
  assert.equal(isMeta('planning/backlog.md'), false);
  assert.equal(isMeta('kestrel-api/index.md'), false);
  fs.writeFileSync(
    path.join(dir, 'eval-meta.json'),
    JSON.stringify({ meta: ['index.md', 'planning/**', 'archive/**'] })
  );
  isMeta = loadMetaPredicate(dir);
  assert.equal(isMeta('planning/backlog.md'), true);
  assert.equal(isMeta('archive/2025/old.md'), true);
  assert.equal(isMeta('CLAUDE.md'), false);
  fs.writeFileSync(path.join(dir, 'eval-meta.json'), JSON.stringify({ meta: 'index.md' }));
  assert.throws(() => loadMetaPredicate(dir), /Invalid eval-meta/);
});

test('poison is a page flag read from eval_poison only', () => {
  assert.equal(isPoisonPage({ eval_poison: true }), true);
  assert.equal(isPoisonPage({ eval_poison: 'true' }), true);
  assert.equal(isPoisonPage({ eval_poison: false }), false);
  assert.equal(isPoisonPage({}), false);
  assert.equal(isPoisonPage(undefined), false);
});

test('a well-formed answerable case, an abstaining case and an operational case validate', () => {
  check(base);
  check({ id: 'a-1', query: 'retry budget', relevant: [], abstain: true });
  check({ id: 'o-1', query: 'devam et', relevant: [], abstain: true, kind: 'operational' });
  check({
    ...base,
    id: 'h-1',
    expectedHeading: 'Overlap window',
    cwd: '/srv/work/kestrel-api',
    project: 'kestrel-api',
    kind: 'followup',
  });
});

test('invalid cases are rejected with the rule that failed', () => {
  assert.throws(() => check({ ...base, id: 'bad id' }), /c-1|bad id: id/u);
  assert.throws(() => check({ ...base, query: '  ' }), /query/u);
  assert.throws(() => check({ ...base, relevant: ['missing.md'] }), /exists/u);
  assert.throws(() => check({ ...base, abstain: true }), /abstain consistency/u);
  assert.throws(() => check({ id: 'x', query: 'q', relevant: [] }), /abstain consistency/u);
  assert.throws(() => check({ ...base, kind: 'chatty' }), /kind/u);
  assert.throws(
    () => check({ id: 'o', query: 'devam et', relevant: ['kestrel-api/tokens.md'], kind: 'operational' }),
    /operational/u
  );
  assert.throws(() => check({ ...base, cwd: 'relative/path' }), /cwd/u);
  assert.throws(() => check({ ...base, cwd: '/Users/you/work/kestrel-api', project: 'kestrel-api' }), /cwd/u);
  assert.throws(() => check({ ...base, project: 'Kestrel API' }), /project/u);
  assert.throws(() => check({ ...base, project: 'lumen-web' }), /project matches relevant page/u);
  assert.throws(() => check({ ...base, project: 'quarry-jobs' }), /corpus project directory/u);
  assert.throws(() => check({ ...base, cwd: '/srv/work/lumen-web', project: 'kestrel-api' }), /cwd basename/u);
  assert.throws(() => check({ ...base, poison: true }), /eval_poison/u);
  assert.throws(() => check({ ...base, expectedHeading: 'Not a heading' }), /expectedHeading/u);
  assert.throws(
    () => check({ id: 'e', query: 'q', relevant: [], abstain: true, expectedHeading: 'Overlap window' }),
    /expectedHeading/u
  );
});

test('excluded lists other-project corpus pages: disjoint from relevant and outside the case project', () => {
  check({
    ...base,
    id: 'x-1',
    project: 'kestrel-api',
    cwd: '/srv/work/kestrel-api',
    excluded: ['lumen-web/routing.md'],
  });
  check({ ...base, id: 'x-2', excluded: [] });
  assert.throws(() => check({ ...base, excluded: ['missing.md'] }), /excluded exists/u);
  assert.throws(() => check({ ...base, excluded: 'lumen-web/routing.md' }), /excluded exists/u);
  assert.throws(() => check({ ...base, excluded: ['kestrel-api/tokens.md'] }), /excluded disjoint/u);
  assert.throws(
    () =>
      check({
        ...base,
        project: 'kestrel-api',
        cwd: '/srv/work/kestrel-api',
        excluded: ['kestrel-api/tokens.md', 'lumen-web/routing.md'],
      }),
    /excluded disjoint/u
  );
  const other = {
    id: 'x-3',
    query: 'testi düzelt',
    relevant: ['lumen-web/routing.md'],
    project: 'lumen-web',
    cwd: '/srv/work/lumen-web',
  };
  assert.throws(() => check({ ...other, excluded: ['lumen-web/routing.md'] }), /excluded disjoint/u);
  assert.throws(
    () => check({ ...other, excluded: ['kestrel-api/tokens.md', 'lumen-web/index.md'] }),
    /excluded exists/u
  );
});
