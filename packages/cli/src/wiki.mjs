// SPDX-License-Identifier: MIT
// `brainatlas wiki <sub>`: the Wiki tools of the MCP server for machines that can run a shell command but cannot
// register MCP (the `cli` channel). Every subcommand calls the registered MCP handler in process, so search, reading,
// writes, the secret filter, path rules, the write lock and expectedSha256 are the server's own code paths.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TOOL_FOR = {
  query: 'wiki_query',
  read: 'wiki_read_page',
  index: 'wiki_read_index',
  list: 'wiki_list_pages',
  status: 'wiki_status',
  lint: 'wiki_lint',
  write: 'wiki_write_page',
  update: 'wiki_update_page',
  'create-entity': 'wiki_create_entity',
  'create-concept': 'wiki_create_concept',
  crosslinks: 'wiki_add_crosslinks',
  'update-index': 'wiki_update_index',
};

/** BA-43d: subcommands that write. They are refused in a read-only installation, as the MCP server omits them there. */
export const WRITE_SUBCOMMANDS = new Set([
  'write',
  'update',
  'create-entity',
  'create-concept',
  'crosslinks',
  'update-index',
]);

const ALLOWED_OPTIONS = {
  query: new Set(['--limit', '--compact', '--provenance']),
  read: new Set(['--anchor', '--max-chars']),
  index: new Set(),
  list: new Set(['--type']),
  status: new Set(),
  lint: new Set(),
  write: new Set(['--file', '--expected-sha256']),
  update: new Set(['--file', '--expected-sha256', '--patch', '--append']),
  'create-entity': new Set(['--file']),
  'create-concept': new Set(['--file']),
  crosslinks: new Set(),
  'update-index': new Set(),
};

const BOOLEAN_OPTIONS = new Set(['--compact', '--provenance', '--patch', '--append']);
// Subcommands whose page content comes from --file or standard input, never from a shell argument.
const READS_INPUT = new Set(['write', 'update', 'create-entity', 'create-concept']);
// Larger than any page the tools accept in practice; bounds memory when a caller pipes something unexpected.
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

const failure = (code, message) => Object.assign(new Error(message), { code });

function integerOption(name, raw) {
  if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw failure('E_ARGUMENT', `${name} must be an integer.`);
  }
  return Number(raw);
}

/**
 * Parse the words after `wiki` into `{sub, vault, args, input}`. Options are validated before any tool is called and
 * before any input is read. `input` is null for subcommands without page content, otherwise
 * `{mode: 'content'|'patch'|'append', file?: string}`.
 */
export function parseWikiArguments(argv) {
  const sub = argv[0];
  if (sub === undefined || sub.startsWith('-') || !Object.hasOwn(TOOL_FOR, sub)) {
    throw failure('E_ARGUMENT', `wiki requires one of: ${Object.keys(TOOL_FOR).join(', ')}.`);
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
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] = true;
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
  const onePath = (what) => {
    if (!positional.length) throw failure('E_ARGUMENT', `wiki ${sub} requires a Wiki path.`);
    if (positional.length > 1) throw failure('E_ARGUMENT', `wiki ${sub} accepts one Wiki path${what}.`);
  };
  if (sub === 'query') {
    if (!positional.length) throw failure('E_ARGUMENT', 'wiki query requires search text.');
  } else if (sub === 'read' || sub === 'crosslinks') {
    onePath('');
  } else if (sub === 'write' || sub === 'update') {
    onePath('; pass the content with --file or on standard input');
  } else if (sub === 'create-entity' || sub === 'create-concept') {
    if (!positional.length) throw failure('E_ARGUMENT', `wiki ${sub} requires a page name.`);
  } else if (positional.length) {
    throw failure('E_ARGUMENT', `wiki ${sub} accepts no positional arguments.`);
  }
  if (options['--patch'] === true && options['--append'] === true) {
    throw failure('E_ARGUMENT', 'wiki update accepts only one of --patch and --append.');
  }
  if (options['--expected-sha256'] !== undefined && !/^[0-9a-fA-F]{64}$/u.test(options['--expected-sha256'])) {
    throw failure('E_ARGUMENT', '--expected-sha256 must be 64 hexadecimal digits.');
  }
  if (options['--file'] === '') throw failure('E_ARGUMENT', 'Missing value for --file.');

  const args = {};
  if (sub === 'query') {
    args.query = positional.join(' ');
    if (options['--limit'] !== undefined) args.limit = integerOption('--limit', options['--limit']);
    if (options['--compact'] === true) args.compact = true;
    if (options['--provenance'] === true) args.provenance = true;
  } else if (sub === 'read') {
    args.path = positional[0];
    if (options['--anchor'] !== undefined) args.anchor = options['--anchor'];
    if (options['--max-chars'] !== undefined) args.maxChars = integerOption('--max-chars', options['--max-chars']);
  } else if (sub === 'list' && options['--type'] !== undefined) {
    args.type = options['--type'];
  } else if (sub === 'write' || sub === 'update' || sub === 'crosslinks') {
    args.path = positional[0];
    if (options['--expected-sha256'] !== undefined) args.expectedSha256 = options['--expected-sha256'];
  } else if (sub === 'create-entity' || sub === 'create-concept') {
    args.name = positional.join(' ');
  }
  let input = null;
  if (READS_INPUT.has(sub)) {
    const mode = options['--patch'] === true ? 'patch' : options['--append'] === true ? 'append' : 'content';
    input = { mode, ...(options['--file'] === undefined ? {} : { file: options['--file'] }) };
  }
  return { sub, vault, args, input };
}

