// SPDX-License-Identifier: MIT
// `brainatlas wiki <sub>`: read-only Wiki tools for machines that can run a shell command but cannot register MCP.
// The command calls the registered MCP handlers in process; it has no write path of its own.
import { resolve } from 'node:path';

const TOOL_FOR = {
  query: 'wiki_query',
  read: 'wiki_read_page',
  index: 'wiki_read_index',
  list: 'wiki_list_pages',
  status: 'wiki_status',
  lint: 'wiki_lint',
};

const ALLOWED_OPTIONS = {
  query: new Set(['--limit', '--compact']),
  read: new Set(['--anchor', '--max-chars']),
  index: new Set(),
  list: new Set(['--type']),
  status: new Set(),
  lint: new Set(),
};

const failure = (code, message) => Object.assign(new Error(message), { code });

function integerOption(name, raw) {
  if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw failure('E_ARGUMENT', `${name} must be an integer.`);
  }
  return Number(raw);
}

/** Parse the words after `wiki` into `{sub, vault, args}`. Options are validated before any tool is called. */
export function parseWikiArguments(argv) {
  const sub = argv[0];
  if (sub === undefined || sub.startsWith('-') || !Object.hasOwn(TOOL_FOR, sub)) {
    throw failure('E_ARGUMENT', 'wiki requires one of: query, read, index, list, status, lint.');
  }
  const allowed = ALLOWED_OPTIONS[sub];
  const positional = [];
  const options = {};
  let vault;
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--json') continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    if (name !== '--vault' && !allowed.has(name)) {
      throw failure('E_ARGUMENT', `Unknown option for wiki ${sub}: ${name}.`);
    }
    if (name === '--compact') {
      options.compact = true;
      continue;
    }
    let raw;
    if (equals >= 0) raw = token.slice(equals + 1);
    else {
      raw = argv[++index];
      if (raw === undefined || raw.startsWith('--')) throw failure('E_ARGUMENT', `Missing value for ${name}.`);
    }
    if (name === '--vault') vault = raw;
    else options[name] = raw;
  }
  if (sub === 'query') {
    if (!positional.length) throw failure('E_ARGUMENT', 'wiki query requires search text.');
  } else if (sub === 'read') {
    if (!positional.length) throw failure('E_ARGUMENT', 'wiki read requires a Wiki path.');
    if (positional.length > 1) throw failure('E_ARGUMENT', 'wiki read accepts one Wiki path.');
  } else if (positional.length) {
    throw failure('E_ARGUMENT', `wiki ${sub} accepts no positional arguments.`);
  }

  const args = {};
  if (sub === 'query') {
    args.query = positional.join(' ');
    if (options['--limit'] !== undefined) args.limit = integerOption('--limit', options['--limit']);
    if (options.compact === true) args.compact = true;
  } else if (sub === 'read') {
    args.path = positional[0];
    if (options['--anchor'] !== undefined) args.anchor = options['--anchor'];
    if (options['--max-chars'] !== undefined) args.maxChars = integerOption('--max-chars', options['--max-chars']);
  } else if (sub === 'list' && options['--type'] !== undefined) {
    args.type = options['--type'];
  }
  return { sub, vault, args };
}

/** A tool error: the code is the leading E_ token of the fixed tool text, the message is the rest. */
function toolFailure(text) {
  const match = /^(E_[A-Z0-9_]+): ([\s\S]*)$/u.exec(text);
  if (!match) return failure('E_WIKI_TOOL', text);
  return failure(match[1], match[2]);
}

/**
 * Parse, call the corresponding MCP read tool in process and return `{sub, value}` with the parsed tool value.
 * @param {string[]} argv words after `wiki`
 * @param {{env?:NodeJS.ProcessEnv}} [settings]
 */
export async function runWikiCommand(argv, { env = process.env } = {}) {
  const { sub, vault, args } = parseWikiArguments(argv);
  const { callToolInProcess, serverOptions } = await import('@brainatlas/mcp');
  const options = await serverOptions(env);
  if (vault !== undefined) options.paths.vaultDir = resolve(vault);
  const result = await callToolInProcess(options, TOOL_FOR[sub], args);
  if (result.isError) throw toolFailure(result.text);
  let value;
  try {
    value = JSON.parse(result.text);
  } catch {
    throw failure('E_WIKI_TOOL', 'The Wiki tool returned an unreadable response.');
  }
  return { sub, value };
}

const queryBlock = (item, index) => {
  const heading = typeof item.heading === 'string' && item.heading.length ? ` § ${item.heading}` : '';
  const stale = item.stale === true ? ' [stale]' : '';
  const lines = [`${index + 1}. ${item.path}${heading}${stale}`];
  if (typeof item.snippet === 'string' && item.snippet.length) {
    for (const line of item.snippet.split('\n')) lines.push(`   ${line}`);
  }
  return lines.join('\n');
};

/** Human output for one tool value. `--json` callers never come through here. */
export function formatWikiResult(sub, value) {
  if (sub === 'query') {
    const results = Array.isArray(value?.results) ? value.results : [];
    if (!results.length) return 'No confident match.';
    return results.map(queryBlock).join('\n\n');
  }
  if (sub === 'read' || sub === 'index') {
    const content = typeof value?.content === 'string' ? value.content : '';
    return value?.truncated === true ? `${content}\n[truncated]` : content;
  }
  if (sub === 'list') {
    return Array.isArray(value?.pages) ? value.pages.join('\n') : '';
  }
  return JSON.stringify(value, null, 2);
}
