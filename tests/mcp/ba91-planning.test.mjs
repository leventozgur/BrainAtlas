// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { initVault } from '../../packages/core/src/vault/index.mjs';
import { callToolInProcess, createServer } from '../../packages/mcp/src/index.mjs';
import { projectDocument } from '../../packages/mcp/src/planning.mjs';

const today = () => new Date().toISOString().slice(0, 10);

async function write(dir, rel, text) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fixture(t, { readOnly = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'ba91-planning-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await initVault(vault);
  const config = defaultConfig('lite');
  config.vault.path = vault;
  config.readOnly = readOnly;
  const options = {
    config,
    paths: { vaultDir: vault, stateDir: join(home, 'state') },
    env: { HOME: home, BRAINATLAS_PLATFORM: 'linux' },
  };
  const call = async (name, args = {}, settings = {}) => callToolInProcess({ ...options, ...settings }, name, args);
  const ok = async (name, args = {}, settings = {}) => {
    const result = await call(name, args, settings);
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text);
  };
  const fail = async (name, args = {}, settings = {}) => {
    const result = await call(name, args, settings);
    assert.equal(result.isError, true, result.text);
    return result.text;
  };
  return { base, home, vault, options, call, ok, fail, projectDir: join(vault, 'planning', 'projects') };
}

