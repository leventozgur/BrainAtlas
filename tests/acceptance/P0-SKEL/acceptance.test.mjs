// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { checkRule } from '../../../scripts/guard-lib.mjs';
const root = resolve('.');
const temporary = async (fn) => { const dir = await mkdtemp(join(tmpdir(), 'p0-skel-')); try { await fn(dir); } finally { await rm(dir, {recursive:true, force:true}); } };
const put = async (dir, path, text) => { const file = join(dir,path); await mkdir(dirname(file),{recursive:true}); await writeFile(file,text); };
const run = (args, cwd=root, env={}) => { const childEnv={...process.env,...env}; delete childEnv.NODE_TEST_CONTEXT; return spawnSync(process.execPath,args,{cwd,encoding:'utf8',env:childEnv}); };
const license = '// SPDX-License-Identifier: MIT\n';
for (const [id, good, bad, file] of [
  ['abs-path','/home/you/file','/home/alice/private','notes.txt'],
  ['lite-purity','const value = "ordinary";', 'const provider = "Dropbox";', 'packages/core/src/a.mjs'],
  ['forbidden-api','const value = 1;', 'fs.glob("*");', 'packages/core/src/a.mjs'],
  ['license-header',license+'const x = 1;', '#!/usr/bin/env node\nconst x = 1;', 'packages/core/src/a.mjs'],
]) test(`guard ${id}: temiz ve ihlal`, async () => temporary(async dir => {
  await put(dir,file,good); assert.equal((await checkRule(dir,id)).length,0);
  await put(dir,file,bad); assert.ok((await checkRule(dir,id)).length>0);
}));
for (const source of ['fsp.glob("*")','shell:true','eval("1")','new Function("return 1")']) test(`yasak API: ${source}`, async () => temporary(async dir => {
  await put(dir,'packages/core/src/a.mjs',license+source); assert.ok((await checkRule(dir,'forbidden-api')).length>0);
}));
test('Lite modül adı birleştirilerek gizlenemez', async () => temporary(async dir => {
  await put(dir,'packages/core/src/a.mjs',license+"const optional = 'sync'+'-engine';\n");
  assert.ok((await checkRule(dir,'lite-purity')).length>0, 'birleştirilmiş isteğe bağlı modül adı yakalanmalı');
}));
test('guard symlink üzerinden ürün dosyasını inceler', async () => temporary(async dir => {
  await put(dir,'outside.mjs','shell:true'); await mkdir(join(dir,'packages/core/src'),{recursive:true});
  await symlink(join(dir,'outside.mjs'),join(dir,'packages/core/src/link.mjs'));
  assert.ok((await checkRule(dir,'forbidden-api')).length>0, 'symlink hedefindeki ihlal yakalanmalı veya symlink reddedilmeli');
}));
test('lockfile ve workspace izin listesi, install script ve bozuk JSON', async () => temporary(async dir => {
  const lock = {lockfileVersion:3,packages:{'':{name:'app'}}};
  await put(dir,'package.json',JSON.stringify({name:'app'})); await put(dir,'package-lock.json',JSON.stringify(lock));
  assert.equal((await checkRule(dir,'lockfile')).length,0);
  for (const altered of [ {...lock,packages:{...lock.packages,'node_modules/rogue':{version:'1.0.0'}}}, {...lock,packages:{...lock.packages,'node_modules/yaml':{hasInstallScript:true}}} ]) {
    await put(dir,'package-lock.json',JSON.stringify(altered)); assert.ok((await checkRule(dir,'lockfile')).length>0);
  }
  await put(dir,'package-lock.json','{'); assert.ok((await checkRule(dir,'lockfile')).length>0);
  await put(dir,'package-lock.json',JSON.stringify(lock)); await put(dir,'packages/a/package.json',JSON.stringify({dependencies:{rogue:'1'}})); assert.ok((await checkRule(dir,'lockfile')).length>0);
}));
for (const doc of ['config','module','adapter','transport','hook-io','retrieval','mcp-tools','release']) test(`sözleşme ${doc}: gerekli bölümler`, async () => {
  const text=await readFile(join(root,'docs/contracts',doc+'.md'),'utf8');
  for(const pattern of [/contract-version:\s*1\b/,/## Purpose/i,/## Function signatures/i,/## Input/i,/## Output and errors/i,/## Example/i,/## Security/i,/\bE_[A-Z_]+\b/]) assert.match(text,pattern,`${doc}: ${pattern}`);
});
const signatures = [
 ['packages/core/src/config/index.mjs',{defaultConfig:1,validateConfig:1,loadConfig:1,saveConfig:2,setConfigValue:3,migrateConfig:2}],
 ['packages/core/src/paths/index.mjs',{resolvePaths:1,vaultId:1}], ['packages/core/src/modules/index.mjs',{readModuleManifest:1,discoverModules:1,resolveModuleOrder:1}],
 ['packages/core/src/retrieval/index.mjs',{buildIndex:2,search:3,createSearcher:1,normalizeText:1,stem:1}], ['packages/hooks/src/index.mjs',{runHook:1}], ['packages/mcp/src/index.mjs',{createServer:1,main:0}], ['modules/sync-engine/src/transport.mjs',{createMemoryTransport:0}], ['release/build-release.mjs',{buildRelease:1,verifyRelease:3}],
 ...['claude-code','codex','copilot-vscode','gemini-cli','kiro'].map(a=>[`packages/adapters/${a}/src/index.mjs`,{detect:1,plan:1,apply:2,remove:1,doctor:1,trustReview:1}]),
 ...['okf-strict','receipts','semantic','sync-dropbox','sync-engine','sync-folder','sync-git'].map(a=>[`modules/${a}/src/index.mjs`,{activate:1}])
];
for (const [file, expected] of signatures) test(`stub imzaları: ${file}`,async()=>{
 const mod=await import(pathToFileURL(join(root,file))); const source=await readFile(join(root,file),'utf8');
 for(const [name,count] of Object.entries(expected)) { assert.equal(typeof mod[name],'function',name); const match=mod[name].toString().match(/^(?:async\s+)?(?:function\s*[^ (]*\s*)?\(([^)]*)\)/); assert.ok(match,name); assert.equal(match[1].trim()?match[1].split(',').length:0,count,name); }
});
test('CLI sürüm ve bilinmeyen komut',()=>{
 const version=run(['packages/cli/bin/brainatlas.mjs','--version']); assert.equal(version.status,0,version.stderr); assert.match(version.stdout,/^0\.1\.0-dev\s*$/);
 const bad=run(['packages/cli/bin/brainatlas.mjs','unknown']); assert.equal(bad.status,2);
});
test('test runner filtre, hariç dizinler, hata ve boş sonuç',async()=>temporary(async dir=>{
 await mkdir(join(dir,'scripts'),{recursive:true}); await copyFile(join(root,'scripts/run-tests.mjs'),join(dir,'scripts/run-tests.mjs'));
 const ok="import {test} from 'node:test'; test('ok',()=>{});\n"; const fail="import {test} from 'node:test'; test('FAIL_MARKER',()=>{throw Error('fail')});\n";
 await put(dir,'tests/selected/ok.test.mjs',ok); await put(dir,'tests/fixtures/bad.test.mjs',fail); await put(dir,'tests/node_modules/bad.test.mjs',fail); await put(dir,'tests/other/bad.test.mjs',fail);
 let result=run(['scripts/run-tests.mjs','tests/selected/'],dir); assert.equal(result.status,0,result.stdout+result.stderr); assert.doesNotMatch(result.stdout,/FAIL_MARKER/);
 result=run(['scripts/run-tests.mjs'],dir); assert.notEqual(result.status,0); assert.match(result.stdout,/FAIL_MARKER/); assert.equal((result.stdout.match(/not ok \d+ - FAIL_MARKER/g)||[]).length,1);
 result=run(['scripts/run-tests.mjs','missing/'],dir); assert.notEqual(result.status,0); assert.match(result.stderr,/No test files found/);
}));
test('vendor dist tree hash belgede yazanla eşleşir',async()=>{
 const base=join(root,'vendor/llmwiki-core'); const files=[];
 async function walk(dir) { for(const ent of await readdir(join(base,dir),{withFileTypes:true})) { const path=dir+'/'+ent.name; if(ent.isDirectory()) await walk(path); else if(ent.isFile()) files.push(path); } } await walk('dist'); files.sort();
 const listing=(await Promise.all(files.map(async f=>`${createHash('sha256').update(await readFile(join(base,f))).digest('hex')}  ${f}\n`))).join('');
 const hash=createHash('sha256').update(listing).digest('hex'); const doc=await readFile(join(base,'VENDORED.md'),'utf8'); assert.match(doc,new RegExp(hash));
});
test('Lite kaynaklarında birleştirilmiş isteğe bağlı modül adları yok',async()=>{
 const roots=['packages/core','packages/mcp','packages/hooks','packages/cli','packages/adapters']; const found=[];
 async function walk(dir){ for(const ent of await readdir(join(root,dir),{withFileTypes:true})){const f=dir+'/'+ent.name;if(ent.isDirectory()) await walk(f);else if(ent.isFile() && /\.(?:mjs|js)$/.test(f)){const s=await readFile(join(root,f),'utf8');if(/['"]sync['"]\s*\+\s*['"]-/.test(s)||/['"]drop['"]\s*\+\s*['"]box/i.test(s)) found.push(f);}} }
 for(const dir of roots) await walk(dir); assert.deepEqual(found,[]);
});
test('stub hataları sırları ve yolları dışarı sızdırmaz; HOME ve hedefler değişmez',async()=>temporary(async dir=>{
 const marker='PRIVATE_SENTINEL_7821'; const home=join(dir,'home'); await mkdir(home); const outside=join(dir,'outside'); await writeFile(outside,marker);
 const {saveConfig}=await import('../../../packages/core/src/config/index.mjs'); const {runHook}=await import('../../../packages/hooks/src/index.mjs');
 for(const call of [()=>saveConfig({secret:marker},{paths:{configFile:join(home,'../outside')}}),()=>runHook({stdin:marker,env:{HOME:home},config:{}})]) {
  try { await call(); assert.fail('stub hata üretmeli'); } catch(error) { assert.doesNotMatch(String(error),new RegExp(marker)); }
 }
 assert.equal(await readFile(outside,'utf8'),marker); assert.deepEqual(await readdir(home),[]);
}));
test('izlenen metinlerde yaygın özel anahtar ve token biçimleri yok',async()=>{
 const listed=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}); assert.equal(listed.status,0); const hits=[];
 const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bghp_[A-Za-z0-9]{30,}\b/,/\bAKIA[0-9A-Z]{16}\b/];
 for(const f of listed.stdout.split('\0').filter(Boolean).filter(f=>!/^tests\/(core\/safety|acceptance\/C3-SAFETY)\/fixtures\//.test(f))){ /* PM: synthetic secret fixtures are allowed only there (privacy-allow.txt) */let data;try{data=await readFile(join(root,f));}catch{continue;} if(data.includes(0))continue; if(patterns.some(p=>p.test(data.toString('utf8')))) hits.push(f);}
 assert.deepEqual(hits,[]);
});
test('modül entry commands export ve NotImplemented hata sözleşmesi',async()=>{
 for(const name of ['okf-strict','receipts','semantic','sync-dropbox','sync-engine','sync-folder','sync-git']) {
  const mod=await import(pathToFileURL(join(root,`modules/${name}/src/index.mjs`))); assert.equal(typeof mod.commands,'object',`${name}: commands`);
  // PM: once a module is implemented, activate({}) may reject with its own context error instead of NotImplementedError;
  // the contract here is: async activate(ctx) of arity 1 that never resolves silently on an empty context.
  assert.equal(mod.activate.length,1,`${name}: activate arity`);
  await assert.rejects(mod.activate({}));
 }
});
