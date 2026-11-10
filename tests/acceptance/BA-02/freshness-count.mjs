// SPDX-License-Identifier: MIT
// BA-02 measurement (hypothesis 1): count external edits visible to the next wiki_query over stdio MCP.
// usage: node freshness-count.mjs <repoRoot> [repeats=3]
// Each repeat: fresh vault; each external change is followed by one wiki_query; a step is visible when the
// expected path set is returned exactly. Prints JSON with per-kind counts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [rootArg, repArg = '3'] = process.argv.slice(2);
const root = path.resolve(rootArg);
const { defaultConfig } = await import(path.join(root, 'packages/core/src/config/index.mjs'));
const BIN = path.join(root, 'packages/mcp/bin/brainatlas-mcp.mjs');
const counts = {};
const tally = (kind, ok) => { counts[kind] ??= { visible: 0, total: 0 }; counts[kind].total++; if (ok) counts[kind].visible++; };

async function start(f) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: root,
    env: { HOME: f.home, BRAINATLAS_CONFIG: f.configFile, BRAINATLAS_VAULT: f.vault, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'ba02-count', version: '1' });
  await client.connect(transport);
  return { client, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}
async function hits(c, q) {
  const r = await c.client.callTool({ name: 'wiki_query', arguments: { query: q } });
  if (r.isError) return null;
  return JSON.parse(r.content[0].text).results.map((x) => x.path).sort();
}
const ok = (got, want) => Array.isArray(got) && got.length === want.length && got.every((v, i) => v === want[i]);

for (let rep = 0; rep < Number(repArg); rep++) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ba02-count-'));
  try {
    const vault = path.join(home, 'vault'), wiki = path.join(vault, 'wiki');
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(wiki, 'base.md'), '# Base\nbaseline evidence\n');
    const config = defaultConfig('lite'); config.vault.path = vault; config.retrieval = { ...config.retrieval, abstainThreshold: 0 };
    const configFile = path.join(home, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
    const f = { home, vault, configFile };
    const a = await start(f), b = await start(f);
    try {
      const w = (n, t) => fs.writeFileSync(path.join(wiki, n), t);
      // add (x3 distinct terms)
      for (const [n, term] of [['a1.md', 'ta1term'], ['a2.md', 'ta2term'], ['a3.md', 'ta3term']]) { w(n, `# ${n}\n${term} body\n`); tally('external add', ok(await hits(a, term), [n])); }
      // edit content (x2)
      w('a1.md', '# a1\nre1term body\n'); tally('external edit (different terms)', ok(await hits(a, 're1term'), ['a1.md']));
      tally('external edit: old term gone', ok(await hits(a, 'ta1term'), []));
      // same-size edit with mtime restored
      const ref = fs.lstatSync(path.join(wiki, 'a2.md'), { bigint: true });
      w('a2.md', '# a2\nta2termX body\n'.slice(0, 0) + '# a2\n' + 'wombats body\n'.slice(0, 'wombats body\n'.length));
      execFileSync('python3', ['-c', 'import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))', path.join(wiki, 'a2.md'), ref.atimeNs.toString(), ref.mtimeNs.toString()]);
      tally('same-size edit, mtime restored', ok(await hits(a, 'wombats'), ['a2.md']));
      // rename
      fs.renameSync(path.join(wiki, 'a3.md'), path.join(wiki, 'a3-renamed.md')); tally('external rename', ok(await hits(a, 'ta3term'), ['a3-renamed.md']));
      // delete
      fs.rmSync(path.join(wiki, 'a3-renamed.md')); tally('external delete', ok(await hits(a, 'ta3term'), []));
      // second MCP process writes via MCP, first process queries
      const r = await b.client.callTool({ name: 'wiki_write_page', arguments: { path: 'wiki/p2.md', content: '---\ntitle: P2\n---\n# P2\np2term body\n' } });
      tally('second-MCP-process write', !r.isError && ok(await hits(a, 'p2term'), ['p2.md']));
      // second MCP process deletes via filesystem
      fs.rmSync(path.join(wiki, 'p2.md')); tally('file deleted by other process', ok(await hits(a, 'p2term'), []));
    } finally { await a.close(); await b.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ root, repeats: Number(repArg), counts }));