async function directCall(options, name, args = {}) {
  const server = createServer(options);
  const client = new Client({ name: 'ba91-direct', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

test('the backlog and project templates carry the standard planning layout', async () => {
  const backlog = await readFile(resolve('templates/vault/backlog.md'), 'utf8');
  assert.match(backlog, /^# Project Backlog\n\nUpdated: <date>\n\n## Projects\n\n/u);
  assert.ok(backlog.includes('| ID | Project | Purpose (one line) | Priority | Status (mirror) | Project file |'));
  assert.ok(backlog.includes('Planning items are not authorization to execute work.'));
  const projectTemplate = await readFile(resolve('templates/vault/project.md'), 'utf8');
  assert.equal(
    await projectDocument({ id: 'PRJ-001', title: 'Demo', status: 'idea', goal: 'First' }),
    projectTemplate
      .replace('<ID>', 'PRJ-001')
      .replace('<Title>', 'Demo')
      .replace('<status>', 'idea')
      .replace('<purpose>', 'First')
  );
  assert.equal(
    await readFile(resolve('templates/vault/project.md'), 'utf8'),
    '# <ID> · <Title>\n\nStatus: <status>\n\n## Goal\n\n<purpose>\n\n## Tasks\n\n## Evidence\n\n## History\n'
  );
});

test('plan_read reports a missing backlog and orphan project files', async (t) => {
  const f = await fixture(t);
  await unlink(join(f.vault, 'planning/backlog.md'));
  assert.deepEqual(await f.ok('plan_read', {}), {
    projects: [],
    warnings: ['planning/backlog.md is missing.'],
  });
  await write(f.vault, 'planning/backlog.md', '# Project Backlog\n\nUpdated: 2026-11-25\n');
  await write(f.vault, 'planning/projects/orphan.md', '# Orphan\n');
  assert.deepEqual(await f.ok('plan_read', {}), {
    projects: [],
    warnings: ['planning/projects/orphan.md is not listed in backlog.md.'],
  });
});

test('add_project uses the next id, the template, the table row and one plan-update log entry', async (t) => {
  const f = await fixture(t);
  const first = await f.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  assert.equal(first.id, 'PRJ-001');
  assert.equal(first.file, 'planning/projects/alpha.md');
  const second = await f.ok('plan_update', {
    op: 'add_project',
    slug: 'beta',
    title: 'Beta',
    purpose: 'Second',
    status: 'ready',
    priority: 'P1',
  });
  assert.equal(second.id, 'PRJ-002');
  assert.equal(
    await readFile(join(f.vault, 'planning/projects/alpha.md'), 'utf8'),
    '# PRJ-001 · Alpha\n\nStatus: idea\n\n## Goal\n\nFirst\n\n## Tasks\n\n## Evidence\n\n## History\n'
  );
  const list = await f.ok('plan_read', {});
  assert.deepEqual(list.projects[1], {
    id: 'PRJ-002',
    title: 'Beta',
    purpose: 'Second',
    priority: 'P1',
    status: 'ready',
    file: 'projects/beta.md',
  });
  const backlog = await readFile(join(f.vault, 'planning/backlog.md'), 'utf8');
  assert.ok(backlog.includes(`Updated: ${today()}`));
  assert.ok(backlog.includes('| PRJ-002 | Beta | Second | P1 | ready | [projects/beta.md](projects/beta.md) |'));
  const log = await readFile(join(f.vault, 'wiki/log.md'), 'utf8');
  assert.equal((log.match(/"action":"plan-update"/gu) ?? []).length, 2);
  assert.ok(log.includes('"path":"planning/projects/beta.md"'));
  assert.match(
    await f.fail('plan_update', { op: 'add_project', slug: 'alpha', title: 'Again', purpose: 'Again' }),
    /^E_CONFLICT:/
  );
});

test('plan-update log lines have the same shape as Wiki log lines', async (t) => {
  const f = await fixture(t);
  await f.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  await f.ok('wiki_write_page', { path: 'concepts/log-shape.md', content: '# Log shape\n' });
  const log = await readFile(join(f.vault, 'wiki/log.md'), 'utf8');
  const entries = log.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(entries.some((line) => line.includes('"action":"plan-update"')));
  assert.ok(entries.some((line) => line.includes('"action":"write-page"')));
  for (const line of entries) {
    assert.match(line, /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \{"action":"[a-z-]+","path":"[^"]+"\}$/u);
    assert.deepEqual(Object.keys(JSON.parse(line.slice(line.indexOf('{')))), ['action', 'path']);
  }
  assert.ok(entries.some((line) => line.includes('"path":"planning/projects/alpha.md"')));
});

test('add_project refuses an existing slug and a file on disk, and validates the fields', async (t) => {
  const f = await fixture(t);
  await f.ok('plan_update', { op: 'add_project', slug: 'taken', title: 'Taken', purpose: 'One' });
  assert.match(
    await f.fail('plan_update', { op: 'add_project', slug: 'taken', title: 'Other', purpose: 'Two' }),
    /^E_CONFLICT:/
  );
  await write(f.vault, 'planning/projects/unlisted.md', '# Unlisted\n');
  assert.match(
    await f.fail('plan_update', { op: 'add_project', slug: 'unlisted', title: 'Other', purpose: 'Two' }),
    /^E_CONFLICT:/
  );
  for (const args of [
    { op: 'add_project', slug: 'Bad Slug', title: 'T', purpose: 'P' },
    { op: 'add_project', slug: 'ok', title: 'two\nlines', purpose: 'P' },
    { op: 'add_project', slug: 'ok', title: 'a|b', purpose: 'P' },
    { op: 'add_project', slug: 'ok', title: '', purpose: 'P' },
    { op: 'add_project', slug: 'ok', title: '   ', purpose: 'P' },
    { op: 'add_project', slug: 'ok', title: 'T', purpose: '   ' },
    { op: 'add_project', slug: 'ok', title: 'T', purpose: 'P', status: 'later' },
    { op: 'add_task', project: 'taken', title: 'T', status: 'later' },
    { op: 'set_status', project: 'taken', status: 'later' },
    { op: 'unknown' },
  ]) {
    assert.match(await f.fail('plan_update', args), /^E_ARGUMENT: /);
  }
  assert.match(await f.fail('plan_read', { project: 7 }), /^E_ARGUMENT: /);
  assert.match(await f.fail('plan_read', { maxChars: '5' }), /^E_ARGUMENT: /);
  assert.match(
    await f.fail('plan_update', { op: 'add_project', slug: 'ok', title: 'T', purpose: 'P', status: 7 }),
    /^E_ARGUMENT: /
  );
});

test('add_task appends at the end of ## Tasks, dates in UTC and derives the next id', async (t) => {
  const f = await fixture(t);
  await f.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  const task = await f.ok('plan_update', { op: 'add_task', project: 'alpha', title: 'Write it' });
  assert.equal(task.id, 'PRJ-001-1');
  const project = await readFile(join(f.projectDir, 'alpha.md'), 'utf8');
  assert.ok(project.includes(`## Tasks\n\n- [ready] PRJ-001-1 · Write it (${today()})\n\n## Evidence`));
  const show = await f.ok('plan_read', { project: 'PRJ-001' });
  assert.equal(show.file, 'projects/alpha.md');
  assert.deepEqual(show.tasks, [{ id: 'PRJ-001-1', status: 'ready', title: 'Write it', date: today() }]);

  await write(
    f.vault,
    'planning/projects/alpha.md',
    '# PRJ-001 · Alpha\n\nStatus: idea\n\n## Goal\n\nFirst\n\n## Tasks\n\n- [ready] BA-2 · One\n- [done] BA-5 · Two (2026-01-02)\n\n## Evidence\n\n## History\n'
  );
  const next = await f.ok('plan_update', { op: 'add_task', project: 'alpha', title: 'Next', id: undefined });
  assert.equal(next.id, 'BA-6');
  assert.match(
    await f.fail('plan_update', { op: 'add_task', project: 'alpha', title: 'Dup', id: 'BA-5' }),
    /^E_CONFLICT:/
  );
});

test('add_task creates ## Tasks at the end of a free-form project file', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'planning/backlog.md',
    '# Project Backlog\n\nUpdated: 2026-11-25\n\n## Projects\n\n| ID | Project | Purpose (one line) | Priority | Status (mirror) | Project file |\n| --- | --- | --- | --- | --- | --- |\n| PRJ-007 | Free | Free form | — | ready | [projects/free.md](projects/free.md) |\n'
  );
  await write(f.vault, 'planning/projects/free.md', '# PRJ-007 · Free\n\nA free-form note.\n');
  const added = await f.ok('plan_update', { op: 'add_task', project: 'free', title: 'Later' });
  assert.equal(added.id, 'PRJ-007-1');
  assert.equal(
    await readFile(join(f.projectDir, 'free.md'), 'utf8'),
    `# PRJ-007 · Free\n\nA free-form note.\n\n## Tasks\n\n- [ready] PRJ-007-1 · Later (${today()})\n`
  );
  assert.ok((await readFile(join(f.vault, 'planning/backlog.md'), 'utf8')).includes(`Updated: ${today()}`));
});

test('set_status rewrites one task line, or the project Status line and the backlog row', async (t) => {
  const f = await fixture(t);
  await f.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  const task = await f.ok('plan_update', { op: 'add_task', project: 'alpha', title: 'Write it' });
  await f.ok('plan_update', { op: 'set_status', project: 'alpha', task: task.id, status: 'in_progress' });
  let project = await readFile(join(f.projectDir, 'alpha.md'), 'utf8');
  assert.ok(project.includes(`- [in_progress] ${task.id} · Write it (${today()})`));
  assert.ok(project.includes('Status: idea'));
  await f.ok('plan_update', { op: 'set_status', project: 'alpha', status: 'blocked' });
  project = await readFile(join(f.projectDir, 'alpha.md'), 'utf8');
  assert.ok(project.includes('Status: blocked'));
  const backlog = await readFile(join(f.vault, 'planning/backlog.md'), 'utf8');
  assert.ok(backlog.includes('| PRJ-001 | Alpha | First | — | blocked |'));
  assert.match(
    await f.fail('plan_update', { op: 'set_status', project: 'alpha', task: 'BA-404', status: 'done' }),
    /^E_NOT_FOUND: /
  );
});

test('set_status adds a missing Status line after the first heading', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'planning/backlog.md',
    '# Project Backlog\n\n## Projects\n\n| ID | Project | Purpose (one line) | Priority | Status (mirror) | Project file |\n| --- | --- | --- | --- | --- | --- |\n| PRJ-001 | Alpha | First | — | idea | [projects/alpha.md](projects/alpha.md) |\n'
  );
  await write(f.vault, 'planning/projects/alpha.md', '# PRJ-001 · Alpha\n\n## Goal\n\nFirst\n');
  await f.ok('plan_update', { op: 'set_status', project: 'alpha', status: 'done' });
  assert.equal(
    await readFile(join(f.projectDir, 'alpha.md'), 'utf8'),
    '# PRJ-001 · Alpha\nStatus: done\n\n## Goal\n\nFirst\n'
  );
});

test('set_status never rewrites a Status line below the first ## heading', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'planning/backlog.md',
    '# Project Backlog\n\n## Projects\n\n| ID | Project | Purpose (one line) | Priority | Status (mirror) | Project file |\n| --- | --- | --- | --- | --- | --- |\n| PRJ-001 | Alpha | First | — | idea | [projects/alpha.md](projects/alpha.md) |\n'
  );
  await write(
    f.vault,
    'planning/projects/alpha.md',
    '# PRJ-001 · Alpha\n\nStatus: idea\n\n## Goal\n\nFirst\n\n## Evidence\n\nStatus: old evidence\n'
  );
  await f.ok('plan_update', { op: 'set_status', project: 'alpha', status: 'done' });
  let project = await readFile(join(f.projectDir, 'alpha.md'), 'utf8');
  assert.ok(project.startsWith('# PRJ-001 · Alpha\n\nStatus: done\n'));
  assert.ok(project.includes('## Evidence\n\nStatus: old evidence\n'));

  await write(
    f.vault,
    'planning/projects/alpha.md',
    '# PRJ-001 · Alpha\n\n## Goal\n\nFirst\n\n## Evidence\n\nStatus: old evidence\n'
  );
  await f.ok('plan_update', { op: 'set_status', project: 'alpha', status: 'blocked' });
  project = await readFile(join(f.projectDir, 'alpha.md'), 'utf8');
  assert.ok(project.startsWith('# PRJ-001 · Alpha\nStatus: blocked\n'));
  assert.ok(project.includes('## Evidence\n\nStatus: old evidence\n'));
});

