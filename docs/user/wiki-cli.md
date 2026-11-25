# Wiki tools from the shell (`brainatlas wiki`)

`brainatlas wiki` runs the same Wiki tools as the MCP server, in process, so a machine that can run shell commands but
cannot register an MCP server or hooks can still query, read and update a vault. The command calls the existing MCP
tool handlers; search, page reading, writing, status and lint logic are not duplicated.

```text
brainatlas wiki query <text> [--limit N] [--compact] [--provenance] | read <path> [--anchor A] [--max-chars N] | index | list [--type T] | status | lint  [--vault PATH] [--json]
```

| Subcommand | MCP tool | Arguments |
|---|---|---|
| `query <text…>` | `wiki_query` | all words after `query` joined by one space; `--limit N` (integer), `--compact` and `--provenance` are optional |
| `read <path>` | `wiki_read_page` | the path as given (`concepts/x.md`, `wiki/concepts/x.md` or with `#anchor`); `--anchor A` and `--max-chars N` are optional |
| `index` | `wiki_read_index` | none |
| `list` | `wiki_list_pages` | `--type T` is optional |
| `status` | `wiki_status` | none |
| `lint` | `wiki_lint` | none |
| `write <path>` | `wiki_write_page` | page content (see below); `--expected-sha256 H` is optional |
| `update <path>` | `wiki_update_page` | page content as `content`; with `--patch` the input is a JSON patch object; with `--append` the input becomes `patch.append`; `--expected-sha256 H` is optional |
| `create-entity <name…>` | `wiki_create_entity` | all words after the subcommand joined by one space as `name`; page content |
| `create-concept <name…>` | `wiki_create_concept` | as `create-entity` |
| `crosslinks <path>` | `wiki_add_crosslinks` | none |
| `update-index` | `wiki_update_index` | none |

```text
brainatlas wiki write <path> | update <path> [--patch | --append] | create-entity <name> | create-concept <name>  [--file F | stdin] [--expected-sha256 H] | crosslinks <path> | update-index  [--vault PATH] [--json]
```

- The read subcommands (`query`, `read`, `index`, `list`, `status`, `lint`) write nothing to the vault and no config,
  state or log; the search index cache may be written by the existing searcher exactly as the MCP server does.
- The write subcommands (BA-43d) write exactly what the MCP tool writes: the page, the `index.md` line for a create,
  and the `wiki/log.md` entry, under the same vault-wide write lock, with the same secret filter, path rules and
  provenance rules ([MCP tools](../contracts/mcp-tools.md)). Their `--json` value deep-equals the MCP tool value.
- Page content is never a command-line word: it is read from `--file <path>` (relative to the current directory) or, without
  `--file`, from standard input until it closes. A terminal on standard input, empty or whitespace-only content, a
  missing `--file`, input over 4 MiB, invalid JSON for `--patch`, both `--patch` and `--append`, and an
  `--expected-sha256` that is not 64 hexadecimal digits fail with `E_ARGUMENT` before any tool runs.
- `--append` adds the text to the end of the body as is, so start it with a blank line and a heading. Use the `sha256`
  from `wiki read --json` as `--expected-sha256`; a page that changed since fails with `E_CONFLICT` and nothing is
  written. A successful write with `--expected-sha256` returns the `sha256` to use next.
- In a read-only installation (`readOnly: true`) every write subcommand fails with `E_READ_ONLY` before reading input,
  as the MCP server does not offer its write tools there.
- With semantic retrieval on (Full), a CLI write does not wait for the semantic index; the next query refreshes it, as
  it does after a change from Obsidian or sync.
- `--vault PATH` overrides the configured vault (`BRAINATLAS_VAULT` and `config.json`). Without it, the same vault,
  config, state directory and retrieval settings as `brainatlas mcp` are used.
- `--json` prints the parsed tool value, deep-equal to what the MCP server returns for the same tool and arguments.
  Without it, text output is printed: search hits with snippets, page or index content, one path per line for `list`,
  and pretty JSON for `status` and `lint`.
- Argument problems (missing or unknown subcommand, missing text or path, extra positional words, unknown option or a
  non-integer `--limit`/`--max-chars`) fail with `E_ARGUMENT` before a tool is called. A tool error fails with the
  tool's own `E_` code and message.
- Each call starts a new Node process, loads the vault and exits by itself after the command.
