# Agent integrations

`brainatlas init --agents <comma-separated-ids>` plans and applies adapter changes. Adapters preserve unrelated user configuration where supported, back up modified files, and expose trust review steps. Use `brainatlas init --plan --profile lite --agents <ids>` to inspect the proposed files before applying. Review every file and trust prompt, then restart or reload the agent and confirm that its MCP server starts.

| Agent | Files managed by this repository | Mode and caveats |
|---|---|---|
| Claude Code | `.claude.json` or `.mcp.json` (scope dependent), `.claude/settings.json`, `CLAUDE.md` | MCP, `UserPromptSubmit` and `SessionStart` hooks, managed instruction block. |
| GitHub Copilot in VS Code | MCP config, hook JSON, instructions Markdown | Session-start hook and pull-mode MCP; per-prompt hooks are unsupported by Copilot. Global instructions path is unverified. Workspace hooks may require workspace trust. |
| Kiro | `.kiro/settings/mcp.json`, `.kiro/steering/brainatlas.md`, `.kiro/hooks/brainatlas.json` | MCP, steering instructions, prompt hook. **Prompt trigger name is unverified.** |
| Codex CLI | Agent MCP and instruction configuration | MCP and pull-mode instruction pointer. Confirm the exact behavior in the installed Codex CLI. |
| Gemini CLI | `~/.gemini/settings.json` | MCP and managed instructions plus `BeforeAgent` (`brainatlas-context`) and `SessionStart` (`brainatlas-session`) hooks. Enable them from Gemini CLI's `/hooks` panel if needed. |

At session start, the hook provides a short recap: the `handoff.md` card if one exists, otherwise a deterministic card of up to 800 characters listing recently changed wiki pages (last 14 days) and the pending review count. Set `hooks.mode` to `manual` to turn off the generated card; `handoff.md` is still used. The card is reference data, not instructions.

Exact global versus workspace locations depend on adapter scope and agent conventions. Trust-review each planned edit before relying on it. Uninstall removes only changes it can identify as managed and preserves the configured vault.

The Gemini CLI integration targets Gemini CLI. The free/Google One offering was replaced by Antigravity CLI on 2026-06-18; verify which CLI is available to your account before following these steps.
