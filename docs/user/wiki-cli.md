# Wiki tools from the shell (`brainatlas wiki`)

`brainatlas wiki` runs the same Wiki tools as the MCP server, in process, so a machine that can run shell commands but
cannot register an MCP server or hooks can still query, read and write a vault. The command calls the existing MCP tool
handlers; search, page reading, status, lint, path checks, secret scanning, locking, atomic writes and the Wiki log are
not duplicated. `write`, `update`, `create`, `link` and `reindex` change the Wiki; `query`, `read`, `list`, `status` and
`lint` are read-only.

```text
brainatlas wiki query <text> [--limit N] [--compact] [--provenance] | read <path> [--anchor A] [--max-chars N] | list [--type T] | status | lint | write <path> [--dry-run] [--expect-sha256 H] (content on stdin) | update <path> [--append] [--expect-sha256 H] [--frontmatter-json JSON] [--dry-run] (content on stdin) | create <entity|concept> <name...> [--dry-run] (content on stdin) | link <path> [--dry-run] | reindex [--dry-run]  [--vault PATH] [--json]
```

| Subcommand | MCP tool | Arguments |
|---|---|---|
| `query <text…>` | `wiki_query` | all words after `query` joined by one space; `--limit N` (integer), `--compact` and `--provenance` are optional |
| `read <path>` | `wiki_read_page` | the path as given (`concepts/x.md`, `wiki/concepts/x.md` or with `#anchor`); `--anchor A` and `--max-chars N` are optional; `read index.md` reads the index |
| `list` | `wiki_list_pages` | `--type T` is optional |
| `status` | `wiki_status` | none |
| `lint` | `wiki_lint` | none |
| `write <path>` | `wiki_write_page` | exactly one path ending in `.md`; content (frontmatter and body) on standard input; `--expect-sha256 H` and `--dry-run` are optional |
| `update <path>` | `wiki_update_page` | exactly one path ending in `.md`; body text on standard input; `--append` adds it to the existing body instead, `--frontmatter-json JSON` merges frontmatter, and `--expect-sha256 H` and `--dry-run` are optional |
| `create <entity\|concept> <name…>` | `wiki_create` | the page type, the name (all remaining words joined by one space) and the content on standard input; `--dry-run` is optional |
| `link <path>` | `wiki_add_crosslinks` | exactly one path ending in `.md`; `--dry-run` is optional |
| `reindex` | `wiki_update_index` | none; `--dry-run` is optional |

- `--vault PATH` overrides the configured vault (`BRAINATLAS_VAULT` and `config.json`). Without it, the same vault,
  config, state directory and retrieval settings as `brainatlas mcp` are used.
- `--json` prints the parsed tool value, deep-equal to what the MCP server returns for the same tool and arguments.
  Without it, text output is printed: search hits with snippets, page content, one path per line for `list`,
  pretty JSON for `status` and `lint`, and one summary line for `write`, `update`, `create` and `link`.
- Argument problems (missing or unknown subcommand, missing text or path, extra positional words, unknown option, a
  non-integer `--limit`/`--max-chars`, a path without `.md`, a malformed `--expect-sha256` or `--frontmatter-json`)
  fail with `E_ARGUMENT` before a tool is called. A tool error fails with the tool's own `E_` code and message.
- Each call starts a new Node process, loads the vault and exits by itself after the command.

## Writing a page

The page content is read from standard input as UTF-8, including the YAML frontmatter. A quoted heredoc keeps the
content literal:

```bash
brainatlas wiki write concepts/example.md <<'EOF'
---
type: concept
title: "Example"
generated: "2026-11-26"
status: confirmed
sources: []
verified: []
stale_after: "P90D"
---

# Example

Body text.
EOF
```

`concepts/example.md` and `wiki/concepts/example.md` name the same page. Missing, empty or whitespace-only input, a path that
does not end in `.md`, more than one path and input over 1 MiB are `E_ARGUMENT`; on an interactive terminal the command
does not wait for input and fails the same way.

