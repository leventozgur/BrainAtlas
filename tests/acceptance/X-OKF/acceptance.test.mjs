import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, checkCommand, lintGate } from '../../../modules/okf-strict/src/index.mjs';
import { checkpoint } from '../../../packages/core/src/checkpoint/index.mjs';
import { readModuleManifest } from '../../../packages/core/src/modules/index.mjs';

const root = resolve('.');
const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
const base = { generated: '2026-01-01T12:00:00Z', status: 'proposed', sources: ['src'], verified: [], stale_after: 'P1D' };
const evidence = { date: '2026-01-01', evidence: 'observed', scope: 'test', source: 'src' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'okf-accept-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'wiki'));
  return dir;
}
async function page(dir, name, data = base, body = 'body') {
  await writeFile(join(dir, 'wiki', name), `---\n${Object.entries(data).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n${body}\n`);
}
const run = (dir, flags = []) => checkCommand({vaultDir: dir}, ['--as-of', '2026-01-02', ...flags]);
const rule = (out, name) => out.findings.some(x => x.rule === name && x.severity === 'error');

test('strict evidence requires all fields and a listed source', async t => {
  const dir = await fixture(t);
  for (const [name, records, bad] of [
    ['good', [evidence], false], ['none', [], true], ['missing', [{...evidence, scope: ''}], true],
    ['unlisted', [{...evidence, source: 'other'}], true], ['invalid-date', [{...evidence, date: '2026-02-30'}], true]
  ]) {
    await page(dir, `${name}.md`, {...base, status:'confirmed', verified: records});
    const result = await run(dir, ['--strict', '--changed', `wiki/${name}.md`]);
    assert.equal(rule(result, 'confirmed.unverified'), bad, name);
    assert.equal(result.exitCode, bad ? 1 : 0, name);
  }
});

test('strict generated UTC, stale_after boundaries, and successor resolution', async t => {
  const dir = await fixture(t);
  await page(dir, 'target.md');
  await page(dir, 'old.md', {...base, status:'superseded', superseded_by:'wiki/target.md'});
  assert.equal((await run(dir, ['--strict', '--changed', 'wiki/old.md'])).exitCode, 0);
  for (const target of ['wiki/missing.md', 'wiki/old.md', 'wiki/../target.md']) {
    await page(dir, 'old.md', {...base, status:'superseded', superseded_by:target});
    assert.ok(rule(await run(dir, ['--strict', '--changed', 'wiki/old.md']), 'superseded.target-invalid'), target);
  }
  for (const value of ['P1D','P1W','2026-01-02','2026-01-02T12:00:00Z']) {
    await page(dir, 'value.md', {...base, stale_after:value});
    assert.equal(rule(await run(dir, ['--strict', '--changed', 'wiki/value.md']), 'stale_after.invalid'), false, value);
  }
  for (const value of ['P0D','P-1D','P1M','tomorrow','2026-02-30']) {
    await page(dir, 'value.md', {...base, stale_after:value});
    assert.ok(rule(await run(dir, ['--strict', '--changed', 'wiki/value.md']), 'stale_after.invalid'), value);
  }
  for (const value of ['2026-01-01','2026-01-01T12:00:00+03:00','2026-02-30T12:00:00Z']) {
    await page(dir, 'value.md', {...base, generated:value});
    assert.ok(rule(await run(dir, ['--strict', '--changed', 'wiki/value.md']), 'generated.timestamp-required'), value);
  }
});

test('warn mode reports the same strict violations as warnings', { skip: 'PM: core OKF contract (docs/contracts/okf-rules.md, C4) classifies malformed fields (stale_after/generated/verified invalid) as errors at every level; warn level relaxes policy rules only. Contract wins.' }, async t => {
  const dir = await fixture(t);
  const cases = [
    ['evidence', {...base, status:'confirmed', verified:[]}],
    ['evidence-fields', {...base, status:'confirmed', verified:[{...evidence, scope:''}]}],
    ['evidence-source', {...base, status:'confirmed', verified:[{...evidence, source:'other'}]}],
    ['stale', {...base, stale_after:'P0D'}], ['generated', {...base, generated:'2026-01-01'}],
    ['target', {...base, status:'superseded', superseded_by:'wiki/missing.md'}]
  ];
  for (const [name, data] of cases) {
    await t.test(name, async () => {
      await page(dir, `${name}.md`, data);
      const result = await run(dir, ['--changed', `wiki/${name}.md`]);
      assert.ok(result.findings.some(x => x.severity === 'warn'), 'warning required');
      assert.equal(result.exitCode, 0);
    });
  }
});

