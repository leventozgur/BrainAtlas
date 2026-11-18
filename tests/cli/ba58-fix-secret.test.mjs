// SPDX-License-Identifier: MIT
// BA-58: maintain --fix never plans an index line whose title or summary matches a safety rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../packages/cli/src/index.mjs';
import { applyFix, planFix } from '../../packages/cli/src/maintain-fix.mjs';
import { cleanEnv } from './clean-env.mjs';

const NOW = new Date('2026-11-18T00:00:00Z');
const SECRET = 'sk-ant-api03-QWERTYUIOPASDFGHJKLZXCVBNM';

async function vaultWith(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'ba58-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, 'vault');
  for (const [rel, text] of Object.entries(files)) {
    const file = join(vault, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  }
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  return { root, vault, env: cleanEnv({ HOME: home, BRAINATLAS_OFFLINE: '1' }) };
}

const page = ({ title, body = '' }) =>
  `---\ntype: concept\nstatus: confirmed\ntitle: ${JSON.stringify(title)}\n---\n\n# Notes\n\n${body}\n`;

async function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('');
}

test('a page whose title matches a safety rule is reported as secret-filter and never indexed', async (t) => {
  const f = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n\n- [Other](concepts/other.md)\n',
    'wiki/concepts/other.md': page({ title: 'Other' }),
    'wiki/concepts/leak.md': page({ title: SECRET }),
    'wiki/concepts/clean.md': page({ title: 'Clean page' }),
  });

  const raw = await capture(() => main(['maintain', '--fix', '--plan', '--json', '--vault', f.vault], f.env));
  const planned = JSON.parse(raw);
  assert.equal(planned.mode, 'plan');
  assert.equal(planned.written, false);
  const item = planned.unfixed.find((entry) => entry.reason === 'secret-filter');
  assert.equal(item.kind, 'index-missing');
  assert.equal(item.path, 'wiki/concepts/leak.md');
  assert.equal(item.detail, 'index line not written: secret filter (anthropic)');
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes('sk-ant'), false);

  const applied = await applyFix(f.vault, { now: NOW });
  assert.equal(applied.written, true);
  assert.equal(
    applied.unfixed.some((entry) => entry.reason === 'secret-filter'),
    true
  );
  const index = await readFile(join(f.vault, 'wiki', 'index.md'), 'utf8');
  assert.equal(index.includes('leak.md'), false);
  assert.equal(index.includes('sk-ant'), false);
  assert.match(index, /- \[Clean page\]\(concepts\/clean\.md\)/);
});

test('planFix keeps the clean index line and reports only the rule id for a filtered page', async (t) => {
  const f = await vaultWith(t, {
    'wiki/index.md': '# Wiki Index\n\n## Concepts\n\n- [Other](concepts/other.md)\n',
    'wiki/concepts/other.md': page({ title: 'Other' }),
    'wiki/concepts/leak.md': page({ title: `Notes ${SECRET}` }),
    'wiki/concepts/clean.md': page({ title: 'Clean page' }),
  });
  const result = await planFix(f.vault, { now: NOW });
  assert.deepEqual(
    result.changes.map((change) => change.after),
    ['- [Clean page](concepts/clean.md)']
  );
  const [item] = result.unfixed.filter((entry) => entry.reason === 'secret-filter');
  assert.equal(item.detail, 'index line not written: secret filter (anthropic)');
  assert.equal(
    result.changes.some((change) => String(change.after).includes('leak.md')),
    false
  );
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});
