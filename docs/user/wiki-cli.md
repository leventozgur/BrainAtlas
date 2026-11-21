# Read-only Wiki tools from the shell (`brainatlas wiki`)

`brainatlas wiki` runs the same read-only Wiki tools as the MCP server, in process, so a machine that can run shell
commands but cannot register an MCP server or hooks can still query and read a vault. The command calls the existing MCP
tool handlers; search, page reading, status and lint logic are not duplicated.

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

- The command is read-only. No write tool is reachable from it, and it writes no config, state or log itself; the
  search index cache may be written by the existing searcher exactly as the MCP server does.
- `--vault PATH` overrides the configured vault (`BRAINATLAS_VAULT` and `config.json`). Without it, the same vault,
  config, state directory and retrieval settings as `brainatlas mcp` are used.
- `--json` prints the parsed tool value, deep-equal to what the MCP server returns for the same tool and arguments.
  Without it, text output is printed: search hits with snippets, page or index content, one path per line for `list`,
  and pretty JSON for `status` and `lint`.
- Argument problems (missing or unknown subcommand, missing text or path, extra positional words, unknown option or a
  non-integer `--limit`/`--max-chars`) fail with `E_ARGUMENT` before a tool is called. A tool error fails with the
  tool's own `E_` code and message.
- Each call starts a new Node process, loads the vault and exits by itself after the command.
