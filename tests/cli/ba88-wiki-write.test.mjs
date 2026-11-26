// SPDX-License-Identifier: MIT
// BA-88: `brainatlas wiki write` and `brainatlas wiki reindex` run the MCP write handlers in process, and
// `--dry-run` runs every check without writing anything. Hermetic: temporary vault, HOME and state directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultConfig } from '../../packages/core/src/config/index.mjs';
import { formatWikiResult, parseWikiArguments, runWikiCommand } from '../../packages/cli/src/wiki.mjs';
import { callToolInProcess } from '../../packages/mcp/src/index.mjs';
import { cleanEnv } from './clean-env.mjs';

const BIN = resolve('packages/cli/bin/brainatlas.mjs');
const SECRET = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

const frontmatter = (status = 'proposed') =>
  `---\ntype: concept\ntitle: "Example"\ngenerated: "2026-11-01"\nstatus: ${status}\nsources: []\nverified: []\nstale_after: "P90D"\naliases: []\nkeywords: []\n---\n`;
const page = (title, status = 'proposed', body = 'Body text.') =>
  `${frontmatter(status).replace('"Example"', JSON.stringify(title))}\n# ${title}\n\n${body}\n`;

async function write(dir, rel, text) {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ba88-wiki-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  await mkdir(home, { recursive: true });
  await write(
    vault,
    'wiki/index.md',
    '# Wiki Index\n\n## Concepts\n\n- [Alpha custom](concepts/alpha.md) — my summary\n'
  );
  await write(vault, 'wiki/log.md', '# Log\n');
  await write(vault, 'wiki/concepts/alpha.md', page('Alpha'));
  const env = cleanEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    BRAINATLAS_PLATFORM: 'linux',
    BRAINATLAS_OFFLINE: '1',
    BRAINATLAS_VAULT: vault,
    PATH: process.env.PATH || '/usr/bin:/bin',
  });
  const run = (args, options = {}) =>
    spawnSync(process.execPath, [BIN, 'wiki', ...args], {
      env: options.env ?? env,
      input: options.input,
      encoding: 'utf8',
      shell: false,
      timeout: 15000,
    });
  const json = (args, options = {}) => {
    const result = run([...args, '--json'], options);
    assert.equal(result.error, undefined, 'command timed out');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, value: JSON.parse(result.stdout) };
  };
  return { base, home, vault, env, run, json };
}

async function withConfig(f, mutate) {
  const config = defaultConfig('lite');
  config.vault.path = f.vault;
  mutate(config);
  const file = join(f.home, 'brainatlas.json');
  await writeFile(file, JSON.stringify(config));
  return { ...f.env, BRAINATLAS_CONFIG: file };
}

async function snapshot(root) {
  const out = {};
  async function visit(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[childRel] = 'dir';
        await visit(join(dir, entry.name), childRel);
        continue;
      }
      out[childRel] = await readFile(join(dir, entry.name), 'utf8');
    }
  }
  await visit(root, '');
  return out;
}

