// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { CONFIG_SCHEMA, loadConfig } from '@brainatlas/core';
import { agentCommand } from './commands/agent.mjs';
import { configCommand } from './commands/config.mjs';
import { summaryInputs } from './commands/lifecycle.mjs';
import { redactOutput, error } from './commands/shared.mjs';
import { buildHealthSummary } from './health.mjs';

const MAX_BODY = 16 * 1024;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BrainAtlas</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0 auto;max-width:56rem;padding:1rem 1rem 3rem}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #8884;padding:.35rem .5rem;text-align:left;font-size:.9rem}
button,select,input{font:inherit}pre{background:#8882;padding:.6rem;overflow:auto;white-space:pre-wrap}h2{margin-top:2rem}
</style></head><body><h1>BrainAtlas</h1><p id="note"></p>
<h2>Status</h2><table id="summary"></table>
<h2>Agents</h2><table id="agents"></table>
<h2>Settings</h2><table id="settings"></table>
<h2>Result</h2><pre id="out">Nothing yet. Changes show a plan first; apply is a separate step.</pre>
<script>
const params=new URLSearchParams(location.hash.slice(1));const T=params.get('t')||'';history.replaceState(null,'',location.pathname);
const $=(id)=>document.getElementById(id);
const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-brainatlas-token':T,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j};
const cell=(row,text,tag='td')=>{const c=document.createElement(tag);c.textContent=text;row.append(c);return c};
const show=(v)=>{$('out').textContent=typeof v==='string'?v:JSON.stringify(v,null,2)};
const button=(label,handler)=>{const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{try{show(await handler())}catch(e){show(String(e.message))}};return b};
async function load(){
 const s=await api('/api/summary');$('note').textContent=s.readOnly?'Read-only: changes are disabled.':'Changes show a plan first; apply is a separate step.';
 $('summary').replaceChildren();for(const [k,v] of Object.entries(s.summary)){if(v&&typeof v==='object'||k==='note')continue;const r=document.createElement('tr');cell(r,k,'th');cell(r,String(v));$('summary').append(r)}
 const a=await api('/api/agents');$('agents').replaceChildren();
 for(const g of a.agents){const r=document.createElement('tr');cell(r,g.agent,'th');cell(r,g.installed?('channel '+g.channel+(g.healthy?' (healthy)':' (check doctor)')):(g.detected?'detected, not installed':'not found'));
  const c=document.createElement('td');if(g.installed&&!s.readOnly){const sel=document.createElement('select');for(const ch of ['mcp','cli']){const o=document.createElement('option');o.value=o.textContent=ch;o.selected=ch===g.channel;sel.append(o)}
   c.append(sel,button('Plan',()=>api('/api/agent',{agent:g.agent,channel:sel.value,apply:false})),button('Apply',async()=>{const v=await api('/api/agent',{agent:g.agent,channel:sel.value,apply:true});load();return v}))}
  r.append(c);$('agents').append(r)}
 const t=await api('/api/settings');$('settings').replaceChildren();
 for(const row of t.settings){const r=document.createElement('tr');cell(r,row.key,'th');const c=document.createElement('td');const inp=document.createElement('input');inp.value=JSON.stringify(row.value);inp.size=18;inp.disabled=s.readOnly;c.append(inp);
  if(!s.readOnly)c.append(button('Plan',()=>api('/api/setting',{key:row.key,value:inp.value,apply:false})),button('Apply',async()=>{const v=await api('/api/setting',{key:row.key,value:inp.value,apply:true});load();return v}));
  r.append(c);$('settings').append(r)}
}
load().catch((e)=>show(String(e.message)));
</script></body></html>`;

/** Flatten the editable leaves of the configuration (scalars only, schema keys only, allowlisted keys only). */
export function editableSettings(cfg) {
  const rows = [];
  const walk = (value, schema, prefix) => {
    if (!schema?.properties) return;
    for (const [key, child] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const item = value?.[key];
      if (child?.type === 'object') walk(item, child, path);
      else if (
        EDITABLE_KEYS.has(path) &&
        ['string', 'number', 'integer', 'boolean'].includes(child?.type) &&
        item !== undefined
      )
        rows.push({ key: path, value: item });
    }
  };
  walk(cfg, CONFIG_SCHEMA, '');
  return rows;
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
      if (request.method === 'GET' && url.pathname === '/api/settings')
        return send(200, { settings: editableSettings(cfg) });
      if (request.method === 'POST' && (url.pathname === '/api/agent' || url.pathname === '/api/setting')) {
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
        const result = await serialized(async () => {
          if (url.pathname === '/api/agent') {
            if (typeof body.agent !== 'string' || !['mcp', 'cli'].includes(body.channel))
              throw error('E_ARGUMENT', 'agent and channel (mcp or cli) are required.');
            return runHandler(agentCommand, ['set', body.agent, '--channel', body.channel], { paths, env, plan });
          }
          if (typeof body.key !== 'string' || !EDITABLE_KEYS.has(body.key))
            throw error('E_CONFIG_KEY', 'This setting cannot be changed from the panel.');
          if (!editableSettings(cfg).some((row) => row.key === body.key))
            throw error('E_CONFIG_KEY', 'Unknown setting.');
          return runHandler(configCommand, ['set', body.key, String(body.value)], { paths, env, plan });
        });
        return send(200, { applied: !plan, result });
      }
      return send(404, { error: 'Not found.' });
    } catch (cause) {
      const bad = cause?.code === 'E_ARGUMENT' || cause?.code === 'E_CONFIG_KEY' || cause instanceof SyntaxError;
      return send(bad ? 400 : 500, { error: cause instanceof SyntaxError ? 'Invalid JSON.' : (cause?.code ?? 'E_UI') });
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
