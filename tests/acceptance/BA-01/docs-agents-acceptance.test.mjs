// SPDX-License-Identifier: MIT
// BA-01-F2 regression: the Markdown agent table in docs/user/agents.md must stay one contiguous block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Splits the document into runs of consecutive table rows (lines starting with '|').
function tableRuns(lines) {
  const runs = [];
  let current = null;
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('|')) {
      if (!current) { current = { start: index, end: index }; runs.push(current); }
      current.end = index;
    } else {
      current = null;
    }
  });
  return runs;
}

test('BA-01-F2: the agent table in docs/user/agents.md is one contiguous block with no text between rows', async () => {
  const lines = (await readFile(join(ROOT, 'docs/user/agents.md'), 'utf8')).split(/\r?\n/);
  const runs = tableRuns(lines);
  const agentTable = runs.find(run => lines[run.start].startsWith('| Agent |'));
  assert.ok(agentTable, 'agent table header not found');
  const rows = lines.slice(agentTable.start, agentTable.end + 1);
  assert.equal(rows.length, 7, `expected header + separator + 5 rows, got ${rows.length}`);
  assert.match(rows[1], /^\|-+\|-+\|-+\|$/);
  const pipes = rows.map(row => row.split('|').length);
  assert.ok(pipes.every(n => n === pipes[0]), `inconsistent cell counts: ${pipes}`);
  // Nothing non-blank may sit directly after the table block, and no table row may follow a gap inside it.
  const after = lines[agentTable.end + 1];
  assert.ok(after === undefined || after.trim() === '', `text directly after table: ${after}`);
});

test('BA-01-F2: the paragraph added after the table is separated from it by a blank line', async () => {
  const lines = (await readFile(join(ROOT, 'docs/user/agents.md'), 'utf8')).split(/\r?\n/);
  const idx = lines.findIndex(line => line.startsWith('At session start, the hook provides a short recap'));
  assert.ok(idx > 0, 'recap paragraph not found');
  assert.equal(lines[idx - 1].trim(), '');
  assert.ok(lines[idx - 2].trimStart().startsWith('|'), 'paragraph is expected to follow the agent table');
});
