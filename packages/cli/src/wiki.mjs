// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';
import * as core from '@brainatlas/core';

const WIKI_OPERATIONS = core.OPERATIONS.filter((operation) => operation.cli.startsWith('wiki '));
const SUBCOMMANDS = WIKI_OPERATIONS.map(({ cli }) => cli.split(' ')[1]);
const TOOL_FOR = Object.fromEntries(WIKI_OPERATIONS.map(({ cli, tool }) => [cli.split(' ')[1], tool]));
const WRITE_SUBCOMMANDS = new Set(
  WIKI_OPERATIONS.filter(({ kind }) => kind === 'write').map(({ cli }) => cli.split(' ')[1])
);

const ALLOWED_OPTIONS = {
  query: new Set(['--limit', '--compact', '--provenance']),
  read: new Set(['--anchor', '--max-chars']),
  list: new Set(['--type']),
  status: new Set(),
  lint: new Set(),
  write: new Set(['--dry-run', '--expect-sha256']),
  update: new Set(['--append', '--expect-sha256', '--frontmatter-json', '--dry-run']),
  create: new Set(['--dry-run']),
  link: new Set(['--dry-run']),
  reindex: new Set(['--dry-run']),
};

const MAX_CONTENT_BYTES = 1_048_576;

const failure = (code, message) => Object.assign(new Error(message), { code });

function integerOption(name, raw) {
  if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw failure('E_ARGUMENT', `${name} must be an integer.`);
  }
  return Number(raw);
}

function shaOption(raw) {
  if (!/^[0-9a-fA-F]{64}$/u.test(raw))
    throw failure('E_ARGUMENT', '--expect-sha256 must be a 64-character hex SHA-256.');
  return raw;
}

function pathArgument(sub, positional) {
  if (!positional.length) throw failure('E_ARGUMENT', `wiki ${sub} requires a Wiki path.`);
  if (positional.length > 1) throw failure('E_ARGUMENT', `wiki ${sub} accepts one Wiki path.`);
  if (!positional[0].endsWith('.md')) throw failure('E_ARGUMENT', `wiki ${sub} path must end in .md.`);
  return positional[0];
}