test('changed selection, missing page, argument validation, and full UTC day', async t => {
  const dir = await fixture(t);
  await page(dir, 'good.md', {...base, generated:'2026-01-02T23:59:59Z', stale_after:'2026-01-02'});
  await page(dir, 'bad.md', {...base, status:'confirmed'});
  let result = await run(dir, ['--strict','--changed','wiki/good.md','--json']);
  assert.equal(result.exitCode, 0);
  assert.ok(!result.findings.some(x => x.path === 'wiki/bad.md' || x.rule === 'generated.future' || x.rule === 'stale.expired'));
  result = await checkCommand({vaultDir:dir}, ['--strict','--as-of','2026-01-01','--changed','wiki/good.md']);
  assert.ok(rule(result, 'generated.future'));
  assert.ok(rule(await run(dir, ['--strict','--changed','wiki/missing.md']), 'page.unreadable'));
  for (const args of [['--changed'], ['--changed','wiki/../outside.md'], ['--changed','/tmp/x.md'], ['--as-of','2026-02-30'], ['--as-of'], ['--bogus']]) await assert.rejects(checkCommand({vaultDir:dir}, args), TypeError);
});

test('checkpoint refuses invalid pages before staging and accepts a valid gate', async t => {
  const dir = await fixture(t);
  const calls = [];
  const runCommand = async (_cmd, args) => { calls.push(args); if (args[0] === 'rev-parse') return {stdout:'true\n'}; if (args[0] === 'diff') return {stdout:''}; return {stdout:''}; };
  await page(dir, 'bad.md', {...base, status:'confirmed'});
  await assert.rejects(checkpoint(dir, 'test', {runCommand, lintGate: dir => lintGate(dir, undefined, {asOf:'2026-01-02'})}), {code:'E_CHECKPOINT_LINT'});
  assert.equal(calls.some(x => x.includes('commit') || x[0] === 'add'), false);
  await page(dir, 'bad.md', base);
  const result = await checkpoint(dir, 'test', {runCommand, lintGate: dir => lintGate(dir, undefined, {asOf:'2026-01-02'})});
  assert.equal(result.reason, 'no-staged-changes');
  assert.ok(calls.some(x => x[0] === 'add'));
});

test('manifest and mapping follow the public module contract', async () => {
  const manifest = readModuleManifest(join(root, 'modules/okf-strict'));
  assert.equal(manifest.name, 'okf-strict');
  for (const key of ['version','description','entry']) assert.equal(typeof manifest[key], 'string');
  for (const key of ['requires','provides','profiles']) assert.ok(Array.isArray(manifest[key]));
  assert.deepEqual([...manifest.profiles].sort(), ['custom','full']);
  assert.ok(manifest.provides.includes('okf-strict'));
  const mapping = await readFile(join(root, 'modules/okf-strict/docs/okf-mapping.md'), 'utf8');
  assert.match(mapping, /inspired by OKF v0\.2/i);
  assert.doesNotMatch(mapping, /\b(?:is|fully)\s+(?:OKF\s+v0\.2\s+)?compliant\b/i);
  for (const field of ['generated','verified','sources','stale_after','superseded_by']) assert.ok(mapping.includes(field), field);
});

test('body and synthetic secrets do not appear in findings; scan makes no writes', async t => {
  const dir = await fixture(t);
  const body = `private-body-${secret}`;
  await page(dir, 'bad.md', {...base, status:'confirmed'}, body);
  const before = await readFile(join(dir,'wiki/bad.md'), 'utf8');
  const files = await readdir(dir, {recursive:true});
  const out = await run(dir, ['--strict','--json']);
  const text = JSON.stringify(out);
  assert.ok(out.exitCode === 1);
  assert.ok(!text.includes(body) && !text.includes(secret));
  assert.deepEqual(await readdir(dir, {recursive:true}), files);
  assert.equal(await readFile(join(dir,'wiki/bad.md'), 'utf8'), before);
});

test('changed paths cannot traverse a symlinked directory', async t => {
  const dir = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'okf-outside-'));
  t.after(() => rm(outside, {recursive:true, force:true}));
  await writeFile(join(outside, 'secret.md'), `---\ngenerated: "2026-01-01T12:00:00Z"\nstatus: proposed\nsources: []\nverified: []\nstale_after: P1D\n---\n${secret}`);
  await symlink(outside, join(dir, 'wiki/link'));
  const result = await run(dir, ['--strict','--changed','wiki/link/secret.md']);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(result.exitCode !== 0, 'symlinked target must be refused');
});

test('CLI exposes strict JSON checks and process exit status', { skip: 'PM: module commands are loaded only from an installed release (Lite/Full separation); covered by E2E-FULL/E2E-LITE (module add okf-strict) with an installed release.' }, async t => {
  const dir = await fixture(t);
  await page(dir, 'bad.md', {...base, status:'confirmed'});
  const home = join(dir, 'home'); await mkdir(home);
  const proc = spawnSync(process.execPath, [join(root,'packages/cli/bin/brainatlas.mjs'), 'okf', 'check', '--strict', '--json', '--changed', 'wiki/bad.md', '--as-of','2026-01-02'], {cwd:dir, env:{PATH:process.env.PATH, HOME:home}, encoding:'utf8'});
  assert.equal(proc.status, 1);
  const result = JSON.parse(proc.stdout);
  assert.ok(result.findings.some(x => x.rule === 'confirmed.unverified'));
  assert.deepEqual(await readdir(home), []);
});