`--expect-sha256 H` takes the 64-character SHA-256 hex digest `brainatlas wiki read` returned. A different hash on disk
is `E_CONFLICT` and nothing is written. `--vault`/`BRAINATLAS_VAULT` choose the vault as for the read commands.

A successful write appends exactly one `write-page` entry to `wiki/log.md`. With `--json` the output is:

```json
{ "ok": true, "path": "wiki/concepts/example.md", "created": true, "updated": false, "dryRun": false, "okfFindings": [] }
```

`sha256` is added when `--expect-sha256` was given. `created` is true when the page did not exist before; `updated` is
its negation. Without `--json` the command prints `Wrote wiki/<path> (created|updated).` and one line per OKF finding.

## Updating, creating and linking pages

`brainatlas wiki update <path>` reads body text from standard input and sends `patch: {body}`; with `--append` it sends
`patch: {append}` instead. `--frontmatter-json '{"status":"confirmed"}'` adds `patch.frontmatter`, merged into the
existing frontmatter. The target page must already exist, and `--expect-sha256 H` refuses with `E_CONFLICT` when its
bytes differ.

`brainatlas wiki create <entity|concept> <name…>` reads the page content from standard input and sends
`{type, name, content}` to `wiki_create`: the same path, frontmatter, index line and `create-entity`/`create-concept` log
action as before. A name with no ASCII letter or digit is refused with `E_INVALID_INPUT`; an existing page is
`E_ALREADY_EXISTS`.

`brainatlas wiki link <path>` adds a `## See also` section with links to the pages the target names (MCP
`wiki_add_crosslinks`); it never changes the linked pages.

All three follow the same standard-input rules as `write` (1 MiB, an interactive terminal is refused), return
`E_READ_ONLY` when the configured vault has `readOnly: true`, and support `--dry-run`.

## OKF findings and errors

The parsed input is checked with the same OKF rules as `wiki status`. Findings are always returned.
With `okf.level` set to `strict`, any finding with severity `error` refuses the write with `E_OKF_INVALID`, listing only
the rule ids; nothing is written. With the default `warn` level the page is written and the findings are reported.

| Code | Meaning |
|---|---|
| `E_ARGUMENT` | bad subcommand, option, path, input size or empty standard input |
| `E_READ_ONLY` | `readOnly: true` in the configuration; nothing is read from the vault or written |
| `E_INVALID_INPUT` | the frontmatter cannot be parsed |
| `E_OKF_INVALID` | strict OKF findings of severity `error` |
| `E_PATH_ESCAPE` | the path is absolute, contains `..` or a backslash, leaves `wiki/`, or names `index.md`, `log.md` or the lock file |
| `E_SECRET_DETECTED` | the path or content looks secret; the page and `wiki/log.md` stay unchanged |
| `E_CONFLICT` | the page on disk does not match `--expect-sha256` |

## Reindexing the index

```bash
brainatlas wiki reindex --json
```

`reindex` calls `wiki_update_index`: existing `wiki/index.md` lines, including their summaries, are kept byte for byte;
only pages without an entry are added and entries of deleted pages are removed. A real run appends one `update-index`
entry to `wiki/log.md`. With `--json` the output is
`{ "ok": true, "indexed": n, "added": n, "removed": n, "dryRun": false }`.

## `--dry-run`

`--dry-run` on `write`, `update`, `create`, `link` or `reindex` runs every check the real call runs — read-only mode,
standard input, path rules, the secret path and content scan, frontmatter parsing, strict OKF and the expected hash —
and writes nothing: no page, no index, no log line, no temporary file and no lock file. The JSON output carries
`"dryRun": true` (and, for `write`, `created`). With `--expect-sha256` the hash check still runs (a mismatch is
`E_CONFLICT`), but no `sha256` is returned in a dry run because no new bytes exist.
