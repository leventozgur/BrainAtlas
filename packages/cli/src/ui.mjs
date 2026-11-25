// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { CHANNEL_AGENTS, CONFIG_SCHEMA, defaultConfig, loadConfig, SEMANTIC_DEFAULTS } from '@brainatlas/core';
import { agentCommand } from './commands/agent.mjs';
import { configCommand } from './commands/config.mjs';
import { summaryInputs } from './commands/lifecycle.mjs';
import { error, exists, redactOutput } from './commands/shared.mjs';
import { moduleCommandReport } from './commands/sync.mjs';
import { buildHealthSummary } from './health.mjs';

const MAX_BODY = 16 * 1024;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const SEMANTIC_NOTE = 'Semantic search needs the Full profile and release. See docs/user/semantic.md.';
const SEMANTIC_LATENCY = 'Each prompt waits up to 350 ms for semantic search.';
const CHANNELS = ['mcp', 'cli'];
// BA-70: the panel edits only these tuning keys (an allowlist, so a key added to the schema later stays closed). Anything
// that can redirect content (semantic.baseUrl, semantic.allowRemote, sync.*), weaken a safety rule (safety.*, readOnly),
// run a command (maintain.synthesis.*, node.path) or move state (vault, stateDir, channels, agents, modules) is absent.
export const EDITABLE_KEYS = new Set([
  'retrieval.budgetChars',
  'retrieval.abstainThreshold',
  'retrieval.pullLowConfidence',
  'hooks.mode',
  'hooks.deadlineMs',
  'hooks.disclosure',
  'okf.level',
  'semantic.enabled',
  'semantic.minScore',
]);

