# Kiro adapter research

Research notes supplied by PM on 2026-11-08 from official Kiro documentation. The worker had no network access and did not independently verify these pages.

Sources:

- https://kiro.dev/docs/hooks/
- https://kiro.dev/docs/hooks/types/
- https://kiro.dev/docs/hooks/actions/
- https://kiro.dev/docs/mcp/configuration/
- https://kiro.dev/docs/steering/

## Configuration

- MCP user configuration: `~/.kiro/settings/mcp.json`; workspace configuration: `.kiro/settings/mcp.json`. Both use top-level `mcpServers` entries with `command`, `args`, `env`, `disabled`, `autoApprove`, and `disabledTools`. Workspace settings override global settings by server name.
- Steering files are Markdown in `~/.kiro/steering/` globally and `.kiro/steering/` in a workspace. YAML frontmatter supports `inclusion: always|fileMatch|manual|auto`; `auto` also needs `name` and `description`. `AGENTS.md` in global steering is always included.
- Hook files use `.kiro/hooks/*.json` for workspace hooks. Kiro CLI V3 also supports global `~/.kiro/hooks/*.json`. The schema is `{ "version":"v1", "hooks":[{ "name", "description?", "trigger", "matcher?", "action":{"type":"command","command":"…"}, "timeout?", "enabled?" }] }`; default timeout is 60 seconds.
- Hook triggers include Prompt Submit, Session Start (`SessionStart`, compatibility `AgentSpawn`/`agentSpawn`), Agent Stop, Session End (`SessionEnd`), and Pre/Post Tool Use.
- The exact serialized trigger for Prompt Submit was not shown in the supplied research. The adapter uses `PromptSubmit` as an **unverified configurable constant**; confirm it in the Kiro hooks panel.
- Command actions add stdout to context on exit 0. A nonzero exit sends stderr as an error, and a nonzero Prompt Submit action blocks the prompt. The BrainAtlas hook must therefore fail open and always exit 0. Prompt content is available from `USER_PROMPT`; stdin JSON fields were not documented. The hook reads `USER_PROMPT` first and falls back to stdin `prompt`; output is plain text.

## Adapter behavior

- MCP registers `mcpServers.brainatlas`, with `command` set to `ctx.nodePath`, args `[ctx.shimPath, "mcp"]`, and only read tools in `autoApprove`.
- Steering is `brainatlas.md` with `inclusion: always`.
- Global hook target is `~/.kiro/hooks/brainatlas.json` (global hooks are documented for Kiro CLI V3); vault hook target is `.kiro/hooks/brainatlas.json`.
- The hook command invokes the configured Node executable and current shim with `hook kiro prompt`. It does not embed a release path.
- Trust review asks the user to approve the MCP server and open the Kiro hooks panel to confirm or enable the hook.

The exact Prompt Submit trigger and IDE support for global hooks remain unverified and should be checked against the installed Kiro version.
