# The vault standard and `standard migrate`

A BrainAtlas vault follows one layout on every device:

- `wiki/entities`, `wiki/concepts`, `wiki/sources`, `wiki/summaries`, `wiki/queries`, `raw/`, `inbox/`
- `planning/backlog.md` and `planning/projects/<slug>.md` (planning content never lives in the Wiki)
- `AGENTS.md` with the BrainAtlas managed block (user sections stay outside it)
- `.brainatlas/standard.json`, the vault standard written from the device configuration

`brainatlas standard migrate [--plan|--apply] [--force] [--prune-backups] [--json]` brings a drifted installation and
vault to this layout. The default is `--plan`, which only lists the steps. Output carries relative paths and counts, never
file content.

## Steps

Steps run in this order and only when needed.

| Step | What it does |
|---|---|
| `skeleton` | creates missing standard directories and `planning/backlog.md` from the template |
| `standard` | creates `.brainatlas/standard.json` from the device configuration (never overwrites) |
| `policy` | runs the same refresh as `agent refresh`; `--force` only when given |
| `planning-page` | moves a Wiki page whose file name contains `backlog`, `todo`, `tasks` or `roadmap` verbatim to `planning/projects/<slug>.md` (an existing target becomes `-2`, `-3`, ...), adds a backlog row (next `PRJ-NNN`, status `idea`), removes the Wiki page, updates the index and logs one `standard-migrate` entry |
| `orphan-state` | moves state directories of a former vault path to `<stateDir>/archive/<name>-<stamp>/` (never deleted) |
| `duplicate-index` | removes the stale per-vault copy `<stateDir>/<vault id>/retrieval-index.json`; the live root `<stateDir>/retrieval-index.json` is never removed |
| `adapter-backups` | with `--prune-backups`, keeps the newest 3 `*.bak.*` backups per adapter file and deletes the rest |

Report only, listed under `warnings`: policy text that names tools, commands or paths that no longer exist (user text is
never edited) and the number of adapter backups per file without `--prune-backups`. Pages that look like secrets are not
moved.

## Apply, backups and report

`--apply` copies every vault file it is about to change to `<vault>/.brainatlas/migrations/<stamp>/<relative path>` and
writes `report.json` there with the executed steps. A failing step stops the run; earlier steps stay applied and the
error code is in the report. A second `--apply` plans nothing. A read-only configuration refuses `--apply` with
`E_READ_ONLY`. Symbolic links are never followed or moved. `doctor` suggests the command when a step would run.

## Runbook for another device

1. Update BrainAtlas on the device.
2. `brainatlas agent refresh`
3. `brainatlas standard migrate` and review the plan and warnings.
4. `brainatlas standard migrate --apply` (add `--prune-backups` to trim adapter backups).
5. `brainatlas doctor`
