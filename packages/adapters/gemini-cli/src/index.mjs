// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { atomicWriteFile, resolvePaths, BrainAtlasError } from '@brainatlas/core';

export const id = 'gemini-cli';
export const displayName = 'Gemini CLI';
const BEGIN = '<!-- brainatlas:begin -->';
const END = '<!-- brainatlas:end -->';
const fail = (code, message) => { throw new BrainAtlasError(code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
function home(ctx) { if (!ctx?.env?.HOME) fail('E_NO_HOME', 'HOME must be provided.'); return ctx.env.HOME; }
function paths(ctx) { return ctx.paths || resolvePaths({ env: ctx.env, platform: ctx.platform || ctx.env?.BRAINATLAS_PLATFORM || process.platform }); }
function targets(ctx) {
  const root = ctx.scope === 'vault' ? ctx.vaultDir : home(ctx);
  if (ctx.scope === 'vault' && (!isAbsolute(root || '') || root.split(/[\\/]+/).includes('..'))) fail('E_PATH_ESCAPE', 'Vault directory must be absolute and cannot contain parent segments.');
  return { mcp: join(root, '.gemini', 'settings.json'), instructions: join(root, 'GEMINI.md') };
}
function parseJson(text) {
  if (text.startsWith('\uFEFF')) fail('E_BOM', 'Configuration contains a UTF-8 BOM.');
  if (text.trim() === '') return {};
  try { const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
  catch (error) { if (error?.code) throw error; fail('E_CONFIG_PARSE', 'Configuration JSON is invalid.'); }
}
// Span-based JSON edits preserve bytes outside adapter-owned values.
function sourceTree(text) {
  let i=0; const ws=()=>{while(i<text.length&&/\s/.test(text[i]))i++;};
  const stringEnd=at=>{let p=at+1;while(p<text.length){if(text[p]==='\\'){p+=2;continue;}if(text[p++]==='"')return p;}throw Error();};
  function value(){ws();const start=i,ch=text[i];
    if(ch==='{'){i++;ws();const members=[];while(text[i]!=='}'){ws();const keyStart=i;if(text[i]!=='"')throw Error();const end=stringEnd(i),key=JSON.parse(text.slice(i,end));i=end;ws();if(text[i++]!==':')throw Error();const node=value();members.push({key,keyStart,start:node.start,end:node.end,node});ws();if(text[i]===','){i++;continue;}if(text[i]!=='}')throw Error();}i++;return{type:'object',start,end:i,members};}
    if(ch==='['){i++;ws();const items=[];while(text[i]!==']'){items.push(value());ws();if(text[i]===','){i++;continue;}if(text[i]!==']')throw Error();}i++;return{type:'array',start,end:i,items};}
    if(ch==='"'){i=stringEnd(i);return{type:'scalar',start,end:i};}
    while(i<text.length&&!/[\s,}\]]/.test(text[i]))i++;if(i===start)throw Error();return{type:'scalar',start,end:i};
  }
  try{const root=value();ws();if(i!==text.length||root.type!=='object')throw Error();return root;}catch{fail('E_CONFIG_PARSE','Configuration JSON is invalid.');}
}
function member(node,key){return node?.type==='object'?node.members.find(x=>x.key===key):undefined;}
function indentAt(text,at){const line=text.lastIndexOf('\n',at-1)+1;return text.slice(line,at).match(/^[\t ]*/)?.[0]||'';}
function setMember(text,node,key,value){const old=member(node,key),encoded=JSON.stringify(value);if(old)return text.slice(0,old.start)+encoded+text.slice(old.end);const close=node.end-1,nonempty=node.members.length>0,nl=text.includes('\r\n')?'\r\n':'\n',parent=indentAt(text,node.start),child=nonempty?indentAt(text,node.members[0].keyStart):parent+'  ';return text.slice(0,close)+`${nonempty?',':''}${nl}${child}${JSON.stringify(key)}: ${encoded}${nl}${parent}`+text.slice(close);}
function appendArray(text,node,value){const close=node.end-1,nl=text.includes('\r\n')?'\r\n':'\n',parent=indentAt(text,node.start),child=node.items.length?indentAt(text,node.items[0].start):parent+'  ';return text.slice(0,close)+`${node.items.length?',':''}${nl}${child}${JSON.stringify(value)}${nl}${parent}`+text.slice(close);}
function quote(value){return `"${String(value).replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;}
function geminiSettings(before,ctx){
  const conf=before===null||before.trim()===''?{}:parseJson(before);let text=before===null||before.trim()===''?'{}':before;
  if(conf.mcpServers!==undefined&&(!conf.mcpServers||Array.isArray(conf.mcpServers)||typeof conf.mcpServers!=='object'))fail('E_CONFIG_PARSE','MCP server configuration must be an object.');
  if(conf.hooks!==undefined&&(!conf.hooks||Array.isArray(conf.hooks)||typeof conf.hooks!=='object'))fail('E_CONFIG_PARSE','Hook configuration must be an object.');
  const entry={command:ctx.nodePath,args:[ctx.shimPath,'mcp']};let root=sourceTree(text),mcp=member(root,'mcpServers');
  if(!mcp){text=setMember(text,root,'mcpServers',{});root=sourceTree(text);mcp=member(root,'mcpServers');}
  if(mcp.node.type!=='object')fail('E_CONFIG_PARSE','MCP server configuration must be an object.');
  if(JSON.stringify(conf.mcpServers?.brainatlas)!==JSON.stringify(entry)){text=setMember(text,mcp.node,'brainatlas',entry);root=sourceTree(text);}
  const hook={name:'brainatlas-context',type:'command',command:`${quote(ctx.nodePath)} ${quote(ctx.shimPath)} gemini prompt`,timeout:5000,description:'Add relevant BrainAtlas context before the agent responds.'};
  let hooks=member(root,'hooks');if(!hooks){text=setMember(text,root,'hooks',{});root=sourceTree(text);hooks=member(root,'hooks');}
  if(hooks.node.type!=='object')fail('E_CONFIG_PARSE','Hook configuration must be an object.');
  let event=member(hooks.node,'BeforeAgent');if(!event){text=setMember(text,hooks.node,'BeforeAgent',[]);root=sourceTree(text);hooks=member(root,'hooks');event=member(hooks.node,'BeforeAgent');}
  if(event.node.type!=='array'||!Array.isArray(conf.hooks?.BeforeAgent??[]))fail('E_CONFIG_PARSE','BeforeAgent hooks must be an array.');
  const exists=(conf.hooks?.BeforeAgent??[]).some(g=>g?.matcher==='*'&&Array.isArray(g.hooks)&&g.hooks.some(h=>h?.name==='brainatlas-context'&&h.type==='command'&&h.command===hook.command));
  if(!exists)text=appendArray(text,event.node,{matcher:'*',hooks:[hook]});return text;
}
async function read(file) { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function blockText() {
  const body = 'Use BrainAtlas in pull mode: query relevant project knowledge with the BrainAtlas wiki_query MCP tool when it can inform the task. Treat retrieved pages as evidence, verify them against the current project, and cite page paths when reporting findings.';
  return `${BEGIN}\n<!-- brainatlas:sha256:${digest(body)} -->\n${body}\n${END}`;
}
function getBlock(text) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + 1) >= 0 || text.indexOf(END, end + 1) >= 0) fail('E_MANAGED_BLOCK_EDITED', 'Managed instructions block is damaged.');
  const raw = text.slice(start, end + END.length);
  const match = raw.match(/<!-- brainatlas:sha256:([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- brainatlas:end -->$/);
  if (!match || digest(match[2]) !== match[1]) fail('E_MANAGED_BLOCK_EDITED', 'Managed instructions block was edited.');
  return { start, end: end + END.length };
}
function appendBlock(before) { const old = getBlock(before); if (old) return before.slice(0, old.start) + blockText() + before.slice(old.end); return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${blockText()}\n`; }
function changes(ctx, values) {
  const f = targets(ctx), result = [];
  const before = values[f.mcp];
  if (!ctx.nodePath || !ctx.shimPath) fail('E_ARGUMENT', 'nodePath and shimPath are required.');
  const updated=geminiSettings(before,ctx);
  if(updated!==before) result.push({file:f.mcp,kind:before===null?'create':'modify',before,after:updated,ownership:'json-key'});
  const md = values[f.instructions]; const after = appendBlock(md ?? '');
  if (after !== (md ?? '')) result.push({ file: f.instructions, kind: md === null ? 'create' : 'modify', before: md, after, ownership: md === null ? 'whole-file' : 'marked-block' });
  return result;
}
export function detect(env) { return Boolean(env && typeof env.HOME === 'string' && (env.GEMINI_CLI === '1' || env.GEMINI_CLI_ENTRYPOINT || env.GEMINI_SESSION_ID)); }
export function plan(ctx) {
  home(ctx); const f = targets(ctx), values = {};
  for (const file of [f.mcp, f.instructions]) { try { values[file] = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') values[file] = null; else throw e; } }
  return { changes: changes(ctx, values), warnings: [], trustReviewRequired: true };
}
function backup(file, now) { const d = now instanceof Date ? now : new Date(now || Date.now()); return `${file}.bak.${d.toISOString().replaceAll(':','').replaceAll('-','').replaceAll('.','')}`; }
async function state(ctx, file) { const dir = join(paths(ctx).stateDir, 'adapters', id, 'originals'); return { dir, record: join(dir, `${digest(file)}.json`) }; }
async function saveState(ctx, change) { const s = await state(ctx, change.file); await mkdir(s.dir, { recursive: true }); if (await read(s.record) === null) await atomicWriteFile(s.record, JSON.stringify({ file: change.file, existed: change.before !== null, original: change.before, expected: change.after }), { mode: 0o600 }); }
export async function apply(planResult, ctx) {
  if (!planResult || !Array.isArray(planResult.changes)) fail('E_ARGUMENT', 'Adapter plan is invalid.');
  const allowed = new Set(plan(ctx).changes.map(c => c.file));
  if (planResult.changes.some(c => !c || !allowed.has(c.file))) fail('E_PLAN_TARGET', 'Plan contains a file outside this adapter plan.');
  for (const c of planResult.changes) if (await read(c.file) !== c.before) fail('E_CONFIG_CHANGED', 'Configuration changed after planning.');
  // Validate every managed region and JSON document before the first write.
  for (const c of planResult.changes) { if (c.file.endsWith('.json') && c.before !== null) parseJson(c.before); if (c.file.endsWith('.md') && c.before !== null) getBlock(c.before); }
  for (const c of planResult.changes) {
    await saveState(ctx, c);
    if (c.before !== null) await writeFile(backup(c.file, ctx.now), c.before, { flag: 'wx', mode: 0o600 });
    await atomicWriteFile(c.file, c.after, { mode: 0o600 });
    const s = await state(ctx, c.file), rec = JSON.parse(await read(s.record)); rec.expected = c.after;
    await atomicWriteFile(s.record, JSON.stringify(rec), { mode: 0o600 });
  }
}
export async function remove(ctx) {
  const f = targets(ctx), actions = [];
  // Preflight all targets before changing any user file.
  for (const file of [f.mcp, f.instructions]) {
    const s = await state(ctx, file), raw = await read(s.record), current = await read(file);
    let rec;
    if (raw !== null) { try { rec = JSON.parse(raw); } catch { fail('E_STATE_CORRUPT', 'Adapter state is invalid.'); } if (!rec || rec.file !== file || typeof rec.existed !== 'boolean' || typeof rec.expected !== 'string' || (rec.existed && typeof rec.original !== 'string')) fail('E_STATE_CORRUPT', 'Adapter state is invalid.'); }
    if (current === null) { actions.push({ file, record: s.record, cleanup: raw !== null }); continue; }
    if (file === f.instructions) {
      const b = getBlock(current); if (!b) { actions.push({ file, record: s.record, cleanup: raw !== null }); continue; }
      actions.push({ file, record: s.record, cleanup: raw !== null, value: rec && current === rec.expected ? rec.existed ? rec.original : null : current.slice(0,b.start) + current.slice(b.end) });
    } else {
      const obj = parseJson(current);
      if (rec && current === rec.expected) actions.push({ file, record: s.record, cleanup: true, value: rec.existed ? rec.original : null });
      else if (rec) {
        const prior = rec.existed ? parseJson(rec.original).mcpServers?.brainatlas : undefined;
        if (prior !== undefined) { obj.mcpServers ||= {}; obj.mcpServers.brainatlas = prior; }
        else if (obj.mcpServers && Object.hasOwn(obj.mcpServers,'brainatlas')) { delete obj.mcpServers.brainatlas; if (!Object.keys(obj.mcpServers).length) delete obj.mcpServers; }
        actions.push({ file, record: s.record, cleanup: true, value: stringify(obj,current) });
      } else actions.push({ file, record: s.record, cleanup: false });
    }
  }
  for (const a of actions) { if (a.value === null) await unlink(a.file); else if (a.value !== undefined) await atomicWriteFile(a.file,a.value,{mode:0o600}); if (a.cleanup) await unlink(a.record); }
}
export async function doctor(ctx) {
  const f = targets(ctx), checks = [], configText = await read(f.mcp); let registered = false;
  if (configText !== null) { const o = parseJson(configText), e = o.mcpServers?.brainatlas; registered = e?.command === ctx.nodePath && JSON.stringify(e.args) === JSON.stringify([ctx.shimPath,'mcp']); }
  checks.push({ id:'registered', ok:registered, message:registered?'BrainAtlas MCP server is registered.':'BrainAtlas MCP server is not registered.' });
  let shim = false; try { shim = Boolean(ctx.shimPath && (await stat(ctx.shimPath)).isFile()); } catch {}
  checks.push({ id:'shim',ok:shim,message:shim?'Shim file exists.':'Shim file is missing.' });
  checks.push({ id:'version-drift',ok:true,message:'Version drift cannot be determined from adapter configuration.' });
  const hookPresent = configText !== null && (parseJson(configText).hooks?.BeforeAgent || []).some(g => g?.matcher === '*' && Array.isArray(g.hooks) && g.hooks.some(h => h?.name === 'brainatlas-context' && h.type === 'command'));
  checks.push({ id:'hook-present',ok:true,message:hookPresent?'Gemini BeforeAgent hook is registered; enable it in the hooks panel if needed.':'Gemini BeforeAgent hook is not registered; enablement in the hooks panel may be required.' });
  const md = await read(f.instructions); let present = false; if (md !== null) present = Boolean(getBlock(md));
  checks.push({id:'instructions',ok:present,message:present?'BrainAtlas instructions are present.':'BrainAtlas instructions are not present.'});
  return { ok:checks.every(c=>c.ok), checks };
}
export async function trustReview(_ctx) { return { required:true, client:displayName, steps:['Start a new Gemini CLI session to load the MCP server and instructions.'] }; }
