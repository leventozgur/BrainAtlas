# Claude Code adapter research

Research supplied by PM on 2026-11-08, based on official documentation and existing port evidence. The worker did not independently verify these pages because network access is unavailable.

## Current configuration notes (PM-supplied; not independently verified)

- MCP user scope: `~/.claude.json`, key `mcpServers.brainatlas`, entry `{type:"stdio", command, args, env}`. This file may contain user state and must be preserved.
- Hooks: `~/.claude/settings.json`, under `hooks.UserPromptSubmit` and `hooks.SessionStart`, arrays of groups shaped like `{matcher?:"", hooks:[{type:"command", command:"…", timeout:5}]}`. Hook stdin is JSON containing `session_id`, `prompt`, `cwd`, and `hook_event_name`; context output uses `hookSpecificOutput` with `additionalContext`.
- Instructions: `~/.claude/CLAUDE.md`, managed block markers `<!-- brainatlas:begin -->` and `<!-- brainatlas:end -->`; use the pull-mode instructions plus MCP.
- Vault scope: `<project>/.mcp.json`, `<project>/.claude/settings.json`, and `<project>/CLAUDE.md`.
- Trust review: start a new Claude Code session and approve the BrainAtlas MCP server if prompted.

## Sources

- Claude Code MCP configuration: https://docs.anthropic.com/en/docs/claude-code/mcp
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
- Claude Code memory and instructions: https://docs.anthropic.com/en/docs/claude-code/memory

URLs and configuration details above were included in the PM research brief. The URLs have not been checked by this worker.
