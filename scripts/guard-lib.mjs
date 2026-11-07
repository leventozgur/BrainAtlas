// SPDX-License-Identifier: MIT
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const EXCLUDED = new Set(['node_modules', '.git']);
async function walk(root, rel = '') {
  let items; try { items = await readdir(join(root, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const item of items) {
    if (EXCLUDED.has(item.name)) continue;
    const path = join(rel, item.name);
    if (item.isDirectory()) out.push(...await walk(root, path)); else if (item.isFile()) out.push(path);
  }
  return out;
}
const lines = (s) => s.split(/\r?\n/);
function findings(file, content, test) { return lines(content).flatMap((line, i) => test(line) ? [{ file, line: i + 1, rule: 'violation' }] : []); }
async function scanFiles(root, filter, test, id) {
  const out=[];
  for (const file of await walk(root)) if (filter(file)) out.push(...findings(file, await readFile(join(root,file),'utf8'), test).map(f=>({...f,rule:id})));
  return out;
}
const product = (f) => /^(packages|modules|scripts|release)\//.test(f) && !/(^|\/)fixtures\//.test(f) && !/\.test\.mjs$/.test(f);
export async function checkRule(root, id) {
  if (id === 'abs-path') return scanFiles(root, f=>!/(^|\/)vendor\/|(^|\/)node_modules\/|^tests\/guard\/fixtures\//.test(f), line=>/\/Users\/|\/home\//.test(line)&&!/(\/Users\/you|\/home\/you)/.test(line),'abs-path');
  if (id === 'lite-purity') return scanFiles(root, f=>/^(packages\/(core|mcp|hooks|cli)|packages\/adapters)\//.test(f)&&!f.endsWith('.md')&&!f.startsWith('tests/'), line=>/modules\/sync-|keychain|secret-service|launchd|systemd|dropbox/i.test(line),'lite-purity');
  if (id === 'forbidden-api') {
    const forbidden = new RegExp(['\\beval\\s*\\(', 'new\\s+Function\\b', 'shell\\s*:\\s*true', '\\b(?:fs|fsp)\\.glob\\s*\\(', 'process.'+'getBuiltinModule', 'import\\.meta\\.(?:dirname|filename)', 'node:'+'sqlite'].join('|'));
    return scanFiles(root, product, line=>forbidden.test(line),'forbidden-api');
  }
  if (id === 'license-header') {
    const out=[];
    for(const f of await walk(root)) if(product(f)&&/\.(mjs|js)$/.test(f)) { const c=await readFile(join(root,f),'utf8'); const ls=lines(c); const n=ls[0]?.startsWith('#!')?1:0; if(ls[n]!=='// SPDX-License-Identifier: MIT') out.push({file:f,line:n+1,rule:id}); }
    return out;
  }
  if (id === 'lockfile') {
    const out=[]; const lp=join(root,'package-lock.json'); let lock;
    try { lock=JSON.parse(await readFile(lp,'utf8')); } catch { return [{file:'package-lock.json',line:1,rule:id}]; }
    const allowedRoots=['@modelcontextprotocol/sdk','yaml','gray-matter'];
    const workspaces=(lock.packages||{});
    for(const [path,pkg] of Object.entries(workspaces)) if(pkg.hasInstallScript===true) out.push({file:'package-lock.json',line:1,rule:id});
    const allowedNames=new Set(allowedRoots);
    for(const [path,pkg] of Object.entries(workspaces)) if(pkg.name&&/^(?:@brainatlas\/|@llmwiki\/|brainatlas$)/.test(pkg.name)) allowedNames.add(pkg.name);
    const resolveLocked=(from, name) => {
      let cursor=from;
      while (true) {
        const candidate=(cursor ? cursor+'/' : '')+'node_modules/'+name;
        if (Object.hasOwn(workspaces,candidate)) return candidate;
        if (!cursor) return null;
        const cut=cursor.lastIndexOf('/node_modules/');
        cursor=cut>=0 ? cursor.slice(0,cut) : '';
      }
    };
    const reachable=new Set(); const queue=[];
    for(const [path,pkg] of Object.entries(workspaces)) {
      if(path==='' || (!path.startsWith('node_modules/') && !path.includes('/node_modules/'))) {
        for(const name of Object.keys(pkg.dependencies||{})) if(allowedRoots.includes(name)) { const target=resolveLocked(path,name); if(target) queue.push(target); }
      }
    }
    while(queue.length) {
      const path=queue.pop(); if(reachable.has(path)) continue; reachable.add(path);
      const pkg=workspaces[path]||{};
      for(const name of Object.keys(pkg.dependencies||{})) { const target=resolveLocked(path,name); if(target&&!reachable.has(target)) queue.push(target); }
    }
    for(const path of Object.keys(workspaces)) {
      if(!(path.startsWith('node_modules/')||path.includes('/node_modules/'))) continue;
      const marker='/node_modules/'; const at=path.lastIndexOf(marker); const linkedName=path.slice(at+marker.length);
      if(allowedNames.has(linkedName)) continue;
      if(!reachable.has(path)) out.push({file:'package-lock.json',line:1,rule:id});
    }
    for(const file of await walk(root)) if(/(^|\/)package\.json$/.test(file)&&file!=='package-lock.json'&&!file.includes('node_modules/')&&!file.startsWith('tests/')) {
      let p; try{p=JSON.parse(await readFile(join(root,file),'utf8'))}catch{out.push({file,line:1,rule:id});continue;}
      for(const [s] of Object.entries(p.scripts||{})) if(/^(preinstall|install|postinstall|prepare)$/.test(s)) out.push({file,line:1,rule:id});
      for(const field of ['dependencies','devDependencies','optionalDependencies']) for(const name of Object.keys(p[field]||{})) if(!allowedNames.has(name)&&!name.startsWith('@brainatlas/')&&!name.startsWith('@llmwiki/')) out.push({file,line:1,rule:id});
    }
    return out;
  }
  return [];
}
export async function runChecks(root) {
  const ids=['abs-path','lite-purity','forbidden-api','license-header','lockfile'];
  return Promise.all(ids.map(async id=>{const f=await checkRule(root,id);return {id,ok:f.length===0,findings:f};}));
}
