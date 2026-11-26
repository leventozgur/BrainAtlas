// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { writeFile, unlink, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { atomicWriteFile, detectEvidence, resolvePaths, BrainAtlasError, adapterKit } from '@brainatlas/core';

const {
  quote,
  isCli,
  cliPayload,
  readOptional: read,
  readOptionalSync,
  readOriginal,
  saveOriginal: writeOriginal,
  clearOriginal,
  originalPath,
  backupName,
  managedBlock,
  putBlock,
  restorable,
  hasParentSegment,
} = adapterKit;

export const id = 'gemini-cli';
export const displayName = 'Gemini CLI';
const BEGIN = '<!-- brainatlas:begin -->';
const END = '<!-- brainatlas:end -->';
const fail = (code, message) => {
  throw new BrainAtlasError(code, message);
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
function home(ctx) {
  if (!ctx?.env?.HOME) fail('E_NO_HOME', 'HOME must be provided.');
  return ctx.env.HOME;
}
function paths(ctx) {
  return (
    ctx.paths ||
    resolvePaths({ env: ctx.env, platform: ctx.platform || ctx.env?.BRAINATLAS_PLATFORM || process.platform })
  );
}
function targets(ctx) {
  const root = ctx.scope === 'vault' ? ctx.vaultDir : home(ctx);
  if (ctx.scope === 'vault' && (!isAbsolute(root || '') || hasParentSegment(root)))
    fail('E_PATH_ESCAPE', 'Vault directory must be absolute and cannot contain parent segments.');
  return { mcp: join(root, '.gemini', 'settings.json'), instructions: join(root, 'GEMINI.md') };
}
function parseJson(text) {
  return adapterKit.parseJson(text, { empty: 'blank', object: true });
}
function sourceTree(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const stringEnd = (at) => {
    let p = at + 1;
    while (p < text.length) {
      if (text[p] === '\\') {
        p += 2;
        continue;
      }
      if (text[p++] === '"') return p;
    }
    throw Error();
  };
  function value() {
    ws();
    const start = i,
      ch = text[i];
    if (ch === '{') {
      i++;
      ws();
      const members = [];
      while (text[i] !== '}') {
        ws();
        const keyStart = i;
        if (text[i] !== '"') throw Error();
        const end = stringEnd(i),
          key = JSON.parse(text.slice(i, end));
        i = end;
        ws();
        if (text[i++] !== ':') throw Error();
        const node = value();
        members.push({ key, keyStart, start: node.start, end: node.end, node });
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] !== '}') throw Error();
      }
      i++;
      return { type: 'object', start, end: i, members };
    }
    if (ch === '[') {
      i++;
      ws();
      const items = [];
      while (text[i] !== ']') {
        items.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] !== ']') throw Error();
      }
      i++;
      return { type: 'array', start, end: i, items };
    }
    if (ch === '"') {
      i = stringEnd(i);
      return { type: 'scalar', start, end: i };
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
    if (i === start) throw Error();
    return { type: 'scalar', start, end: i };
  }
  try {
    const root = value();
    ws();
    if (i !== text.length || root.type !== 'object') throw Error();
    return root;
  } catch {
    fail('E_CONFIG_PARSE', 'Configuration JSON is invalid.');
  }
}
function member(node, key) {
  return node?.type === 'object' ? node.members.find((x) => x.key === key) : undefined;
}
function removeMember(text, node, key) {
  const index = node.members.findIndex((x) => x.key === key);
  if (index < 0) return text;
  const item = node.members[index],
    next = node.members[index + 1],
    previous = node.members[index - 1];
  if (next) return text.slice(0, item.keyStart) + text.slice(next.keyStart);
  if (previous) {
    const comma = text.lastIndexOf(',', item.keyStart);
    return text.slice(0, comma) + text.slice(item.end);
  }
  return text.slice(0, item.keyStart) + text.slice(item.end);
}
function removeItem(text, node, index) {
  const item = node.items[index],
    next = node.items[index + 1],
    previous = node.items[index - 1];
  if (!item) return text;
  if (next) return text.slice(0, item.start) + text.slice(next.start);
  if (previous) {
    const comma = text.lastIndexOf(',', item.start);
    return text.slice(0, comma) + text.slice(item.end);
  }
  return text.slice(0, item.start) + text.slice(item.end);
}
function indentAt(text, at) {
  const line = text.lastIndexOf('\n', at - 1) + 1;
  return text.slice(line, at).match(/^[\t ]*/)?.[0] || '';
}
function setMember(text, node, key, value) {
  const old = member(node, key),
    encoded = JSON.stringify(value);
  if (old) return text.slice(0, old.start) + encoded + text.slice(old.end);
  const close = node.end - 1,
    nonempty = node.members.length > 0,
    nl = text.includes('\r\n') ? '\r\n' : '\n',
    parent = indentAt(text, node.start),
    child = nonempty ? indentAt(text, node.members[0].keyStart) : parent + '  ';
  return (
    text.slice(0, close) +
    `${nonempty ? ',' : ''}${nl}${child}${JSON.stringify(key)}: ${encoded}${nl}${parent}` +
    text.slice(close)
  );
}
function appendArray(text, node, value) {
  const close = node.end - 1,
    nl = text.includes('\r\n') ? '\r\n' : '\n',
    parent = indentAt(text, node.start),
    child = node.items.length ? indentAt(text, node.items[0].start) : parent + '  ';
  return (
    text.slice(0, close) +
    `${node.items.length ? ',' : ''}${nl}${child}${JSON.stringify(value)}${nl}${parent}` +
    text.slice(close)
  );
}
const CHANNEL_SWITCH = 'Run brainatlas uninstall before changing the channel.';
function forgivingJson(text) {
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function assertNoMcp(text, ctx) {
  if (text === null || text.trim() === '') return;
  const value = forgivingJson(text);
  if (!value) return;
  if (value.mcpServers?.brainatlas !== undefined) fail('E_CHANNEL_SWITCH', CHANNEL_SWITCH);
  const shim = quote(ctx.shimPath);
  const managed = ['BeforeAgent', 'SessionStart'].some((event) =>
    (Array.isArray(value.hooks?.[event]) ? value.hooks[event] : []).some(
      (group) =>
        Array.isArray(group?.hooks) &&
        group.hooks.some((hook) => {
          if (typeof hook?.command !== 'string') return false;
          const tail = hook.command.split(shim)[1] || '';
          return hook.command.includes(shim) && /^\s+(?:hook )?gemini (?:prompt|session-start)\b/.test(tail);
        })
    )
  );
  if (managed) fail('E_CHANNEL_SWITCH', CHANNEL_SWITCH);
}
function hookCommand(ctx, verb, legacy = false) {
  return `${quote(ctx.nodePath)} ${quote(ctx.shimPath)} ${legacy ? '' : 'hook '}gemini ${verb}`;
}
function visitHooks(text, ctx, mode) {
  for (const [event, name, verb] of [
    ['BeforeAgent', 'brainatlas-context', 'prompt'],
    ['SessionStart', 'brainatlas-session', 'session-start'],
  ]) {
    let list = member(member(sourceTree(text), 'hooks')?.node, event);
    if (list?.node.type !== 'array') continue;
    let current =
      mode === 'upgrade' &&
      (parseJson(text).hooks?.[event] ?? []).some(
        (g) =>
          g?.matcher === '*' &&
          Array.isArray(g.hooks) &&
          g.hooks.some((h) => h?.name === name && h.type === 'command' && h.command === hookCommand(ctx, verb))
      );
    for (let i = list.node.items.length - 1; i >= 0; i--) {
      list = member(member(sourceTree(text), 'hooks')?.node, event);
      const group = list.node.items[i],
        matcher = member(group, 'matcher'),
        children = member(group, 'hooks');
      if (!matcher || text.slice(matcher.start, matcher.end) !== '"*"' || children?.node.type !== 'array') continue;
      for (let j = children.node.items.length - 1; j >= 0; j--) {
        list = member(member(sourceTree(text), 'hooks')?.node, event);
        const items = member(list.node.items[i], 'hooks').node,
          item = items.items[j];
        const n = member(item, 'name'),
          ty = member(item, 'type'),
          command = member(item, 'command');
        if (
          !n ||
          !ty ||
          !command ||
          text.slice(n.start, n.end) !== JSON.stringify(name) ||
          text.slice(ty.start, ty.end) !== '"command"'
        )
          continue;
        const value = text.slice(command.start, command.end);
        if (mode === 'upgrade' && !current && value === JSON.stringify(hookCommand(ctx, verb, true))) {
          text = text.slice(0, command.start) + JSON.stringify(hookCommand(ctx, verb)) + text.slice(command.end);
          current = true;
        } else if (
          (mode === 'upgrade' && value === JSON.stringify(hookCommand(ctx, verb, true))) ||
          (mode === 'remove' &&
            [hookCommand(ctx, verb), hookCommand(ctx, verb, true)].some((c) => value === JSON.stringify(c)))
        ) {
          if (items.items.length === 1) {
            text = removeItem(text, list.node, i);
            break;
          }
          text = removeItem(text, items, j);
        }
      }
    }
  }
  return text;
}
function geminiSettings(before, ctx) {
  const conf = before === null || before.trim() === '' ? {} : parseJson(before);
  let text = before === null || before.trim() === '' ? '{}' : before;
  if (
    conf.mcpServers !== undefined &&
    (!conf.mcpServers || Array.isArray(conf.mcpServers) || typeof conf.mcpServers !== 'object')
  )
    fail('E_CONFIG_PARSE', 'MCP server configuration must be an object.');
  if (conf.hooks !== undefined && (!conf.hooks || Array.isArray(conf.hooks) || typeof conf.hooks !== 'object'))
    fail('E_CONFIG_PARSE', 'Hook configuration must be an object.');
  const entry = { command: ctx.nodePath, args: [ctx.shimPath, 'mcp'] };
  let root = sourceTree(text),
    mcp = member(root, 'mcpServers');
  if (!mcp) {
    text = setMember(text, root, 'mcpServers', {});
    root = sourceTree(text);
    mcp = member(root, 'mcpServers');
  }
  if (mcp.node.type !== 'object') fail('E_CONFIG_PARSE', 'MCP server configuration must be an object.');
  if (JSON.stringify(conf.mcpServers?.brainatlas) !== JSON.stringify(entry)) {
    text = setMember(text, mcp.node, 'brainatlas', entry);
  }
  const hook = {
    name: 'brainatlas-context',
    type: 'command',
    command: hookCommand(ctx, 'prompt'),
    timeout: 5000,
    description: 'Add relevant BrainAtlas context before the agent responds.',
  };
  const sessionHook = {
    name: 'brainatlas-session',
    type: 'command',
    command: hookCommand(ctx, 'session-start'),
    timeout: 5000,
    description: 'Restore BrainAtlas session continuity at session start.',
  };
  text = visitHooks(text, ctx, 'upgrade');
  root = sourceTree(text);
  conf.hooks = parseJson(text).hooks;
  let hooks = member(root, 'hooks');
  if (!hooks) {
    text = setMember(text, root, 'hooks', {});
    root = sourceTree(text);
    hooks = member(root, 'hooks');
  }
  if (hooks.node.type !== 'object') fail('E_CONFIG_PARSE', 'Hook configuration must be an object.');
  let event = member(hooks.node, 'BeforeAgent');
  if (!event) {
    text = setMember(text, hooks.node, 'BeforeAgent', []);
    root = sourceTree(text);
    hooks = member(root, 'hooks');
    event = member(hooks.node, 'BeforeAgent');
  }
  if (event.node.type !== 'array' || !Array.isArray(conf.hooks?.BeforeAgent ?? []))
    fail('E_CONFIG_PARSE', 'BeforeAgent hooks must be an array.');
  const exists = (conf.hooks?.BeforeAgent ?? []).some(
    (g) =>
      g?.matcher === '*' &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => h?.name === 'brainatlas-context' && h.type === 'command' && h.command === hook.command)
  );
  if (!exists) text = appendArray(text, event.node, { matcher: '*', hooks: [hook] });
  root = sourceTree(text);
  hooks = member(root, 'hooks');
  let session = member(hooks.node, 'SessionStart');
  if (!session) {
    text = setMember(text, hooks.node, 'SessionStart', []);
    root = sourceTree(text);
    hooks = member(root, 'hooks');
    session = member(hooks.node, 'SessionStart');
  }
  if (session.node.type !== 'array' || !Array.isArray(conf.hooks?.SessionStart ?? []))
    fail('E_CONFIG_PARSE', 'SessionStart hooks must be an array.');
  const sessionExists = (conf.hooks?.SessionStart ?? []).some(
    (g) =>
      g?.matcher === '*' &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => h?.name === 'brainatlas-session' && h.type === 'command' && h.command === sessionHook.command)
  );
  if (!sessionExists) text = appendArray(text, session.node, { matcher: '*', hooks: [sessionHook] });
  return text;
}
function blockText(ctx) {
  const body = isCli(ctx)
    ? cliPayload(ctx)
    : 'Use BrainAtlas in pull mode: query relevant project knowledge with the BrainAtlas wiki_query MCP tool when it can inform the task. Treat retrieved pages as evidence, verify them against the current project, and cite page paths when reporting findings.';
  return `${BEGIN}\n<!-- brainatlas:sha256:${digest(body)} -->\n${body}\n${END}`;
}
function getBlock(text) {
  return managedBlock(text);
}
function getBlockCli(text) {
  return managedBlock(text, { crlf: true });
}
function appendBlock(ctx, before) {
  return putBlock(before, blockText(ctx));
}
function appendBlockCli(ctx, before) {
  const old = getBlockCli(before);
  if (old)
    return old.body === cliPayload(ctx) ? before : before.slice(0, old.start) + blockText(ctx) + before.slice(old.end);
  return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${blockText(ctx)}\n`;
}
function changes(ctx, values) {
  const f = targets(ctx),
    result = [];
  const before = values[f.mcp];
  if (!ctx.nodePath || !ctx.shimPath) fail('E_ARGUMENT', 'nodePath and shimPath are required.');
  if (isCli(ctx)) {
    assertNoMcp(before, ctx);
    const cliMd = values[f.instructions];
    const cliAfter = appendBlockCli(ctx, cliMd ?? '');
    if (cliAfter !== (cliMd ?? ''))
      result.push({
        file: f.instructions,
        kind: cliMd === null ? 'create' : 'modify',
        before: cliMd,
        after: cliAfter,
        ownership: cliMd === null ? 'whole-file' : 'marked-block',
      });
    return result;
  }
  const updated = geminiSettings(before, ctx);
  if (updated !== before)
    result.push({
      file: f.mcp,
      kind: before === null ? 'create' : 'modify',
      before,
      after: updated,
      ownership: 'json-key',
    });
  const md = values[f.instructions];
  const after = appendBlock(ctx, md ?? '');
  if (after !== (md ?? ''))
    result.push({
      file: f.instructions,
      kind: md === null ? 'create' : 'modify',
      before: md,
      after,
      ownership: md === null ? 'whole-file' : 'marked-block',
    });
  return result;
}
/** @param {Record<string,any> | null | undefined} env @returns {{detected: boolean, evidence: string[]}} */
export function detect(env) {
  return detectEvidence({ env, dirs: ['.gemini'], commands: ['gemini'] });
}
export function plan(ctx) {
  home(ctx);
  const f = targets(ctx),
    values = {};
  for (const file of [f.mcp, f.instructions]) values[file] = readOptionalSync(file);
  return { changes: changes(ctx, values), warnings: [], trustReviewRequired: true };
}
async function state(ctx, file) {
  return { record: originalPath(paths(ctx).stateDir, id, file) };
}
async function saveState(ctx, change) {
  const s = await state(ctx, change.file);
  await writeOriginal(
    s.record,
    JSON.stringify({
      file: change.file,
      existed: change.before !== null,
      original: change.before,
      expected: change.after,
    })
  );
}
export async function apply(planResult, ctx) {
  if (!planResult || !Array.isArray(planResult.changes)) fail('E_ARGUMENT', 'Adapter plan is invalid.');
  const currentPlan = plan(ctx).changes,
    allowed = new Set(currentPlan.map((c) => c.file));
  if (planResult.changes.some((c) => !c || !allowed.has(c.file)))
    fail('E_PLAN_TARGET', 'Plan contains a file outside this adapter plan.');
  for (const c of planResult.changes) {
    const fresh = currentPlan.find((x) => x.file === c.file);
    if (!fresh || fresh.after !== c.after) fail('E_CONFIG_CHANGED', 'Plan output changed after planning.');
  }
  for (const c of planResult.changes)
    if ((await read(c.file)) !== c.before) fail('E_CONFIG_CHANGED', 'Configuration changed after planning.');
  for (const c of planResult.changes) {
    if (c.file.endsWith('.json') && c.before !== null) parseJson(c.before);
    if (c.file.endsWith('.md') && c.before !== null) getBlock(c.before);
  }
  for (const c of planResult.changes) {
    await saveState(ctx, c);
    if (c.before !== null) await writeFile(backupName(c.file, ctx.now), c.before, { flag: 'wx', mode: 0o600 });
    await atomicWriteFile(c.file, c.after, { mode: 0o600 });
    const s = await state(ctx, c.file),
      rec = JSON.parse(await readOriginal(s.record));
    rec.expected = c.after;
    await writeOriginal(s.record, JSON.stringify(rec), { overwrite: true });
  }
}
export async function remove(ctx) {
  const f = targets(ctx),
    actions = [];
  for (const file of isCli(ctx) ? [f.instructions] : [f.mcp, f.instructions]) {
    const s = await state(ctx, file),
      raw = await readOriginal(s.record),
      current = await read(file);
    let rec;
    if (raw !== null) {
      try {
        rec = JSON.parse(raw);
      } catch {
        fail('E_STATE_CORRUPT', 'Adapter state is invalid.');
      }
      if (
        !rec ||
        rec.file !== file ||
        typeof rec.existed !== 'boolean' ||
        typeof rec.expected !== 'string' ||
        (rec.existed && typeof rec.original !== 'string')
      )
        fail('E_STATE_CORRUPT', 'Adapter state is invalid.');
    }
    if (current === null) {
      actions.push({ file, record: s.record, cleanup: raw !== null });
      continue;
    }
    if (file === f.instructions) {
      const b = isCli(ctx) ? getBlockCli(current) : getBlock(current);
      if (!b) {
        actions.push({ file, record: s.record, cleanup: raw !== null });
        continue;
      }
      if (isCli(ctx) && b.body !== cliPayload(ctx))
        fail('E_MANAGED_BLOCK_EDITED', 'Managed instructions block was edited.');
      const stripped = current.slice(0, b.start) + current.slice(b.end);
      const keepOriginal =
        isCli(ctx) && restorable(current.slice(0, b.start), current.slice(b.end), rec?.existed ? rec.original : null);
      actions.push({
        file,
        record: s.record,
        cleanup: raw !== null,
        value:
          rec && current === rec.expected
            ? rec.existed
              ? rec.original
              : null
            : keepOriginal
              ? rec.original
              : stripped,
      });
    } else {
      parseJson(current);
      if (rec && current === rec.expected)
        actions.push({ file, record: s.record, cleanup: true, value: rec.existed ? rec.original : null });
      else if (rec) {
        let text = current,
          root = sourceTree(text),
          servers = member(root, 'mcpServers');
        const prior = rec.existed ? parseJson(rec.original).mcpServers?.brainatlas : undefined;
        if (prior !== undefined) {
          if (!servers) {
            text = setMember(text, root, 'mcpServers', { brainatlas: prior });
          } else {
            text = setMember(text, servers.node, 'brainatlas', prior);
          }
        } else if (servers) {
          const owned = member(servers.node, 'brainatlas');
          if (owned) {
            text = removeMember(text, servers.node, 'brainatlas');
            root = sourceTree(text);
            servers = member(root, 'mcpServers');
            if (servers && !servers.node.members.length && !parseJson(rec.original ?? '{}').mcpServers)
              text = removeMember(text, root, 'mcpServers');
          }
        }
        actions.push({ file, record: s.record, cleanup: true, value: text, managedChanges: true });
      } else actions.push({ file, record: s.record, cleanup: false, value: current });
    }
  }
  const settingAction = actions.find((a) => a.file === f.mcp && a.value !== undefined && a.value !== null);
  if (settingAction && settingAction.value.trim()) {
    let text = visitHooks(settingAction.value, ctx, 'remove');
    const original = settingAction.record ? await read(settingAction.record) : null;
    let rec;
    try {
      rec = original && JSON.parse(original);
      // eslint-disable-next-line no-empty
    } catch {}
    const before = rec?.existed ? parseJson(rec.original) : {};
    let root = sourceTree(text),
      hooks = member(root, 'hooks');
    if (hooks) {
      for (const event of ['BeforeAgent', 'SessionStart']) {
        const list = member(hooks.node, event);
        if (list?.node.type === 'array' && !list.node.items.length && !Array.isArray(before.hooks?.[event]))
          text = removeMember(text, hooks.node, event);
        root = sourceTree(text);
        hooks = member(root, 'hooks');
      }
      if (hooks && !hooks.node.members.length && !before.hooks) text = removeMember(text, root, 'hooks');
    }
    settingAction.value = text;
  }
  for (const a of actions) {
    if (a.value === null) await unlink(a.file);
    else if (a.value !== undefined) await atomicWriteFile(a.file, a.value, { mode: 0o600 });
    if (a.cleanup) await clearOriginal(a.record);
  }
}
export async function doctor(ctx) {
  const f = targets(ctx),
    checks = [],
    configText = await read(f.mcp);
  if (isCli(ctx)) {
    let present = false;
    const mdText = await read(f.instructions);
    if (mdText !== null) {
      try {
        present = getBlockCli(mdText)?.body === cliPayload(ctx);
      } catch {
        present = false;
      }
    }
    let shim = false;
    try {
      shim = Boolean(ctx.shimPath && (await stat(ctx.shimPath)).isFile());
      // eslint-disable-next-line no-empty
    } catch {}
    checks.push({
      id: 'instructions',
      ok: present,
      message: present ? 'BrainAtlas CLI instructions are present.' : 'BrainAtlas CLI instructions are missing.',
    });
    checks.push({ id: 'shim', ok: shim, message: shim ? 'Shim file exists.' : 'Shim file is missing.' });
    checks.push({
      id: 'version-drift',
      ok: true,
      message: 'Version drift cannot be determined from adapter configuration.',
    });
    return { ok: checks.every((c) => c.ok), checks };
  }
  let registered = false;
  if (configText !== null) {
    const o = parseJson(configText),
      e = o.mcpServers?.brainatlas;
    registered = e?.command === ctx.nodePath && JSON.stringify(e.args) === JSON.stringify([ctx.shimPath, 'mcp']);
  }
  checks.push({
    id: 'registered',
    ok: registered,
    message: registered ? 'BrainAtlas MCP server is registered.' : 'BrainAtlas MCP server is not registered.',
  });
  let shim = false;
  try {
    shim = Boolean(ctx.shimPath && (await stat(ctx.shimPath)).isFile());
    // eslint-disable-next-line no-empty
  } catch {}
  checks.push({ id: 'shim', ok: shim, message: shim ? 'Shim file exists.' : 'Shim file is missing.' });
  checks.push({
    id: 'version-drift',
    ok: true,
    message: 'Version drift cannot be determined from adapter configuration.',
  });
  const hookConfig = configText === null ? {} : parseJson(configText).hooks || {};
  const hookPresent = (hookConfig.BeforeAgent || []).some(
    (g) =>
      g?.matcher === '*' &&
      Array.isArray(g.hooks) &&
      g.hooks.some(
        (h) => h?.name === 'brainatlas-context' && h.type === 'command' && h.command === hookCommand(ctx, 'prompt')
      )
  );
  const sessionPresent = (hookConfig.SessionStart || []).some(
    (g) =>
      g?.matcher === '*' &&
      Array.isArray(g.hooks) &&
      g.hooks.some(
        (h) =>
          h?.name === 'brainatlas-session' && h.type === 'command' && h.command === hookCommand(ctx, 'session-start')
      )
  );
  const legacy = (event, name, verb) =>
    (hookConfig[event] || []).some(
      (g) =>
        g?.matcher === '*' &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h) => h?.name === name && h.type === 'command' && h.command === hookCommand(ctx, verb, true))
    );
  checks.push({
    id: 'hook-present',
    ok: !legacy('BeforeAgent', 'brainatlas-context', 'prompt'),
    message: hookPresent
      ? 'Gemini BeforeAgent hook is registered; enable it in the hooks panel if needed.'
      : 'Gemini BeforeAgent hook is not registered; enablement in the hooks panel may be required.',
  });
  checks.push({
    id: 'session-hook-present',
    ok: !legacy('SessionStart', 'brainatlas-session', 'session-start'),
    message: sessionPresent ? 'Gemini SessionStart hook is registered.' : 'Gemini SessionStart hook is not registered.',
  });
  const md = await read(f.instructions);
  let present = false;
  if (md !== null) present = Boolean(getBlock(md));
  checks.push({
    id: 'instructions',
    ok: present,
    message: present ? 'BrainAtlas instructions are present.' : 'BrainAtlas instructions are not present.',
  });
  return { ok: checks.every((c) => c.ok), checks };
}
export async function trustReview(_ctx) {
  return {
    required: true,
    client: displayName,
    steps: ['Start a new Gemini CLI session to load the MCP server and instructions.'],
  };
}