test('write reads standard input, creates the page, logs one write-page entry and reports the exact JSON shape', async (t) => {
  const f = await fixture(t);
  const created = f.json(['write', 'concepts/example.md'], { input: page('Example') });
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(created.value, {
    ok: true,
    path: 'wiki/concepts/example.md',
    created: true,
    updated: false,
    dryRun: false,
    okfFindings: [],
  });
  assert.match(await readFile(join(f.vault, 'wiki/concepts/example.md'), 'utf8'), /# Example/u);
  const log = await readFile(join(f.vault, 'wiki/log.md'), 'utf8');
  assert.equal(log.match(/"action":"write-page"/gu)?.length, 1);

  const updated = f.json(['write', 'wiki/concepts/example.md'], { input: page('Example', 'proposed', 'New body.') });
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(updated.value.path, 'wiki/concepts/example.md');
  assert.equal(updated.value.created, false);
  assert.equal(updated.value.updated, true);
  assert.match(await readFile(join(f.vault, 'wiki/concepts/example.md'), 'utf8'), /New body\./u);
});

test('write rejects missing, empty, whitespace-only and oversized standard input, and bad paths', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.vault);
  const cases = [[], ['write'], ['write', 'concepts/a.md', 'concepts/b.md'], ['write', 'concepts/not-markdown']];
  for (const args of cases) {
    const result = f.json(args, { input: page('Example') });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.value.error.code, 'E_ARGUMENT', args.join(' '));
  }
  for (const input of ['', '   \n\t']) {
    const result = f.json(['write', 'concepts/empty.md'], { input });
    assert.equal(result.status, 1);
    assert.equal(result.value.error.code, 'E_ARGUMENT');
    assert.equal(result.value.error.message, 'wiki write requires page content on standard input.');
  }
  const large = f.json(['write', 'concepts/large.md'], { input: 'a'.repeat(1_048_577) });
  assert.equal(large.status, 1);
  assert.equal(large.value.error.code, 'E_ARGUMENT');
  assert.equal(large.value.error.message, 'Page content is larger than 1 MiB.');
  const suffix = f.json(['write', 'concepts/not-markdown'], { input: page('Example') });
  assert.equal(suffix.value.error.message, 'wiki write path must end in .md.');
  const badSha = f.json(['write', 'concepts/a.md', '--expect-sha256', 'abc'], { input: page('Example') });
  assert.equal(badSha.status, 1);
  assert.equal(badSha.value.error.code, 'E_ARGUMENT');
  const dryValue = f.json(['write', 'concepts/a.md', '--dry-run=true'], { input: page('Example') });
  assert.equal(dryValue.status, 1);
  assert.equal(dryValue.value.error.code, 'E_ARGUMENT');
  assert.equal(dryValue.value.error.message, '--dry-run does not take a value.');
  const reindexValue = f.json(['reindex', '--dry-run=1']);
  assert.equal(reindexValue.status, 1);
  assert.equal(reindexValue.value.error.code, 'E_ARGUMENT');
  assert.equal(reindexValue.value.error.message, '--dry-run does not take a value.');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('write on a TTY fails without waiting, and an injected stdin string is used directly', async (t) => {
  const f = await fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    await assert.rejects(runWikiCommand(['write', 'concepts/tty.md'], { env: f.env }), {
      code: 'E_ARGUMENT',
      message: 'wiki write requires page content on standard input.',
    });
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete process.stdin.isTTY;
  }
  const result = await runWikiCommand(['write', 'concepts/injected.md', '--json'], {
    env: f.env,
    stdin: page('Injected'),
  });
  assert.equal(result.sub, 'write');
  assert.deepEqual(result.value, {
    ok: true,
    path: 'wiki/concepts/injected.md',
    created: true,
    updated: false,
    dryRun: false,
    okfFindings: [],
  });
});

test('--expect-sha256 writes on a match and returns the hash; a mismatch is E_CONFLICT and changes nothing', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.vault, 'wiki/concepts/alpha.md'));
  const sha = createHash('sha256').update(before).digest('hex');
  const written = f.json(['write', 'concepts/alpha.md', '--expect-sha256', sha], {
    input: page('Alpha', 'proposed', 'Two.'),
  });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.value.created, false);
  assert.match(written.value.sha256, /^[0-9a-f]{64}$/u);

  const after = await readFile(join(f.vault, 'wiki/concepts/alpha.md'));
  const logBefore = await readFile(join(f.vault, 'wiki/log.md'), 'utf8');
  const stale = f.json(['write', 'concepts/alpha.md', '--expect-sha256', sha], {
    input: page('Alpha', 'proposed', 'Three.'),
  });
  assert.equal(stale.status, 1);
  assert.equal(stale.value.error.code, 'E_CONFLICT');
  assert.deepEqual(await readFile(join(f.vault, 'wiki/concepts/alpha.md')), after);
  assert.equal(await readFile(join(f.vault, 'wiki/log.md'), 'utf8'), logBefore);
});

test('--dry-run with --expect-sha256 still checks the hash but returns no sha256', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.vault, 'wiki/concepts/alpha.md'));
  const sha = createHash('sha256').update(before).digest('hex');
  const snapshotBefore = await snapshot(f.vault);
  const dry = f.json(['write', 'concepts/alpha.md', '--dry-run', '--expect-sha256', sha], {
    input: page('Alpha', 'proposed', 'Dry body.'),
  });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.value, {
    ok: true,
    path: 'wiki/concepts/alpha.md',
    created: false,
    updated: true,
    dryRun: true,
    okfFindings: [],
  });
  assert.equal(Object.hasOwn(dry.value, 'sha256'), false, 'no new bytes, so no hash');
  const mismatch = f.json(['write', 'concepts/alpha.md', '--dry-run', '--expect-sha256', 'f'.repeat(64)], {
    input: page('Alpha', 'proposed', 'Dry body.'),
  });
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.value.error.code, 'E_CONFLICT');
  assert.deepEqual(await snapshot(f.vault), snapshotBefore);
});

