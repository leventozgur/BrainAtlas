# GitHub Copilot for VS Code adapter research

Research notes supplied by PM, 2026-11-08 (official documentation reviewed by PM; not independently verified by this worker):

- [Copilot customization hooks](https://code.visualstudio.com/docs/copilot/customization/hooks)
- [GitHub Copilot hooks configuration](https://docs.github.com/en/copilot/reference/hooks-configuration)
- [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Copilot custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

## Configuration and hooks

- Portable user MCP config: `~/.copilot/mcp-config.json`, top-level `mcpServers`; VS Code user profile `mcp.json` uses top-level `servers` and is a deprecated Local harness destination. The adapter writes the portable file by default and writes the VS Code profile file only when `config.agents.copilot.vscodeUserMcp === true`.
- User hooks: `~/.copilot/hooks/*.json`; repository hooks: `.github/hooks/*.json`. Schema uses `version: 1`, a `hooks` object, and camelCase events. This adapter owns `sessionStart` in `brainatlas.json`.
- `sessionStart` can return `additionalContext`. Output from the `userPromptSubmitted` command hook is dropped, so per-prompt retrieval uses pull mode through MCP and instructions.
- Global instructions are planned at `~/.copilot/instructions/brainatlas.instructions.md` with `applyTo: "**"`. **Unverified:** the exact global instructions path was not documented in the pages PM reviewed; confirm it with users and treat doctor output as a warning.
- Vault scope uses `.vscode/mcp.json`, `.github/hooks/brainatlas.json`, and a managed block in `.github/copilot-instructions.md`.
- An organization policy can restrict MCP and hooks. Offline doctor cannot reliably detect policy state and reports this as a warning.

## Hook behavior and trust

- `sessionStart` input is described in camelCase (`sessionId`, timestamp, `cwd`, source, optional `initialPrompt`); a VS Code/PascalCase variant is also documented.
- Exit 0 output is parsed as JSON; errors and timeouts fail open. The adapter emits only a short generic session-start hook command; per-prompt retrieval remains pull mode.
- Trust review asks the user to trust the workspace, reload the VS Code window or start a new chat session, and confirm MCP starts.

## Implementation scope

The worker had no network access; all facts above were supplied in the PM research brief and remain unverified locally. No source code, user paths, or identifiers from a port/reference tree were consulted.
