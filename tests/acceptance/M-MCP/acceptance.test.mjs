import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../../../packages/core/src/config/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const reads = ['wiki_query','wiki_read_page','wiki_read_index','wiki_list_pages','wiki_status','wiki_lint'];
const writes = ['wiki_write_page','wiki_update_page','wiki_create_entity','wiki_create_concept','wiki_add_crosslinks','wiki_update_index'];
const secret = ['sk', 'proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('-'); // PM: built at runtime so the repo privacy scan stays clean
const page = (title, body) => `---\ntype: entity\ntitle: ${title}\nstatus: active\n---\n${body}\n`;
async function fixture(t, readOnly = false) {
  const dir = await mkdtemp(join(tmpdir(), 'm-mcp-acceptance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), vault = join(dir, 'vault');
  await mkdir(home); await cp(join(root, 'demo-vault'), vault, { recursive: true });
  await writeFile(join(vault,'wiki/entities/retrieval-old.md'), '---\ntype: entity\ntitle: Nebulacharcoalprobe\nstatus: superseded\n---\nnebulacharcoalprobe\n');
  await writeFile(join(vault,'wiki/entities/retrieval-stale.md'), "---\ntype: entity\ntitle: Nebulacharcoalprobe\nstatus: active\nstale_after: '2000-01-01'\n---\nnebulacharcoalprobe\n");
  const config = defaultConfig('lite'); config.vault.path = vault; config.readOnly = readOnly;
  const configFile = join(dir, 'config.json'); await writeFile(configFile, JSON.stringify(config));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root,'packages/mcp/bin/brainatlas-mcp.mjs')], cwd: root,
    env: { HOME: home, XDG_CONFIG_HOME: join(home,'config'), XDG_DATA_HOME: join(home,'data'), XDG_STATE_HOME: join(home,'state'), BRAINATLAS_CONFIG: configFile, BRAINATLAS_VAULT: vault, PATH: process.env.PATH || '' }, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'blind-acceptance', version: '1.0.0' });
  await client.connect(transport); t.after(async () => { await client.close(); });
  return {dir, home, vault, client, stderr: () => stderr};
}
async function call(client, name, args = {}) { return client.callTool({ name, arguments: args }); }
function text(r) { return (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n'); }
function ok(r) { assert.notEqual(r.isError, true, text(r)); return JSON.parse(text(r)); }
function fail(r, code) { assert.equal(r.isError, true, JSON.stringify(r)); if (code) assert.match(text(r), new RegExp(code)); }
async function rejected(client, name, args = {}) { try { const r = await call(client,name,args); fail(r); } catch (e) { if (e.name === 'AssertionError') throw e; } }
async function files(dir) { const out = []; for (const e of await readdir(dir,{withFileTypes:true})) { const p = join(dir,e.name); if (e.isDirectory()) out.push(...await files(p)); else if (e.isFile()) out.push(p); } return out; }

test('D-17 list, reads, retrieval and invalid inputs over SDK stdio', async t => {
 const f = await fixture(t), c = f.client;
 assert.deepEqual((await c.listTools()).tools.map(x=>x.name).sort(), [...reads,...writes].sort());
 const q = ok(await call(c,'wiki_query',{query:'nebulacharcoalprobe',limit:2})); assert.ok(q.results.length); assert.ok(q.results.every(x=>typeof x.stale === 'boolean' && x.status !== 'superseded'));
 const freshness = ok(await call(c,'wiki_query',{query:'nebulacharcoalprobe'}));
 assert.ok(freshness.results.some(x=>x.path.endsWith('retrieval-stale.md') && x.stale === true));
 assert.ok(!freshness.results.some(x=>x.path.endsWith('retrieval-old.md')));
 assert.equal(ok(await call(c,'wiki_query',{query:'',limit:0})).abstained,true);
 assert.equal(ok(await call(c,'wiki_query',{query:'zzzxqvnonexistentword'})).abstained,true);
 await rejected(c,'wiki_query',{query:12}); await rejected(c,'wiki_query',{query:'x',limit:21});
 assert.match(ok(await call(c,'wiki_read_page',{path:'wiki/entities/sample-01.md'})).content,/Synthetic bilingual/);
 fail(await call(c,'wiki_read_page',{path:'../outside.md'}),'E_PATH_ESCAPE');
 assert.match(ok(await call(c,'wiki_read_index')).content,/Wiki index/i);
 assert.ok(ok(await call(c,'wiki_list_pages',{type:'entities'})).pages.every(p=>p.startsWith('wiki/entities/')));
 assert.deepEqual(ok(await call(c,'wiki_list_pages',{type:'does-not-exist'})).pages,[]);
 assert.equal(ok(await call(c,'wiki_status')).readOnly,false);
 assert.ok(Array.isArray(ok(await call(c,'wiki_lint')).findings));
 await rejected(c,'wiki_list_pages',{type:7});
 // Force real filesystem error paths for tools with empty schemas.
 await rm(join(f.vault,'wiki/index.md'));
 fail(await call(c,'wiki_read_index'));
 await rm(join(f.vault,'wiki'),{recursive:true,force:true});
 fail(await call(c,'wiki_status'));
});

test('lint reports an unavailable wiki as an error', async t => {
 const f = await fixture(t); await rm(join(f.vault,'wiki'),{recursive:true,force:true});
 fail(await call(f.client,'wiki_lint')); 
});

test('all write tools: success, invalid operations, log and refreshed retrieval', async t => {
 const f=await fixture(t), c=f.client;
 const p='entities/acceptance-probe.md', body=page('Quasarwaterfallprobe','quasarwaterfallprobe evidence');
 assert.equal(ok(await call(c,'wiki_write_page',{path:p,content:body})).written,true);
 assert.ok((await readFile(join(f.vault,'wiki/log.md'),'utf8')).includes('write-page'));
 assert.ok(ok(await call(c,'wiki_query',{query:'quasarwaterfallprobe'})).results.some(x=>x.path.endsWith('acceptance-probe.md')));
 fail(await call(c,'wiki_write_page',{path:'../escape.md',content:body}),'E_PATH_ESCAPE');
 assert.equal(ok(await call(c,'wiki_update_page',{path:p,patch:{append:'\nUpdated evidence.'}})).updated,true);
 fail(await call(c,'wiki_update_page',{path:p}),'E_INVALID_INPUT');
 for (const [name,label] of [['wiki_create_entity','Acceptance Entity'],['wiki_create_concept','Acceptance Concept']]) {
   assert.equal(ok(await call(c,name,{name:label,content:'Evidence.'})).created,true);
   fail(await call(c,name,{name:label,content:'Duplicate.'}),'E_ALREADY_EXISTS');
   await rejected(c,name,{name:'',content:'x'});
 }
 ok(await call(c,'wiki_write_page',{path:'entities/acceptance-links.md',content:page('Links','[Sample](sample-01.md)')}));
 assert.equal(ok(await call(c,'wiki_add_crosslinks',{path:'entities/acceptance-links.md'})).linked,1);
 fail(await call(c,'wiki_add_crosslinks',{path:'../escape.md'}),'E_PATH_ESCAPE');
 assert.ok(ok(await call(c,'wiki_update_index')).indexed > 0);
 await rm(join(f.vault,'wiki/index.md')); await symlink(join(f.dir,'outside-index.md'),join(f.vault,'wiki/index.md'));
 fail(await call(c,'wiki_update_index'),'E_PATH_ESCAPE');
});

test('readOnly hides and rejects every write operation', async t => {
 const f=await fixture(t,true), c=f.client;
 assert.deepEqual((await c.listTools()).tools.map(x=>x.name).sort(),reads.sort());
 assert.equal(ok(await call(c,'wiki_status')).readOnly,true);
 const args = [{path:'entities/forbidden.md',content:page('Forbidden','text')},{path:'entities/sample-01.md',patch:{append:'x'}},{name:'Forbidden Entity',content:'x'},{name:'Forbidden Concept',content:'x'},{path:'entities/sample-01.md'},{}];
 for (let i=0;i<writes.length;i++) await rejected(c,writes[i],args[i]);
 await assert.rejects(readFile(join(f.vault,'wiki/entities/forbidden.md')),{code:'ENOENT'});
});

test('secrets and escaping paths cannot write or leak into outputs, logs or state', async t => {
 const f=await fixture(t), c=f.client, outside=join(f.dir,'outside.md'); await writeFile(outside,'untouched');
 const original=await readFile(join(f.vault,'wiki/entities/sample-01.md'),'utf8');
 for (const [name,args] of [
  ['wiki_write_page',{path:'entities/secret-probe.md',content:`password: ${secret}`}],
  ['wiki_update_page',{path:'entities/sample-01.md',patch:{append:`\npassword: ${secret}`}}],
  ['wiki_create_entity',{name:'Secret Probe Entity',content:`password: ${secret}`}],
  ['wiki_create_concept',{name:'Secret Probe Concept',content:`password: ${secret}`}]
 ]) { const r=await call(c,name,args); fail(r,'E_SECRET_DETECTED'); assert.ok(!JSON.stringify(r).includes(secret)); }
 await assert.rejects(readFile(join(f.vault,'wiki/entities/secret-probe.md')),{code:'ENOENT'});
 assert.equal(await readFile(join(f.vault,'wiki/entities/sample-01.md'),'utf8'),original);
 await symlink(outside,join(f.vault,'wiki/entities/escape-link.md'));
 for (const path of ['../outside.md',outside,'wiki/../outside.md','entities/escape-link.md','entities/../../outside.md']) {
  const r=await call(c,'wiki_write_page',{path,content:page('Escape','text')}); fail(r,'E_PATH_ESCAPE');
 }
 assert.equal(await readFile(outside,'utf8'),'untouched');
 for (const p of await files(f.dir)) assert.ok(!(await readFile(p)).includes(Buffer.from(secret)),`secret persisted: ${p}`);
 assert.equal(f.stderr(), '');
});


test('managed log symlink cannot modify a file outside the vault', async t => {
 const f=await fixture(t), outside=join(f.dir,'outside-log.md');
 await writeFile(outside,'untouched'); await rm(join(f.vault,'wiki/log.md')); await symlink(outside,join(f.vault,'wiki/log.md'));
 const result=await call(f.client,'wiki_write_page',{path:'entities/log-probe.md',content:page('Log Probe','evidence')});
 fail(result,'E_PATH_ESCAPE'); assert.equal(await readFile(outside,'utf8'),'untouched');
});


test('derived crosslink and index writes reject secret-bearing source data', async t => {
 const f=await fixture(t), c=f.client;
 const source=join(f.vault,'wiki/entities/derived-secret.md');
 await writeFile(source,page('Derived source',`password: ${secret}`));
 const before=await readFile(source,'utf8');
 const cross=await call(c,'wiki_add_crosslinks',{path:'entities/derived-secret.md'});
 fail(cross,'E_SECRET_DETECTED'); assert.ok(!text(cross).includes(secret)); assert.equal(await readFile(source,'utf8'),before);
 await writeFile(source,page(JSON.stringify(`password: ${secret}`),'ordinary body'));
 const index=join(f.vault,'wiki/index.md'), original=await readFile(index,'utf8');
 const r=await call(c,'wiki_update_index'); fail(r,'E_SECRET_DETECTED'); assert.ok(!text(r).includes(secret));
 assert.equal(await readFile(index,'utf8'),original);
});
