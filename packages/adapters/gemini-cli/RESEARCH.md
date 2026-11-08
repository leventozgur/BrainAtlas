# Gemini CLI adapter research

PM research notes dated 2026-11-08. The worker had no network access; the following references were supplied by PM and were not independently verified here.

## PM-supplied behavior; verification status

- Global MCP config is `~/.gemini/settings.json`, entry `mcpServers.brainatlas` with `command` and `args`. **Supplied by PM; not independently verified by worker.**
- Project scope uses `<project>/.gemini/settings.json`. **Supplied by PM; not independently verified by worker.**
- Instructions use `~/.gemini/GEMINI.md` globally or `<project>/GEMINI.md` in project scope. **Supplied by PM; not independently verified by worker.**
- Gemini CLI has no prompt hook in adapter version 0.1. The adapter therefore uses pull mode through the MCP tool and managed instructions. **Supplied by PM; not independently verified by worker.**
- Trust step: start a new Gemini CLI session. **Supplied by PM; not independently verified by worker.**

PM notes did not include Gemini CLI source URLs, so official references remain unverified and should be added by PM.


## PM verification (2026-11-08, official docs via web)
Source: https://geminicli.com/docs/reference/configuration
- User settings `~/.gemini/settings.json`; project `.gemini/settings.json`. Top-level `mcpServers.<name>` with stdio fields `command`, `args`, `env`, `cwd` (+ `trust`, `description`, `includeTools`, `excludeTools`). Server aliases should avoid underscores (`brainatlas` is fine).
- Context file name configurable via `context.fileName` (example `GEMINI.md`); the global `~/.gemini/GEMINI.md` location is consistent with the user root but was not explicitly confirmed on the fetched page — **unverified**.
- Gemini CLI now has hooks (`BeforeAgent`, `SessionStart`, `BeforeModel`, …) under a `hooks` object; v0.1 deliberately stays in pull mode (D-12/PLAN §6). Hook support = follow-up.
- Note from the docs: Gemini CLI was replaced by Antigravity CLI on 2026-06-18 for unpaid/Google One tiers — users should confirm which CLI they run.
