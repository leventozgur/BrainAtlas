# Agent integrations

`brainatlas init --agents <comma-separated-ids>` plans and applies adapter changes. Adapters preserve unrelated user configuration where supported, back up modified files, and expose trust review steps. Use `brainatlas init --plan --profile lite --agents <ids>` to inspect the proposed files before applying. Review every file and trust prompt, then restart or reload the agent and confirm that its MCP server starts.

| Agent | Files managed by this repository | Mode and caveats |
|---|---|---|
| Claude Code | `.claude.json` or `.mcp.json` (scope dependent), `.claude/settings.json`, `CLAUDE.md`, `.claude/skills/brainatlas/SKILL.md` (cli channel) | MCP, `UserPromptSubmit` and `SessionStart` hooks, managed instruction block; the cli channel writes a managed skill with retrieval and capture steps. |
| GitHub Copilot in VS Code | MCP config, hook JSON, instructions Markdown | Session-start hook and pull-mode MCP; per-prompt hooks are unsupported by Copilot. Global instructions path is unverified. Workspace hooks may require workspace trust. |
| Kiro | `.kiro/settings/mcp.json`, `.kiro/steering/brainatlas.md`, `.kiro/hooks/brainatlas.json` | MCP, steering instructions, prompt hook (`UserPromptSubmit`). |
| Codex CLI | Agent MCP and instruction configuration | MCP and pull-mode instruction pointer. Confirm the exact behavior in the installed Codex CLI. |
| Gemini CLI | `~/.gemini/settings.json` | MCP and managed instructions plus `BeforeAgent` (`brainatlas-context`) and `SessionStart` (`brainatlas-session`) hooks. Enable them from Gemini CLI's `/hooks` panel if needed. |

At session start, the hook provides a short recap: the `handoff.md` card if one exists, otherwise a deterministic card of up to 800 characters listing recently changed wiki pages (last 14 days) and the pending review count. Set `hooks.mode` to `manual` to turn off the generated card; `handoff.md` is still used. The card is reference data, not instructions.

After a release update, BrainAtlas re-applies the configured adapters with the new release. Run the same step by hand with `brainatlas agent refresh [<agent>] [--plan] [--safe] [--force]`; `--plan` shows the changes without writing them. `brainatlas update` refreshes adapters only after the new release passes its health check, and a refresh failure is reported in `adapters` without failing or rolling back the update. Agents that would replace unmanaged content are skipped and listed under `skipped` when the refresh runs with `--safe`.

## Vault policy refresh

The vault's `AGENTS.md` and `CLAUDE.md` carry a versioned managed block:

```text
<!-- brainatlas:managed v=2 sha256=<64 hex> -->
...policy text...
<!-- /brainatlas:managed -->
```

`brainatlas agent refresh` (and therefore `brainatlas update`) refreshes this block from the current release on every device. Text outside the block is preserved byte for byte, including a `<!-- migrated:user-section -->` section. The JSON output adds `policy: { changes, warnings }` with one `create`, `update` or `none` entry per file.

- A managed block whose `sha256` matches its text is replaced when the template changed. Older released policy text without a block is upgraded to the managed block.
- An edited block, or a file without a block that is not a known released policy, is left untouched with a warning. Run `brainatlas agent refresh --force` to replace it: the old file is copied to `<file>.bak.<ISO timestamp>` first, and unmanaged text is kept below the block inside `<!-- brainatlas:previous -->` … `<!-- /brainatlas:previous -->`.
- A symlinked policy file is never followed. With `readOnly` set, the refresh is skipped and reported as `vault-policy: readOnly is set; the vault policy was not refreshed.`
- `brainatlas doctor` runs the same refresh as a plan and warns when a policy is out of date; `brainatlas maintain` lists the same warnings under `policy`. Both also report stale references in the user-owned text: a path that does not exist on this device, a `wiki_*`/`plan_*` tool that is not an MCP tool, an unknown `brainatlas <command>`, or a reference to the removed `ba.mjs` and `checkpoint.mjs`.

Exact global versus workspace locations depend on adapter scope and agent conventions. Trust-review each planned edit before relying on it. Uninstall removes only changes it can identify as managed and preserves the configured vault.

The Gemini CLI integration targets Gemini CLI. The free/Google One offering was replaced by Antigravity CLI on 2026-06-18; verify which CLI is available to your account before following these steps.
