# Codex CLI adapter research

Research notes supplied by PM on 2026-11-08. The worker had no network access, so the current official documentation and exact URLs were not independently verified. Codex details below are marked unverified where the brief provides no source URL.

## Configuration and hook behavior

- **Unverified, carried from PM port notes:** MCP uses `~/.codex/config.toml`, table `[mcp_servers.brainatlas]` with `command`, `args`, and optional `env`.
- **Unverified, carried from PM port notes:** hooks use `~/.codex/hooks.json`, with `hooks.UserPromptSubmit` containing command hooks. Prompt context output is limited to 1400 characters.
- **Unverified, carried from PM port notes:** user instructions are in `~/.codex/AGENTS.md`; project scope uses `<project>/.codex/config.toml` and `<project>/AGENTS.md`.
- Trust review requires the user to run `/hooks` in Codex CLI and approve the hook.
- MCP command is the configured Node executable plus `[shimPath, "mcp"]`. Hook command invokes `hook codex prompt`. The release path is not written into agent configuration.

## Official references

The PM notes did not include official Codex source URLs. Network access was unavailable, so links could not be independently researched. **Official URLs and current behavior remain unverified; PM should add the sources before release.**

## Implementation constraints

- TOML is edited in place using the `# brainatlas:begin` / `# brainatlas:end` marked region; unrelated bytes are retained.
- Hook ownership is identified by a command containing the shim path and `hook codex prompt`.
- Instructions use the `<!-- brainatlas:begin -->` / `<!-- brainatlas:end -->` managed block.
- Existing file bytes are recorded to support exact restoration on remove; changed files receive a timestamped backup before apply.
