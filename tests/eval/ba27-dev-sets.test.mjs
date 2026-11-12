// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPages } from '../../packages/core/src/retrieval/index.mjs';
import { caseKind, isPoisonPage, validateCase } from '../../eval/lib/case-schema.mjs';
import { buildTextCorpora } from '../../eval/gen/dev-corpora.mjs';
import { writeLongpage } from '../../eval/gen/longpage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evalDir = path.join(root, 'eval');
const docsDir = path.join(root, 'docs');
const readCases = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const corpusPages = (dir) => new Map(loadPages(dir).map((page) => [page.path, page]));
const topDirs = (dir) => new Set(fs.readdirSync(dir, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => e.name));

function validateSet(corpusDir, casesFile, {projects = null} = {}) {
  const pages = corpusPages(corpusDir);
  const cases = readCases(casesFile);
  assert.ok(Array.isArray(cases), casesFile);
  const ids = new Set();
  for (const item of cases) {
    assert.equal(ids.has(item.id), false, `duplicate id ${item.id}`);
    ids.add(item.id);
    validateCase(item, {paths: pages, projects});
  }
  return {cases, pages};
}

test('hook-realistic set: schema, counts by kind, cwd/project coverage and long briefs', () => {
  const corpus = path.join(evalDir, 'corpus-hook-realistic');
  const projects = new Set(['kestrel-api', 'lumen-web', 'quarry-jobs']);
  assert.deepEqual([...topDirs(corpus)].sort(), ['kestrel-api', 'lumen-web', 'planning', 'quarry-jobs']);
  for (const meta of ['index.md', 'log.md', 'AGENTS.md']) assert.ok(fs.existsSync(path.join(corpus, meta)), meta);
  assert.ok(fs.existsSync(path.join(corpus, 'planning')));
  const meta = JSON.parse(fs.readFileSync(path.join(corpus, 'eval-meta.json'), 'utf8'));
  assert.deepEqual(meta.meta, ['index.md', 'log.md', 'AGENTS.md', 'planning/**']);
  const {cases} = validateSet(corpus, path.join(evalDir, 'dev/hook-realistic-cases.json'), {projects});
  assert.ok(cases.length >= 60, `cases ${cases.length}`);
  const byKind = (kind) => cases.filter((c) => caseKind(c) === kind);
  assert.ok(byKind('operational').length >= 20, 'operational');
  assert.ok(byKind('followup').length >= 10, 'followup');
  assert.ok(byKind('long-brief').length >= 8, 'long-brief');
  assert.ok(byKind('pasted-error').length >= 8, 'pasted-error');
  assert.ok(byKind('knowledge').length >= 14, 'knowledge');
  for (const item of byKind('operational')) assert.equal(item.abstain, true, item.id);
  for (const item of byKind('long-brief')) assert.ok(item.query.length >= 600, `${item.id} length ${item.query.length}`);
  const scoped = cases.filter((c) => c.cwd && c.project);
  assert.ok(scoped.length >= 15, `cwd+project ${scoped.length}`);
  const ambiguous = scoped.filter((c) => !c.query.toLowerCase().includes(c.project.split('-')[0]));
  assert.ok(ambiguous.length >= 8, `ambiguous ${ambiguous.length}`);
});

test('hook-realistic pages: meta pages are excluded by the meta predicate and no page carries eval_poison', () => {
  const corpus = path.join(evalDir, 'corpus-hook-realistic');
  for (const page of loadPages(corpus)) assert.equal(isPoisonPage(page.frontmatter), false, page.path);
});

