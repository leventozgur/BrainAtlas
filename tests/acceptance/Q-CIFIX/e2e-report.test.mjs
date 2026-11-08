// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('e2e-lite MCP failure diagnostics include a fixed stage and bounded message', async () => {
  const source = await readFile(resolve(root, 'tests/e2e/e2e-lite.test.mjs'), 'utf8');
  const start = source.indexOf('async function callInstalledMcp(');
  const end = source.indexOf('\nasync function runSourceSafetyProbes(', start);
  assert.ok(start >= 0 && end > start, 'the MCP diagnostic helper should exist');
  const helper = source.slice(start, end);
  assert.match(helper, /let stage = 'connect'/);
  assert.match(helper, /stage = 'query'/);
  assert.match(helper, /stage = 'write'/);
  assert.match(helper, /clientErrorStage: stage/);
  assert.match(helper, /clientErrorMessage: message/);
  assert.match(helper, /const known = \['Error', 'McpError', 'AbortError', 'AggregateError'\]/);
  assert.match(helper, /cause\?\.message === 'MCP error -32000: Connection closed' \? 'connection-closed' : 'operation-failed'/);

  const catchStart = helper.indexOf('} catch (cause) {');
  const finallyStart = helper.indexOf('\n  } finally {', catchStart);
  assert.ok(catchStart >= 0 && finallyStart > catchStart, 'the MCP catch branch should be bounded');
  const catchBlock = helper.slice(catchStart, finallyStart);
  assert.doesNotMatch(catchBlock, /clientErrorMessage:\s*cause\./, 'raw exception text must not enter diagnostics');
  assert.doesNotMatch(catchBlock, /JSON\.stringify\(cause\)|String\(cause\)|env\.HOME|home\)/, 'exception objects and HOME must not enter diagnostics');
  assert.match(source, /issues\.push\(`mcp-\$\{mcpOutcome\.clientErrorStage\}-\$\{mcpOutcome\.clientErrorMessage\}`\)/);
  assert.match(source, /Lite E2E acceptance checks failed; see issue identifiers in this assertion\./);
});

test('synthetic secret, page text, and fake HOME are absent from allowed error identifiers', () => {
  const fakeHome = resolve('/tmp', ['q-cifix', 'home', 'marker'].join('-'));
  const pageText = ['private', 'page', 'content'].join('-');
  const secret = ['sk', 'test' + 'x'.repeat(24)].join('-');
  const safeError = {
    clientErrorKind: 'McpError',
    clientErrorStage: 'query',
    clientErrorMessage: 'operation-failed'
  };
  const reportIssue = `mcp-${safeError.clientErrorStage}-${safeError.clientErrorMessage}`;
  const serialized = JSON.stringify({ safeError, reportIssue });
  assert.ok(!serialized.includes(secret) && !serialized.includes(pageText) && !serialized.includes(fakeHome));
  assert.match(serialized, /query-operation-failed/);
});

test('an actual e2e-lite connection failure reports stage without child stderr or fake HOME', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'q-cifix-e2e-error-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');

  const source = await readFile(resolve(root, 'tests/e2e/e2e-lite.test.mjs'), 'utf8');
  const start = source.indexOf('async function callInstalledMcp(');
  const end = source.indexOf('\nasync function runSourceSafetyProbes(', start);
  assert.ok(start >= 0 && end > start, 'the MCP diagnostic helper should exist');
  const helper = source.slice(start, end).replace('async function callInstalledMcp(', 'export async function callInstalledMcp(');
  const helperFile = join(temp, 'e2e-helper.mjs');
  await writeFile(helperFile, [
    "import { Client } from '@modelcontextprotocol/sdk/client/index.js';",
    "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';",
    `const root = ${JSON.stringify(root)};`,
    "function syntheticSecret() { return ['ba', 'test' + 'x'.repeat(24)].join('-'); }",
    helper
  ].join('\n'));
  const { callInstalledMcp } = await import(`${new URL(`file://${helperFile}`).href}?run=${Date.now()}`);

  const fakeHome = join(temp, 'fake-home', 'private-marker');
  const secret = ['sk', 'test' + randomBytes(16).toString('hex')].join('-');
  const pageText = ['private', 'page', randomBytes(8).toString('hex')].join('-');
  const child = join(temp, 'failed-cli.mjs');
  await writeFile(child, "process.stderr.write([process.env.HOME, process.env.Q_CIFIX_SECRET, process.env.Q_CIFIX_PAGE].join('|')); process.exit(1);\n");

  const report = await callInstalledMcp(child, {
    HOME: fakeHome,
    PATH: process.env.PATH || '/usr/bin:/bin',
    Q_CIFIX_SECRET: secret,
    Q_CIFIX_PAGE: pageText
  });
  const serialized = JSON.stringify(report);
  assert.ok(report.clientFailed && report.connected === false && report.clientErrorKind === 'McpError');
  assert.ok(report.clientErrorStage === 'connect' && report.clientErrorMessage === 'connection-closed');
  assert.ok(!serialized.includes(fakeHome) && !serialized.includes(secret) && !serialized.includes(pageText));
});