/** Read standard input to the end, refusing a terminal (nothing piped) and anything over the size bound. */
async function readStandardInput(stdin) {
  if (stdin.isTTY) {
    throw failure('E_ARGUMENT', 'No page content: pass --file <path> or pipe the content on standard input.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw failure('E_ARGUMENT', 'The page content is larger than 4 MiB.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readInputText(input, stdin) {
  if (input.file === undefined) return readStandardInput(stdin);
  let bytes;
  try {
    bytes = await readFile(resolve(input.file));
  } catch (error) {
    throw failure('E_ARGUMENT', error?.code === 'ENOENT' ? '--file does not exist.' : '--file cannot be read.');
  }
  if (bytes.length > MAX_INPUT_BYTES) throw failure('E_ARGUMENT', 'The page content is larger than 4 MiB.');
  return bytes.toString('utf8');
}

/** Turn the input text into the tool arguments for its mode. Empty input is refused: it is almost always a mistake. */
function applyInput(sub, args, input, text) {
  if (!text.trim()) {
    throw failure('E_ARGUMENT', 'No page content: pass --file <path> or pipe the content on standard input.');
  }
  if (input.mode === 'patch') {
    let patch;
    try {
      patch = JSON.parse(text);
    } catch {
      throw failure('E_ARGUMENT', 'wiki update --patch needs a JSON object on standard input or in --file.');
    }
    return { ...args, patch };
  }
  if (input.mode === 'append') return { ...args, patch: { append: text } };
  return { ...args, content: text };
}

/** A tool error: the code is the leading E_ token of the fixed tool text, the message is the rest. */
function toolFailure(text) {
  const match = /^(E_[A-Z0-9_]+): ([\s\S]*)$/u.exec(text);
  if (!match) return failure('E_WIKI_TOOL', text);
  return failure(match[1], match[2]);
}

/**
 * Parse, call the corresponding MCP tool in process and return `{sub, value}` with the parsed tool value.
 * @param {string[]} argv words after `wiki`
 * @param {{env?:NodeJS.ProcessEnv, stdin?:NodeJS.ReadableStream & {isTTY?:boolean}}} [settings]
 */
export async function runWikiCommand(argv, { env = process.env, stdin = process.stdin } = {}) {
  const { sub, vault, args, input } = parseWikiArguments(argv);
  const { callToolInProcess, serverOptions } = await import('@brainatlas/mcp');
  const options = await serverOptions(env);
  if (vault !== undefined) options.paths.vaultDir = resolve(vault);
  if (WRITE_SUBCOMMANDS.has(sub) && options.config?.readOnly === true) {
    throw failure('E_READ_ONLY', 'This installation is read-only; Wiki writes are disabled.');
  }
  const toolArgs = input === null ? args : applyInput(sub, args, input, await readInputText(input, stdin));
  const result = await callToolInProcess(options, TOOL_FOR[sub], toolArgs);
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
  const provenance =
    item.provenance === 'none' || item.provenance === 'partial' ? ` [provenance: ${item.provenance}]` : '';
  const lines = [`${index + 1}. ${item.path}${heading}${stale}${provenance}`];
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