function frontmatterOption(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw failure('E_ARGUMENT', '--frontmatter-json must be a JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('E_ARGUMENT', '--frontmatter-json must be a JSON object.');
  return value;
}

export function parseWikiArguments(argv) {
  const sub = argv[0];
  if (sub === undefined || sub.startsWith('-') || !Object.hasOwn(TOOL_FOR, sub)) {
    throw failure('E_ARGUMENT', `wiki requires one of: ${SUBCOMMANDS.join(', ')}.`);
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
    if (name === '--provenance') {
      options['--provenance'] = true;
      continue;
    }
    if (name === '--append' || name === '--dry-run') {
      if (equals >= 0) throw failure('E_ARGUMENT', `${name} does not take a value.`);
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
  if (sub === 'query') {
    if (!positional.length) throw failure('E_ARGUMENT', 'wiki query requires search text.');
  } else if (sub === 'read') {
    if (!positional.length) throw failure('E_ARGUMENT', 'wiki read requires a Wiki path.');
    if (positional.length > 1) throw failure('E_ARGUMENT', 'wiki read accepts one Wiki path.');
  } else if (sub === 'write' || sub === 'update' || sub === 'link') {
    pathArgument(sub, positional);
  } else if (sub === 'create') {
    if (positional.length < 2) throw failure('E_ARGUMENT', 'wiki create requires a type and a page name.');
    if (!['entity', 'concept', 'source', 'summary', 'query'].includes(positional[0]))
      throw failure('E_ARGUMENT', 'wiki create type must be entity, concept, source, summary or query.');
  } else if (positional.length) {
    throw failure('E_ARGUMENT', `wiki ${sub} accepts no positional arguments.`);
  }

  const args = {};
  if (sub === 'query') {
    args.query = positional.join(' ');
    if (options['--limit'] !== undefined) args.limit = integerOption('--limit', options['--limit']);
    if (options.compact === true) args.compact = true;
    if (options['--provenance'] === true) args.provenance = true;
  } else if (sub === 'read') {
    args.path = positional[0];
    if (options['--anchor'] !== undefined) args.anchor = options['--anchor'];
    if (options['--max-chars'] !== undefined) args.maxChars = integerOption('--max-chars', options['--max-chars']);
  } else if (sub === 'write') {
    args.path = positional[0];
    if (options['--expect-sha256'] !== undefined) args.expectedSha256 = shaOption(options['--expect-sha256']);
  } else if (sub === 'update') {
    args.path = positional[0];
    args.append = options['--append'] === true;
    if (options['--expect-sha256'] !== undefined) args.expectedSha256 = shaOption(options['--expect-sha256']);
    if (options['--frontmatter-json'] !== undefined)
      args.frontmatter = frontmatterOption(options['--frontmatter-json']);
  } else if (sub === 'create') {
    args.type = positional[0];
    args.name = positional.slice(1).join(' ');
  } else if (sub === 'link') {
    args.path = positional[0];
  } else if (sub === 'list' && options['--type'] !== undefined) {
    args.type = options['--type'];
  }
  const dryRun = options['--dry-run'] === true;
  return { sub, vault, args, ...(dryRun ? { dryRun: true } : {}) };
}

function toolFailure(text) {
  const match = /^(E_[A-Z0-9_]+): ([\s\S]*)$/u.exec(text);
  if (!match) return failure('E_WIKI_TOOL', text);
  return failure(match[1], match[2]);
}

async function readPageContent(stdin, sub, optional = false) {
  const required = `wiki ${sub} requires page content on standard input.`;
  let text;
  if (typeof stdin === 'string') text = stdin;
  else {
    if (stdin === process.stdin && process.stdin.isTTY === true) {
      if (optional) return '';
      throw failure('E_ARGUMENT', required);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stdin) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      bytes += buffer.length;
      if (bytes > MAX_CONTENT_BYTES) throw failure('E_ARGUMENT', 'Page content is larger than 1 MiB.');
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(text) > MAX_CONTENT_BYTES) throw failure('E_ARGUMENT', 'Page content is larger than 1 MiB.');
  if (text.trim() === '') {
    if (optional) return '';
    throw failure('E_ARGUMENT', required);
  }
  return text;
}

export async function runWikiCommand(argv, { env = process.env, stdin = process.stdin } = {}) {
  const { sub, vault, args, dryRun = false } = parseWikiArguments(argv);
  const { callToolInProcess, serverOptions } = await import('@brainatlas/mcp');
  /** @type {{config:any, paths:any, env:any, dryRun?:boolean}} */
  const options = await serverOptions(env);
  if (vault !== undefined) options.paths.vaultDir = resolve(vault);
  const changes = WRITE_SUBCOMMANDS.has(sub);
  if (changes && options.config.readOnly === true)
    throw failure('E_READ_ONLY', 'The vault is read-only (readOnly: true).');
  let okfFindings = [];
  if (sub === 'write') {
    args.content = await readPageContent(stdin, sub);
    const parsed = core.parseFrontmatter(args.content);
    if (parsed.errors.length) throw failure('E_INVALID_INPUT', 'Page frontmatter is invalid.');
    const normalized = args.path.replace(/^wiki\//u, '');
    okfFindings = core.checkPage({
      path: `wiki/${normalized}`,
      data: parsed.data,
      body: parsed.body,
      errors: parsed.errors,
    });
    if (options.config.okf?.level === 'strict' && okfFindings.some((finding) => finding.severity === 'error')) {
      const rules = [...new Set(okfFindings.filter((finding) => finding.severity === 'error').map(({ rule }) => rule))];
      throw failure('E_OKF_INVALID', `OKF validation failed: ${rules.join(', ')}.`);
    }
  } else if (sub === 'update') {
    const text = await readPageContent(stdin, sub);
    const patch = args.append === true ? { append: text } : { body: text };
    if (args.frontmatter !== undefined) patch.frontmatter = args.frontmatter;
    args.patch = patch;
    delete args.append;
    delete args.frontmatter;
  } else if (sub === 'create') {
    args.content = await readPageContent(stdin, sub, true);
  }
  if (changes && dryRun) options.dryRun = true;
  const result = await callToolInProcess(options, TOOL_FOR[sub], args);
  if (result.isError) throw toolFailure(result.text);
  let value;
  try {
    value = JSON.parse(result.text);
  } catch {
    throw failure('E_WIKI_TOOL', 'The Wiki tool returned an unreadable response.');
  }
  if (sub === 'write') {
    const output = {
      ok: true,
      path: value.path,
      created: value.created === true,
      updated: value.created !== true,
      dryRun,
      okfFindings,
    };
    if (args.expectedSha256 !== undefined && value.sha256 !== undefined) output.sha256 = value.sha256;
    if (Array.isArray(value.warnings)) output.warnings = value.warnings;
    return { sub, value: output };
  }
  if (sub === 'update') {
    const output = { ok: true, path: value.path, updated: true, dryRun };
    if (value.sha256 !== undefined) output.sha256 = value.sha256;
    if (Array.isArray(value.warnings)) output.warnings = value.warnings;
    return { sub, value: output };
  }
  if (sub === 'create') {
    const output = { ok: true, path: value.path, created: true, dryRun };
    if (Array.isArray(value.warnings)) output.warnings = value.warnings;
    return { sub, value: output };
  }
  if (sub === 'link') {
    return { sub, value: { ok: true, path: value.path, linked: value.linked, dryRun } };
  }
  if (sub === 'reindex') {
    return {
      sub,
      value: { ok: true, indexed: value.indexed, added: value.added, removed: value.removed, dryRun },
    };
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

export function formatWikiResult(sub, value) {
  if (sub === 'write') {
    const verb = value?.created === true ? 'created' : 'updated';
    const head = value?.dryRun === true ? `Dry run: ${value.path} would be ${verb}.` : `Wrote ${value.path} (${verb}).`;
    const findings = Array.isArray(value?.okfFindings)
      ? value.okfFindings.map((finding) => `${finding.severity} ${finding.rule}: ${finding.message}`)
      : [];
    return [head, ...findings].join('\n');
  }
  if (sub === 'update' || sub === 'create') {
    const verb = sub === 'update' ? 'updated' : 'created';
    return value?.dryRun === true
      ? `Dry run: ${value.path} would be ${verb}.`
      : `${verb === 'created' ? 'Created' : 'Updated'} ${value.path}.`;
  }
  if (sub === 'link') {
    const head = `Linked ${value?.linked ?? 0} page(s) in ${value?.path}.`;
    return value?.dryRun === true ? `Dry run: ${head}` : head;
  }
  if (sub === 'query') {
    const results = Array.isArray(value?.results) ? value.results : [];
    if (!results.length) return 'No confident match.';
    return results.map(queryBlock).join('\n\n');
  }
  if (sub === 'read') {
    const content = typeof value?.content === 'string' ? value.content : '';
    return value?.truncated === true ? `${content}\n[truncated]` : content;
  }
  if (sub === 'list') {
    return Array.isArray(value?.pages) ? value.pages.join('\n') : '';
  }
  return JSON.stringify(value, null, 2);
}