test('longpage set: 6 to 8 pages of 30 to 120 KB with many H2/H3 sections and at least 24 expectedHeading cases', () => {
  const corpus = path.join(evalDir, 'corpus-longpage');
  const files = fs.readdirSync(corpus).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 6 && files.length <= 8, `pages ${files.length}`);
  for (const file of files) {
    const text = fs.readFileSync(path.join(corpus, file), 'utf8');
    const size = Buffer.byteLength(text, 'utf8');
    assert.ok(size >= 30 * 1024 && size <= 120 * 1024, `${file} size ${size}`);
    assert.ok((text.match(/^## /gmu) || []).length >= 10, `${file} H2`);
    assert.ok((text.match(/^### /gmu) || []).length >= 30, `${file} H3`);
    assert.ok(/^Güncelleme 2026-\d{2}-\d{2}:/mu.test(text) || /Güncelleme 2026-/u.test(text), `${file} dated update`);
  }
  const {cases} = validateSet(corpus, path.join(evalDir, 'dev/longpage-cases.json'));
  assert.ok(cases.length >= 24, `cases ${cases.length}`);
  for (const item of cases) assert.equal(typeof item.expectedHeading, 'string', item.id);
});

test('temporal set: at least 20 cases in TR and EN with relative and absolute time phrases over a fixed now', () => {
  const corpus = path.join(evalDir, 'corpus-temporal');
  const {cases} = validateSet(corpus, path.join(evalDir, 'dev/temporal-cases.json'));
  assert.ok(cases.length >= 20, `cases ${cases.length}`);
  const text = cases.map((c) => c.query.toLowerCase()).join('\n');
  for (const phrase of ['geçen hafta', 'geçen ay', 'dün', 'bu hafta', 'son karar', 'last month', 'latest', '2026-10']) {
    assert.ok(text.includes(phrase), `phrase ${phrase}`);
  }
  assert.ok(cases.some((c) => c.abstain === true), 'abstaining temporal case');
  assert.ok(cases.filter((c) => typeof c.expectedHeading === 'string').length >= 15, 'expectedHeading cases');
});

test('poison set: at least ten eval_poison pages, at least thirty clean pages and at least twenty cases on clean pages', () => {
  const corpus = path.join(evalDir, 'corpus-poison');
  const pages = loadPages(corpus);
  const poisoned = pages.filter((p) => isPoisonPage(p.frontmatter));
  const clean = pages.filter((p) => !isPoisonPage(p.frontmatter));
  assert.ok(poisoned.length >= 10, `poison ${poisoned.length}`);
  assert.ok(clean.length >= 30, `clean ${clean.length}`);
  const {cases} = validateSet(corpus, path.join(evalDir, 'dev/poison-cases.json'));
  assert.ok(cases.length >= 20, `cases ${cases.length}`);
  const poisonPaths = new Set(poisoned.map((p) => p.path));
  for (const item of cases) for (const relPath of item.relevant) assert.equal(poisonPaths.has(relPath), false, `${item.id} relevant is clean`);
});

test('realDocs set: at least 50 answerable questions and 10 unanswerable ones over the repository docs', () => {
  const {cases} = validateSet(docsDir, path.join(evalDir, 'dev/realdocs-cases.json'));
  const answerable = cases.filter((c) => !c.abstain);
  assert.ok(answerable.length >= 50, `answerable ${answerable.length}`);
  assert.ok(cases.length - answerable.length >= 10, 'unanswerable');
  for (const item of cases) for (const relPath of item.relevant) assert.ok(fs.existsSync(path.join(docsDir, relPath)), `${item.id} ${relPath}`);
});

test('label hygiene: no natural case points to a superseded page, and each changed case keeps its legacy value', () => {
  const corpus = path.join(evalDir, 'corpus-natural');
  const pages = corpusPages(corpus);
  const superseded = new Set([...pages.values()].filter((p) => p.frontmatter.status === 'superseded').map((p) => p.path));
  assert.ok(superseded.size >= 1);
  const cases = readCases(path.join(evalDir, 'dev/natural-cases.json'));
  const changed = cases.filter((c) => Object.hasOwn(c, 'relevantLegacy'));
  assert.deepEqual(changed.map((c) => c.id), ['tr-01', 'tr-02', 'tr-03', 'tr-04', 'tr-05', 'synonym-01', 'synonym-02', 'synonym-07', 'synonym-10', 'typo-01', 'typo-02']);
  for (const item of cases) {
    for (const relPath of item.relevant) assert.equal(superseded.has(relPath), false, `${item.id} relevant ${relPath} is superseded`);
    assert.ok(item.relevant.every((p) => pages.has(p)), `${item.id} relevant exists`);
  }
  for (const item of changed) {
    assert.ok(item.relevantLegacy.some((p) => superseded.has(p)), `${item.id} legacy points to superseded`);
    for (const legacy of item.relevantLegacy) {
      if (superseded.has(legacy)) assert.ok(item.relevant.includes(pages.get(legacy).frontmatter.superseded_by), `${item.id} replacement`);
    }
  }
});

test('generators are deterministic: regenerating into a fresh tree reproduces the committed dev corpora and case files', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ba27-gen-'));
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  buildTextCorpora(tmp);
  writeLongpage(tmp);
  const dirs = ['corpus-hook-realistic', 'corpus-temporal', 'corpus-poison', 'corpus-longpage'];
  const walk = (dir, base) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])).sort();
  for (const dir of dirs) {
    const fresh = walk(path.join(tmp, dir), path.join(tmp, dir));
    assert.deepEqual(walk(path.join(evalDir, dir), path.join(evalDir, dir)), fresh, dir);
    for (const rel of fresh) assert.equal(fs.readFileSync(path.join(tmp, dir, rel), 'utf8'), fs.readFileSync(path.join(evalDir, dir, rel), 'utf8'), `${dir}/${rel}`);
  }
  for (const file of ['hook-realistic-cases.json', 'temporal-cases.json', 'poison-cases.json', 'longpage-cases.json']) {
    assert.equal(fs.readFileSync(path.join(tmp, 'dev', file), 'utf8'), fs.readFileSync(path.join(evalDir, 'dev', file), 'utf8'), file);
  }
});

test('new BA-27 files contain no absolute user paths, e-mail addresses or URLs', () => {
  const targets = [
    ...['corpus-hook-realistic', 'corpus-temporal', 'corpus-poison', 'corpus-longpage'].map((d) => path.join(evalDir, d)),
    ...['hook-realistic-cases.json', 'temporal-cases.json', 'poison-cases.json', 'longpage-cases.json', 'realdocs-cases.json'].map((f) => path.join(evalDir, 'dev', f)),
    path.join(evalDir, 'gen'),
    path.join(evalDir, 'lib/case-schema.mjs'),
    path.join(evalDir, 'grep-baseline.mjs'),
  ];
  const files = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p, {withFileTypes: true}).flatMap((e) => files(path.join(p, e.name))) : [p]);
  const pattern = /\/Users\/|\/home\/|https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+/u;
  for (const target of targets) for (const file of files(target)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), pattern, path.relative(root, file));
});