/** BA-87: one short English line per editable key, shown under the control. */
const HELP = Object.freeze({
  'retrieval.budgetChars': 'Maximum characters of retrieved context added to a prompt.',
  'retrieval.abstainThreshold': 'Lowest retrieval confidence before an answer abstains.',
  'retrieval.pullLowConfidence': 'Return low-confidence pull results instead of hiding them.',
  'hooks.mode': 'Hook behaviour: normal, economic (smaller context) or manual.',
  'hooks.deadlineMs': 'Time budget in milliseconds before a hook falls back.',
  'hooks.disclosure': 'How much hook context is disclosed: full or progressive.',
  'okf.level': 'Wiki format check level: warn or strict.',
  'semantic.enabled': 'Turn semantic search over the local provider on or off.',
  'semantic.minScore': 'Lowest similarity score a semantic result needs.',
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BrainAtlas</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0 auto;max-width:56rem;padding:1rem 1rem 3rem}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #8884;padding:.35rem .5rem;text-align:left;font-size:.9rem}
button,select,input{font:inherit}pre{background:#8882;padding:.6rem;overflow:auto;white-space:pre-wrap}h2{margin-top:2rem}
dialog{border:1px solid #8888;border-radius:.5rem;max-width:44rem}menu{display:flex;gap:.5rem;justify-content:flex-end;padding:0}
.help{color:#888;font-size:.8rem}#notes{color:#a60;font-size:.9rem;white-space:pre-wrap}
</style></head><body><h1>BrainAtlas</h1><p id="note"></p>
<h2>Status</h2><table id="summary"></table>
<h2>Agents</h2><table id="agents"></table>
<h2>Settings</h2><table id="settings"></table><div id="notes"></div>
<h2>Result</h2><pre id="out">Nothing yet. Every change asks for confirmation and shows what it will change.</pre>
<dialog id="confirm"><p id="change"></p><p id="extra"></p><menu><button id="ok">Confirm</button><button id="cancel">Cancel</button></menu></dialog>
<script>
const params=new URLSearchParams(location.hash.slice(1));const T=params.get('t')||'';history.replaceState(null,'',location.pathname);
const $=(id)=>document.getElementById(id);
const CHANNEL_LABELS={mcp:'MCP server',cli:'CLI + skill'};
const CHANNEL_TITLES={mcp:'The agent calls BrainAtlas tools over MCP.',cli:'The agent runs the brainatlas CLI, guided by an installed skill file.'};
const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-brainatlas-token':T,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.message||j.error||('HTTP '+r.status));e.payload=j;throw e}return j};
const cell=(row,text,tag='td')=>{const c=document.createElement(tag);c.textContent=text;row.append(c);return c};
const show=(v)=>{$('out').textContent=typeof v==='string'?v:JSON.stringify(v,null,2)};
const dialog=$('confirm');
let pending=null;
const closeDialog=(value)=>{const resolve=pending;pending=null;if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');if(resolve)resolve(value)};
$('ok').onclick=()=>closeDialog(true);$('cancel').onclick=()=>closeDialog(false);
const ask=(text,extra)=>new Promise((resolve)=>{$('change').textContent=text;$('extra').textContent=extra||'';pending=resolve;
 if(typeof dialog.showModal==='function'){try{dialog.showModal();return}catch(e){}}dialog.setAttribute('open','')});
const describe=(problem)=>{const p=problem.payload||{};if(p.error==='E_SEMANTIC_NOT_READY'){const lines=[p.reason||'Semantic search is not ready.'];
 for(const [name,step] of Object.entries(p.steps||{}))lines.push(name+': '+(step.status||'action-needed')+' — '+(step.reason||''));
 if(p.next)lines.push('Next: '+p.next);return lines.join('\\n')}return String(problem.message||problem)};
const run=async(path,body,extraOf)=>{const shown=await api(path,{...body,apply:false});
 const change=JSON.stringify({change:body,result:shown.result===undefined?shown:shown.result},null,2);
 const ok=await ask(change,extraOf?extraOf(shown):'');
 if(!ok){show('Cancelled. Nothing was written.');return null}
 const done=await api(path,{...body,apply:true});await load();return done};
const button=(label,handler)=>{const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{try{const v=await handler();if(v!==null)show(v===undefined?'Done.':v)}catch(e){show(describe(e))}};return b};
const channelSelect=(selected)=>{const sel=document.createElement('select');for(const ch of ['mcp','cli']){const o=document.createElement('option');o.value=ch;o.textContent=CHANNEL_LABELS[ch];o.title=CHANNEL_TITLES[ch];o.selected=ch===selected;sel.append(o)}return sel};
const semanticExtra=(shown)=>{const s=shown.semantic;if(!s)return '';const lines=[];
 for(const [name,step] of Object.entries(s.steps||{}))lines.push(name+': '+(step.status||'')+' — '+(step.reason||''));
 for(const warning of s.warnings||[])lines.push('Warning: '+warning);return lines.join('\\n')};
const control=(row,readOnly)=>{let el;
 if(row.control==='select'){el=document.createElement('select');for(const option of row.options||[]){const o=document.createElement('option');o.value=option;o.textContent=option;o.selected=option===(row.value===undefined?row.default:row.value);el.append(o)}}
 else if(row.control==='checkbox'){el=document.createElement('input');el.type='checkbox';el.checked=row.value===true}
 else if(row.control==='number'){el=document.createElement('input');el.type='number';el.value=row.value===undefined?'':String(row.value);el.step=String(row.step||1);
  if(row.min!==undefined)el.min=String(row.min);if(row.max!==undefined)el.max=String(row.max)}
 else {el=document.createElement('input');el.type='text';el.value=row.value===undefined?'':String(row.value)}
 el.disabled=readOnly;return el};
const read=(row,el)=>row.control==='checkbox'?el.checked:row.control==='number'?(el.value.trim()===''?NaN:Number(el.value)):el.value;
const valid=(row,el)=>{if(row.control!=='number')return true;const v=read(row,el);
 if(!Number.isFinite(v))return false;if(row.step===1&&!Number.isInteger(v))return false;
 if(row.min!==undefined&&v<row.min)return false;if(row.max!==undefined&&v>row.max)return false;return true};
async function load(){
 const s=await api('/api/summary');$('note').textContent=s.readOnly?'Read-only: changes are disabled.':'Every change asks for confirmation and shows what it will change.';
 $('summary').replaceChildren();for(const [k,v] of Object.entries(s.summary)){if(v&&typeof v==='object'||k==='note')continue;const r=document.createElement('tr');cell(r,k,'th');cell(r,String(v));$('summary').append(r)}
 const a=await api('/api/agents');$('agents').replaceChildren();
 for(const g of a.agents){const r=document.createElement('tr');cell(r,g.agent,'th');
  cell(r,g.installed?('channel '+CHANNEL_LABELS[g.channel]+(g.healthy?' (healthy)':' (check doctor)')):(g.detected?'detected, not installed':'not found'));
  const c=document.createElement('td');
  if(!s.readOnly&&g.installed){const sel=channelSelect(g.channel);c.append(sel,button('Apply',()=>run('/api/agent',{agent:g.agent,channel:sel.value})))}
  else if(!s.readOnly&&g.detected){const sel=channelSelect('mcp');c.append(sel,button('Install',()=>run('/api/agent-add',{agent:g.agent,channel:sel.value})))}
  r.append(c);$('agents').append(r)}
 const t=await api('/api/settings');$('settings').replaceChildren();$('notes').textContent=(t.notes||[]).join('\\n');
 for(const row of t.settings){const r=document.createElement('tr');cell(r,row.key,'th');const c=document.createElement('td');
  const el=control(row,s.readOnly);c.append(el);
  if(row.help){const help=document.createElement('div');help.className='help';help.textContent=row.help;c.append(help)}
  if(!s.readOnly){const apply=button('Apply',()=>run('/api/setting',{key:row.key,value:read(row,el)},semanticExtra));
   if(row.control==='number'){const sync=()=>{apply.disabled=!valid(row,el)};el.addEventListener('input',sync);sync()}
   c.append(apply);
   if(row.default!==undefined&&row.default!==row.value)c.append(button('Reset',()=>run('/api/setting',{key:row.key,value:row.default},semanticExtra)))}
  r.append(c);$('settings').append(r)}
}
load().catch((e)=>show(String(e.message)));
</script></body></html>`;

/** The default for one editable key: the profile default, or SEMANTIC_DEFAULTS for `semantic.*`. */
function defaultFor(profile, key) {
  if (key.startsWith('semantic.')) return SEMANTIC_DEFAULTS[key.slice('semantic.'.length)];
  return key.split('.').reduce((value, part) => value?.[part], defaultConfig(profile));
}

/**
 * BA-87: derive one typed control row from the schema node, never a hand-written copy of the schema. Every
 * allowlisted key gets a row; an optional key that the config does not carry has no value and no default.
 * @param {string} key @param {any} value @param {any} schema @param {'lite'|'full'|'custom'} profile
 */
function settingRow(key, value, schema, profile) {
  /** @type {any} */
  const row = { key };
  if (value !== undefined) row.value = value;
  if (Array.isArray(schema.enum)) {
    row.control = 'select';
    row.options = [...schema.enum];
  } else if (schema.type === 'boolean') row.control = 'checkbox';
  else if (schema.type === 'integer' || schema.type === 'number') {
    row.control = 'number';
    row.step = schema.type === 'integer' ? 1 : 0.01;
    if (schema.minimum !== undefined) row.min = schema.minimum;
    if (schema.maximum !== undefined) row.max = schema.maximum;
  } else row.control = 'text';
  const fallback = defaultFor(profile, key);
  if (fallback !== undefined) row.default = fallback;
  row.help = HELP[key];
  return row;
}

/**
 * Flatten the editable leaves of the configuration (scalars only, schema keys only, allowlisted keys only).
 * @param {any} cfg @param {{semantic?:boolean}} [options]
 */
export function editableSettings(cfg, options = {}) {
  const semantic = options.semantic !== false;
  const rows = [];
  const walk = (value, schema, prefix) => {
    if (!schema?.properties) return;
    for (const [key, child] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const item = value?.[key];
      if (child?.type === 'object') walk(item, child, path);
      else if (EDITABLE_KEYS.has(path) && ['string', 'number', 'integer', 'boolean'].includes(child?.type)) {
        if (!semantic && path.startsWith('semantic.')) continue;
        rows.push(settingRow(path, item, child, cfg.profile));
      }
    }
  };
  walk(cfg, CONFIG_SCHEMA, '');
  return rows;
}

/**
 * BA-87: the semantic module is usable only in a non-lite profile whose config enables it and whose release
 * ships `modules/semantic`. The module list follows the same rule as `enabledModuleEntries`: `*` or `semantic`.
 */
async function semanticInstalled(paths, cfg) {
  if (cfg.profile === 'lite' || !paths.currentDir) return false;
  const modules = Array.isArray(cfg.modules) ? cfg.modules : [];
  if (!modules.includes('*') && !modules.includes('semantic')) return false;
  return exists(join(paths.currentDir, 'modules', 'semantic'));
}

/** The allowed values or range of one row, as a short phrase for the error message. */
function rangePhrase(row) {
  if (row.min !== undefined && row.max !== undefined) return `between ${row.min} and ${row.max}`;
  if (row.min !== undefined) return `at least ${row.min}`;
  if (row.max !== undefined) return `at most ${row.max}`;
  return 'a number';
}

/**
 * BA-87: the server stays authoritative for the typed value. A wrong JSON type, an out-of-range number or an
 * unknown enum member is refused before anything is written. The error carries `panelMessage` so only these
 * validation failures return a human sentence; errors from the command handlers keep the plain body.
 * @param {any} row @param {unknown} value
 */
function validateSetting(row, value) {
  /** @param {string} message */
  const refuse = (message) => error('E_CONFIG_INVALID', message, { panelMessage: message });
  if (row.control === 'select') {
    if (typeof value !== 'string' || !row.options.includes(value))
      throw refuse(`${row.key} must be one of: ${row.options.join(', ')}.`);
    return;
  }
  if (row.control === 'checkbox') {
    if (typeof value !== 'boolean') throw refuse(`${row.key} must be true or false.`);
    return;
  }
  if (row.control === 'number') {
    const integer = row.step === 1;
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)))
      throw refuse(`${row.key} must be ${integer ? 'an integer' : 'a number'} ${rangePhrase(row)}.`);
    if ((row.min !== undefined && value < row.min) || (row.max !== undefined && value > row.max))
      throw refuse(`${row.key} must be ${rangePhrase(row)}.`);
    return;
  }
  if (typeof value !== 'string') throw refuse(`${row.key} must be a string.`);
}

/**
 * BA-87: run the same in-process semantic setup dry-run the CLI runs and keep its report. The module handler is
 * called exactly once; a module that throws means the check itself failed, not that a step reported a problem.
 * @param {{paths:any, env:any}} options
 */
async function semanticReadiness({ paths, env }) {
  /** @type {any} */
  let report;
  try {
    report = await moduleCommandReport('semanticSetup', ['--dry-run', '--json'], { paths, env });
  } catch {
    throw error('E_SEMANTIC_NOT_READY', 'Semantic readiness could not be checked.', {
      steps: {},
      reason: 'The semantic setup check could not run.',
    });
  }
  const steps = report?.steps && typeof report.steps === 'object' ? report.steps : {};
  /** @type {Record<string, {status: string, reason: string}>} */
  const blocked = {};
  for (const [name, step] of Object.entries(steps)) {
    const item = /** @type {any} */ (step);
    if (item?.status === 'action-needed') blocked[name] = { status: item.status, reason: String(item.reason ?? '') };
  }
  if (Object.keys(blocked).length)
    throw error('E_SEMANTIC_NOT_READY', 'Semantic search is not ready.', {
      steps: blocked,
      next: typeof report?.next === 'string' ? report.next : '',
    });
  const warnings = Object.values(steps)
    .map((step) => /** @type {any} */ (step))
    .filter((step) => step?.status === 'ok' && /RAM|disk/i.test(String(step.reason ?? '')))
    .map((step) => String(step.reason));
  warnings.push(SEMANTIC_LATENCY);
  return { steps, warnings };
}

function sameToken(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Run a CLI command handler in process and return what it printed. The panel has no second code path for changes. */
async function runHandler(handler, args, { paths, env, plan }) {
  let result;
  const context = {
    args: [...args],
    paths,
    env,
    plan,
    output: (data) => {
      result = data;
    },
    value: (name) => {
      const index = args.indexOf(name);
      return index < 0 ? undefined : args[index + 1];
    },
    markRedacted: () => {},
  };
  await handler(context);
  return result;
}

/**
 * Start the panel. It listens on 127.0.0.1 only, on a random port, and requires a per-run token.
 * It closes itself after `idleMs` without a request; `idle` resolves when that happens.
 * @param {{paths:any, env:any, host?:string, idleMs?:number}} options
 */
export async function startUiServer({ paths, env, host = '127.0.0.1', idleMs = DEFAULT_IDLE_MS }) {
  const token = randomBytes(24).toString('hex');
  let queue = Promise.resolve();
  /** @type {() => void} */
  let markIdle = () => {};
  const idle = new Promise((resolve) => {
    markIdle = () => resolve(undefined);
  });
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  let closePromise;
  /** @param {() => Promise<any>} task @returns {Promise<any>} */
  const serialized = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const server = createServer(async (request, response) => {
    scheduleIdle();
    response.once('finish', scheduleIdle);
    response.once('close', scheduleIdle);
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    let sent = false;
    const send = (status, body, type = 'application/json', { close = false } = {}) => {
      if (sent) return;
      sent = true;
      if (close) request.on('error', () => {});
      response.writeHead(status, {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        ...(close ? { connection: 'close' } : {}),
      });
      if (close) response.once('finish', () => request.destroy());
      response.end(type === 'application/json' ? JSON.stringify(redactOutput(body, env.HOME)) : body);
    };
    try {
      const expectedHost = `127.0.0.1:${port}`;
      if (request.headers.host !== expectedHost && request.headers.host !== `localhost:${port}`)
        return send(403, { error: 'Host not allowed.' });
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== `http://${expectedHost}` && origin !== `http://localhost:${port}`)
        return send(403, { error: 'Origin not allowed.' });
      const url = new URL(request.url ?? '/', `http://${expectedHost}`);
      if (request.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html');
      const given = request.headers['x-brainatlas-token'];
      if (!sameToken(given, token)) return send(401, { error: 'Missing or wrong token.' });
      const cfg = await loadConfig({ paths, env });
      const readOnly = cfg.readOnly === true;
      if (request.method === 'GET' && url.pathname === '/api/summary') {
        const inputs = await summaryInputs({ paths, env });
        return send(200, { readOnly, summary: await buildHealthSummary({ ...inputs, paths }) });
      }
      if (request.method === 'GET' && url.pathname === '/api/agents')
        return send(200, await runHandler(agentCommand, ['list'], { paths, env, plan: false }));
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        const semantic = await semanticInstalled(paths, cfg);
        /** @type {any} */
        const payload = { settings: editableSettings(cfg, { semantic }) };
        if (!semantic) payload.notes = [SEMANTIC_NOTE];
        return send(200, payload);
      }
      const writes = ['/api/agent', '/api/agent-add', '/api/setting'];
      if (request.method === 'POST' && writes.includes(url.pathname)) {
        if (readOnly) return send(403, { error: 'The installation is read-only.' });
        if (!/^application\/json\b/.test(request.headers['content-type'] ?? ''))
          return send(415, { error: 'JSON body required.' });
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY)
          return send(413, { error: 'Body too large.' }, 'application/json', { close: true });
        const raw = await new Promise((resolveBody, rejectBody) => {
          /** @type {Buffer[]} */
          const chunks = [];
          let size = 0;
          let tooLarge = false;
          request.on('data', (chunk) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > MAX_BODY) {
              tooLarge = true;
              chunks.length = 0;
              send(413, { error: 'Body too large.' }, 'application/json', { close: true });
              resolveBody(null);
              return;
            }
            chunks.push(chunk);
          });
          request.on('end', () => {
            if (!tooLarge) resolveBody(Buffer.concat(chunks).toString('utf8'));
          });
          request.on('error', rejectBody);
        });
        if (raw === null) return;
        const body = JSON.parse(raw || '{}');
        const plan = body.apply !== true;
        const outcome = await serialized(async () => {
          if (url.pathname === '/api/agent' || url.pathname === '/api/agent-add') {
            if (typeof body.agent !== 'string' || !CHANNEL_AGENTS.includes(body.agent))
              throw error('E_ARGUMENT', 'agent must be a known agent adapter.');
            if (!CHANNELS.includes(body.channel)) throw error('E_ARGUMENT', 'channel must be mcp or cli.');
            const action = url.pathname === '/api/agent-add' ? 'add' : 'set';
            const result = await runHandler(agentCommand, [action, body.agent, '--channel', body.channel], {
              paths,
              env,
              plan,
            });
            return { result };
          }
          if (typeof body.key !== 'string' || !EDITABLE_KEYS.has(body.key))
            throw error('E_CONFIG_KEY', 'This setting cannot be changed from the panel.');
          const semantic = await semanticInstalled(paths, cfg);
          if (!semantic && body.key.startsWith('semantic.'))
            throw error('E_CONFIG_KEY', 'Semantic settings need the Full profile and release.');
          const row = editableSettings(cfg, { semantic }).find((item) => item.key === body.key);
          if (!row) throw error('E_CONFIG_KEY', 'Unknown setting.');
          validateSetting(row, body.value);
          const check =
            body.key === 'semantic.enabled' && body.value === true ? await semanticReadiness({ paths, env }) : null;
          const result = await runHandler(configCommand, ['set', body.key, JSON.stringify(body.value)], {
            paths,
            env,
            plan,
          });
          return check ? { result, semantic: check } : { result };
        });
        return send(200, { applied: !plan, ...outcome });
      }
      return send(404, { error: 'Not found.' });
    } catch (cause) {
      if (cause?.code === 'E_SEMANTIC_NOT_READY')
        return send(409, {
          error: 'E_SEMANTIC_NOT_READY',
          steps: cause.steps ?? {},
          ...(cause.next === undefined ? {} : { next: cause.next }),
          ...(cause.reason ? { reason: cause.reason } : {}),
        });
      const bad =
        cause?.code === 'E_ARGUMENT' ||
        cause?.code === 'E_CONFIG_KEY' ||
        cause?.code === 'E_CONFIG_INVALID' ||
        cause instanceof SyntaxError;
      return send(bad ? 400 : 500, {
        error: cause instanceof SyntaxError ? 'Invalid JSON.' : (cause?.code ?? 'E_UI'),
        ...(cause?.panelMessage ? { message: cause.message } : {}),
      });
    }
  });
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve) => {
      clearTimeout(idleTimer);
      if (!server.listening) return resolve(undefined);
      server.close(() => resolve(undefined));
      server.closeAllConnections();
    });
    return closePromise;
  };
  function scheduleIdle() {
    if (closePromise || !(idleMs > 0)) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      close().then(markIdle);
    }, idleMs);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(undefined));
  });
  scheduleIdle();
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/#t=${token}`,
    idle,
    close,
  };
}