test('readOnly refuses write and reindex with E_READ_ONLY before reading stdin, and nothing changes', async (t) => {
  const f = await fixture(t);
  const env = await withConfig(f, (config) => {
    config.readOnly = true;
  });
  const before = await snapshot(f.vault);
  const write = f.json(['write', 'concepts/new.md'], { env });
  assert.equal(write.status, 1);
  assert.deepEqual(write.value.error, {
    code: 'E_READ_ONLY',
    message: 'The vault is read-only (readOnly: true).',
  });
  const reindex = f.json(['reindex'], { env });
  assert.equal(reindex.status, 1);
  assert.equal(reindex.value.error.code, 'E_READ_ONLY');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('strict OKF refuses with E_OKF_INVALID and rule ids only; warn writes and returns the findings', async (t) => {
  const f = await fixture(t);
  const strictEnv = await withConfig(f, (config) => {
    config.okf = { level: 'strict' };
  });
  const before = await snapshot(f.vault);
  const refused = f.json(['write', 'concepts/invalid.md'], { input: page('Invalid', 'bogus'), env: strictEnv });
  assert.equal(refused.status, 1);
  assert.equal(refused.value.error.code, 'E_OKF_INVALID');
  assert.match(refused.value.error.message, /status\.invalid/u);
  assert.doesNotMatch(refused.value.error.message, /Body text/u);
  assert.deepEqual(await snapshot(f.vault), before);

  const warn = f.json(['write', 'concepts/warned.md'], { input: page('Warned', 'confirmed') });
  assert.equal(warn.status, 0, warn.stderr);
  assert.equal(warn.value.created, true);
  assert.deepEqual(
    warn.value.okfFindings.map(({ rule, severity }) => ({ rule, severity })),
    [{ rule: 'confirmed.unverified', severity: 'warn' }]
  );
});

test('--dry-run runs the checks and writes no page, index, log line, temp file or lock file', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.vault);
  const dry = f.json(['write', 'concepts/dry.md', '--dry-run'], { input: page('Dry') });
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.value, {
    ok: true,
    path: 'wiki/concepts/dry.md',
    created: true,
    updated: false,
    dryRun: true,
    okfFindings: [],
  });
  const indexDry = f.json(['reindex', '--dry-run']);
  assert.equal(indexDry.status, 0, indexDry.stderr);
  assert.deepEqual(indexDry.value, { ok: true, indexed: 1, added: 0, removed: 0, dryRun: true });
  assert.deepEqual(await snapshot(f.vault), before);
  const names = await readdir(join(f.vault, 'wiki'));
  assert.ok(!names.some((name) => name.includes('tmp') || name.includes('lock')), names.join(','));

  const strictEnv = await withConfig(f, (config) => {
    config.okf = { level: 'strict' };
  });
  const strictDry = f.json(['write', 'concepts/dry-invalid.md', '--dry-run'], {
    input: page('Bad', 'bogus'),
    env: strictEnv,
  });
  assert.equal(strictDry.status, 1);
  assert.equal(strictDry.value.error.code, 'E_OKF_INVALID');
  const secretDry = f.json(['write', 'concepts/dry-secret.md', '--dry-run'], { input: `${page('S')}\n${SECRET}\n` });
  assert.equal(secretDry.status, 1);
  assert.equal(secretDry.value.error.code, 'E_SECRET_DETECTED');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('secret content and escaping paths are refused by the MCP handler with the vault unchanged', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.vault);
  const secret = f.json(['write', 'concepts/secret.md'], { input: `${page('Secret')}\n${SECRET}\n` });
  assert.equal(secret.status, 1);
  assert.equal(secret.value.error.code, 'E_SECRET_DETECTED');
  assert.doesNotMatch(secret.stdout, new RegExp(SECRET, 'u'));
  const escape = f.json(['write', '../outside.md'], { input: page('Outside') });
  assert.equal(escape.status, 1);
  assert.equal(escape.value.error.code, 'E_PATH_ESCAPE');
  assert.deepEqual(await snapshot(f.vault), before);
});

test('a wiki/ symlink leaving the vault is E_PATH_ESCAPE for real and dry-run writes and reindex, writing nothing', async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, 'outside');
  await mkdir(join(outside, 'concepts'), { recursive: true });
  await writeFile(join(outside, 'index.md'), '# Outside\n');
  await writeFile(join(outside, 'concepts/alpha.md'), page('Outside'));
  await rm(join(f.vault, 'wiki'), { recursive: true, force: true });
  await symlink(outside, join(f.vault, 'wiki'), 'dir');
  const outsideBefore = await snapshot(outside);
  const real = f.json(['write', 'concepts/new.md'], { input: page('New') });
  assert.equal(real.status, 1);
  assert.equal(real.value.error.code, 'E_PATH_ESCAPE');
  const dry = f.json(['write', 'concepts/new.md', '--dry-run'], { input: page('New') });
  assert.equal(dry.status, 1);
  assert.equal(dry.value.error.code, 'E_PATH_ESCAPE');
  const reindex = f.json(['reindex']);
  assert.equal(reindex.status, 1);
  assert.equal(reindex.value.error.code, 'E_PATH_ESCAPE');
  const reindexDry = f.json(['reindex', '--dry-run']);
  assert.equal(reindexDry.status, 1);
  assert.equal(reindexDry.value.error.code, 'E_PATH_ESCAPE');
  assert.deepEqual(await snapshot(outside), outsideBefore, 'nothing is written outside the vault');
  assert.deepEqual(await readdir(f.vault), ['wiki'], 'no page, temp file or lock file is left in the vault');
});