test('add_task and set_status report a listed project whose file is missing', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'planning/backlog.md',
    '# Project Backlog\n\n## Projects\n\n| ID | Project | Purpose (one line) | Priority | Status (mirror) | Project file |\n| --- | --- | --- | --- | --- | --- |\n| PRJ-001 | Gone | Missing | — | idea | [projects/gone.md](projects/gone.md) |\n'
  );
  assert.equal(
    await f.fail('plan_update', { op: 'add_task', project: 'gone', title: 'Task' }),
    'E_NOT_FOUND: Project gone is not in planning/backlog.md.'
  );
  assert.equal(
    await f.fail('plan_update', { op: 'set_status', project: 'gone', status: 'done' }),
    'E_NOT_FOUND: Project gone is not in planning/backlog.md.'
  );
});

test('add_project recreates a missing backlog from the template', async (t) => {
  const f = await fixture(t);
  await unlink(join(f.vault, 'planning/backlog.md'));
  const created = await f.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  assert.equal(created.id, 'PRJ-001');
  const backlog = await readFile(join(f.vault, 'planning/backlog.md'), 'utf8');
  const template = await readFile(resolve('templates/vault/backlog.md'), 'utf8');
  assert.ok(backlog.includes('| PRJ-001 | Alpha | First | — | idea | [projects/alpha.md](projects/alpha.md) |'));
  assert.ok(backlog.includes(`Updated: ${today()}`));
  assert.ok(backlog.endsWith('Planning items are not authorization to execute work.\n'));
  assert.notEqual(backlog, template);
});