function openBrowser(url, env) {
  const platform = env.BRAINATLAS_PLATFORM || process.platform;
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, env });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* The URL is printed anyway. */
  }
}

/**
 * `brainatlas ui [--no-open] [--json]`: serve the panel until interrupted.
 * @param {{args:string[], flag:(name:string)=>boolean, json:boolean, output:(data:any)=>void, paths:any, env:any, dependencies?:any}} context
 */
export async function uiCommand({ args, flag, json, output, paths, env, dependencies = {} }) {
  const known = new Set(['--no-open', '--json']);
  if (args.some((argument) => !known.has(argument))) throw error('E_ARGUMENT', 'ui arguments are invalid.');
  const panel = await startUiServer({ paths, env, idleMs: dependencies.uiIdleMs });
  output(json ? { url: panel.url, port: panel.port } : `BrainAtlas panel: ${panel.url}\nPress Ctrl+C to stop.`);
  if (!flag('--no-open') && env.BRAINATLAS_OFFLINE !== '1') openBrowser(panel.url, env);
  if (dependencies.uiStop) {
    await dependencies.uiStop(panel);
    await panel.close();
    return;
  }
  let idleClosed = false;
  /** @type {(value?: any) => void} */
  let resolveStop = () => {};
  const stop = () => resolveStop(undefined);
  await new Promise((resolve) => {
    resolveStop = resolve;
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    panel.idle.then(() => {
      idleClosed = true;
      resolve(undefined);
    });
  });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  await panel.close();
  if (idleClosed) output('BrainAtlas panel closed after 30 minutes idle.');
}