test('a vault without wiki/ succeeds in dry-run and is left unchanged', async (t) => {
  const f = await fixture(t);
  const empty = join(f.base, 'empty-vault');
  await mkdir(empty, { recursive: true });
  const env = { ...f.env, BRAINATLAS_VAULT: empty };
  const write = f.json(['write', 'concepts/new.md', '--dry-run'], { input: page('New'), env });
  assert.equal(write.status, 0, write.stderr);
  assert.deepEqual(write.value, {
    ok: true,
    path: 'wiki/concepts/new.md',
    created: true,
    updated: false,
    dryRun: true,
    okfFindings: [],
  });
  const reindex = f.json(['reindex', '--dry-run'], { env });
  assert.equal(reindex.status, 0, reindex.stderr);
  assert.deepEqual(reindex.value, { ok: true, indexed: 0, added: 0, removed: 0, dryRun: true });
  assert.deepEqual(await readdir(empty), [], 'wiki/ is not created by a dry run');
});

test('reindex keeps existing index lines and summaries, adds missing pages, prunes deleted ones and logs once', async (t) => {
  const f = await fixture(t);
  await write(f.vault, 'wiki/concepts/beta.md', page('Beta'));
  await writeFile(
    join(f.vault, 'wiki/index.md'),
    '# Wiki Index\n\n## Concepts\n\n- [Alpha custom](concepts/alpha.md) — my own summary\n- [Gone](concepts/gone.md) — stale entry\n'
  );
  const before = await readFile(join(f.vault, 'wiki/index.md'), 'utf8');
  const result = f.json(['reindex']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.value, { ok: true, indexed: 2, added: 1, removed: 1, dryRun: false });
  const index = await readFile(join(f.vault, 'wiki/index.md'), 'utf8');
  assert.ok(index.includes('- [Alpha custom](concepts/alpha.md) — my own summary'), 'existing line kept byte for byte');
  assert.ok(!index.includes('gone.md'), 'deleted page pruned');
  assert.match(index, /- \[Beta\]\(concepts\/beta\.md\)/u);
  assert.ok(index.startsWith(before.split('\n').slice(0, 5).join('\n')), 'original lines stay in order');
  const log = await readFile(join(f.vault, 'wiki/log.md'), 'utf8');
  assert.equal(log.match(/"action":"update-index"/gu)?.length, 1);
  const positional = f.json(['reindex', 'extra']);
  assert.equal(positional.status, 1);
  assert.equal(positional.value.error.code, 'E_ARGUMENT');
});

test('human output is one summary line plus one line per OKF finding', async (t) => {
  const f = await fixture(t);
  const clean = f.run(['write', 'concepts/clean.md'], { input: page('Clean') });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), 'Wrote wiki/concepts/clean.md (created).');
  const finding = f.run(['write', 'concepts/confirmed.md'], { input: page('Confirmed', 'confirmed') });
  assert.equal(finding.status, 0, finding.stderr);
  assert.equal(
    finding.stdout.trimEnd(),
    'Wrote wiki/concepts/confirmed.md (created).\nwarn confirmed.unverified: Confirmed pages need at least one verified record.'
  );
  const dry = f.run(['write', 'concepts/clean.md', '--dry-run'], { input: page('Clean') });
  assert.equal(dry.stdout.trim(), 'Dry run: wiki/concepts/clean.md would be updated.');
  assert.equal(
    formatWikiResult('reindex', { ok: true, indexed: 1, added: 0, removed: 0, dryRun: false }),
    '{\n  "ok": true,\n  "indexed": 1,\n  "added": 0,\n  "removed": 0,\n  "dryRun": false\n}'
  );
});

test('the unknown-subcommand text, help description and usage line are exact, and unknown tools are refused', async (t) => {
  const f = await fixture(t);
  assert.throws(() => parseWikiArguments(['bogus']), {
    code: 'E_ARGUMENT',
    message: 'wiki requires one of: query, read, index, list, status, lint, write, reindex.',
  });
  const help = spawnSync(process.execPath, [BIN, '--help', '--json'], {
    env: f.env,
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
  });
  assert.equal(help.status, 0, help.stderr);
  const command = JSON.parse(help.stdout).commands.find((item) => item.name === 'wiki');
  assert.equal(
    command.description,
    'Wiki tools from the shell, running the same code as the MCP tools: query, read, index, list, status, lint; write and reindex change the Wiki.'
  );
  assert.match(
    command.usage,
    /write <path> \[--dry-run\] \[--expect-sha256 H\] \(content on stdin\) \| reindex \[--dry-run\]/u
  );
  await assert.rejects(callToolInProcess({}, 'wiki_update_page', {}), { code: 'E_ARGUMENT' });
});