test('add_task rejects a duplicate id anywhere in the project file, including unknown statuses', async (t) => {
  const f = await fixture(t);
  await write(
    f.vault,
    'planning/backlog.md',
    '# Project Backlog\n\n## Projects\n\n| ID | Project | Purpose (one line) | Priority | Status (mirror) | Project file |\n| --- | --- | --- | --- | --- | --- |\n| PRJ-001 | Alpha | First | — | idea | [projects/alpha.md](projects/alpha.md) |\n'
  );
  await write(
    f.vault,
    'planning/projects/alpha.md',
    '# PRJ-001 · Alpha\n\nStatus: idea\n\n## Tasks\n\n## Evidence\n\n- [weird] BA-1 · Evidence line\n'
  );
  assert.match(
    await f.fail('plan_update', { op: 'add_task', project: 'alpha', title: 'Duplicate', id: 'BA-1' }),
    /^E_CONFLICT: /
  );
});

test('plan updates restore both files when a later write or the log fails', async (t) => {
  const breakLog = async (f) => {
    await rm(join(f.vault, 'wiki/log.md'));
    await mkdir(join(f.vault, 'wiki/log.md'));
  };
  const addProject = await fixture(t);
  const projectBacklog = await readFile(join(addProject.vault, 'planning/backlog.md'), 'utf8');
  await breakLog(addProject);
  const projectResult = await addProject.call('plan_update', {
    op: 'add_project',
    slug: 'rollback',
    title: 'Rollback',
    purpose: 'Fail',
  });
  assert.equal(projectResult.isError, true);
  await assert.rejects(readFile(join(addProject.projectDir, 'rollback.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(addProject.vault, 'planning/backlog.md'), 'utf8'), projectBacklog);

  const addTask = await fixture(t);
  await addTask.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  const taskProjectBefore = await readFile(join(addTask.projectDir, 'alpha.md'), 'utf8');
  const taskBacklogBefore = await readFile(join(addTask.vault, 'planning/backlog.md'), 'utf8');
  await breakLog(addTask);
  const taskResult = await addTask.call('plan_update', { op: 'add_task', project: 'alpha', title: 'Rolled back' });
  assert.equal(taskResult.isError, true);
  assert.equal(await readFile(join(addTask.projectDir, 'alpha.md'), 'utf8'), taskProjectBefore);
  assert.equal(await readFile(join(addTask.vault, 'planning/backlog.md'), 'utf8'), taskBacklogBefore);

  const setStatus = await fixture(t);
  await setStatus.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  const statusProjectBefore = await readFile(join(setStatus.projectDir, 'alpha.md'), 'utf8');
  const statusBacklogBefore = await readFile(join(setStatus.vault, 'planning/backlog.md'), 'utf8');
  await breakLog(setStatus);
  const statusResult = await setStatus.call('plan_update', { op: 'set_status', project: 'alpha', status: 'done' });
  assert.equal(statusResult.isError, true);
  assert.equal(await readFile(join(setStatus.projectDir, 'alpha.md'), 'utf8'), statusProjectBefore);
  assert.equal(await readFile(join(setStatus.vault, 'planning/backlog.md'), 'utf8'), statusBacklogBefore);
});

test('expectedSha256, dryRun, secret scan and read-only registration guard planning writes', async (t) => {
  const f = await fixture(t);
  const created = await f.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  assert.match(
    await f.fail('plan_update', {
      op: 'add_task',
      project: 'alpha',
      title: 'Task',
      expectedSha256: '0'.repeat(64),
    }),
    /^E_CONFLICT: /
  );
  const before = await readFile(join(f.projectDir, 'alpha.md'), 'utf8');
  const dry = await f.ok(
    'plan_update',
    { op: 'add_task', project: 'alpha', title: 'Dry', expectedSha256: created.sha256 },
    { dryRun: true }
  );
  assert.equal(dry.dryRun, true);
  assert.equal(await readFile(join(f.projectDir, 'alpha.md'), 'utf8'), before);
  await f.ok('plan_update', { op: 'add_task', project: 'alpha', title: 'Task' });
  assert.match(
    await f.fail('plan_update', {
      op: 'add_task',
      project: 'alpha',
      title: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
    }),
    /^E_SECRET_DETECTED: /
  );

  const readOnly = await fixture(t, { readOnly: true });
  const server = createServer(readOnly.options);
  const client = new Client({ name: 'ba91-list', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('plan_read'));
    assert.ok(!names.includes('plan_update'));
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test('planning writes refuse a symlinked projects directory', async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, 'outside');
  await mkdir(outside, { recursive: true });
  await rm(f.projectDir, { recursive: true, force: true });
  await symlink(outside, f.projectDir);
  assert.equal(
    await f.fail('plan_update', { op: 'add_project', slug: 'escape', title: 'Escape', purpose: 'Outside' }),
    'E_PATH_ESCAPE: Path is outside planning/.'
  );
});

test('unknown projects are E_NOT_FOUND with the fixed message and content is bounded', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.fail('plan_read', { project: 'missing' }),
    'E_NOT_FOUND: Project missing is not in planning/backlog.md.'
  );
  await f.ok('plan_update', { op: 'add_project', slug: 'alpha', title: 'Alpha', purpose: 'First' });
  const shown = await f.ok('plan_read', { project: 'alpha', maxChars: 6 });
  assert.equal(shown.content, '# PRJ-');
  assert.equal(shown.truncated, true);
  assert.match(await f.fail('plan_read', { maxChars: 0 }), /^E_ARGUMENT: /);
});

test('wiki write tools warn when a page file name looks like planning content', async (t) => {
  const f = await fixture(t);
  const page = await f.ok('wiki_write_page', { path: 'concepts/roadmap.md', content: '# Roadmap\n' });
  assert.deepEqual(page.warnings, ['Planning content belongs in planning/; use plan_update.']);
  const plain = await f.ok('wiki_write_page', { path: 'concepts/alpha.md', content: '# Alpha\n' });
  assert.equal(plain.warnings, undefined);
  const entity = await directCall(f.options, 'wiki_create', { type: 'entity', name: 'Team Tasks', content: 'Body' });
  assert.deepEqual(entity.warnings, ['Planning content belongs in planning/; use plan_update.']);
  const concept = await directCall(f.options, 'wiki_create', { type: 'concept', name: 'Beta', content: 'Body' });
  assert.equal(concept.warnings, undefined);
});
