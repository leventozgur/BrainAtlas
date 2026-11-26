# Planning from MCP or the shell

Planning content lives in `planning/`, never in the Wiki. The backlog table is `planning/backlog.md`; one free-form
Markdown file per project lives in `planning/projects/<slug>.md`. Both MCP and the CLI write this layout with the same
code, so every device and every channel produces the same files.

## MCP tools

| Tool | Arguments | Result |
|---|---|---|
| `plan_read` | `project?` (a `PRJ-NNN` id or a slug), `maxChars?` (1 to 200000, default 20000) | without a project: `{projects, warnings}` from the `## Projects` table plus a warning for every unlisted file in `planning/projects/`; with a project: `{id, file, sha256, content, truncated, tasks}`, where `file` is the row's link target (`projects/<slug>.md`) |
| `plan_update` | `op: add_project`, `add_task` or `set_status`; `expectedSha256?` | `{op, file, sha256}`, plus `id` for `add_project` and `add_task` |

`plan_update` operations:

- `add_project {slug, title, purpose, status?, priority?}` creates `planning/projects/<slug>.md` from the template and
  appends a row to `planning/backlog.md` (a missing backlog is recreated from the template). The next free `PRJ-NNN` id
  is used; `status` defaults to `idea`.
- `add_task {project, title, status?, id?}` appends `- [<status>] <TASK-ID> · <title> (<YYYY-MM-DD>)` at the end of the
  `## Tasks` section (creating it when missing). `status` defaults to `ready`; the default id continues the highest
  existing task number, or starts at `<project-id>-1`.
- `set_status {project, task?, status}` rewrites one task line, or the project's `Status:` line and the backlog row.

Project statuses are `idea`, `ready`, `in_progress`, `blocked`, `done` and `archived`; task statuses add `dropped`.
Writes stay below `planning/`, refuse symlinks and paths that resolve outside the vault, run under the vault write lock,
are secret-scanned and appended as one `plan-update` entry in `wiki/log.md`. `expectedSha256` is checked against the
project file (the backlog file for `add_project`) and a mismatch is `E_CONFLICT`. With `dryRun` every check runs and
nothing is written or logged. If a later write or the log fails, the project and backlog are restored (a new project
file is removed).

`wiki_write_page`, `wiki_create_entity` and `wiki_create_concept` still write a page whose file name contains
`backlog`, `todo`, `tasks` or `roadmap`, but return the warning `Planning content belongs in planning/; use plan_update.`

## Shell command

```text
brainatlas plan list | show <project> [--max-chars N] | new <slug> --title T --purpose P [--status S] | add <project> <title...> [--status S] [--id X] | set <project> [<task>] <status>  [--expect-sha256 H] [--dry-run] [--vault PATH] [--json]
```

Every subcommand runs the matching MCP handler in process. `list` and `show` read; `new`, `add` and `set` write and are
refused with `E_READ_ONLY` when the configured vault has `readOnly: true`. `--json` prints the tool value; text output
prints one line per project or task (or `<op>: <file>` for a write, `dry run: <op>: <file>` with `--dry-run`). Unknown
subcommands are `E_ARGUMENT`.
