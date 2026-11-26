# The `cli` channel: instructions instead of MCP and hooks

On some machines an agent cannot register MCP servers or hooks: managed desktops, locked-down IDEs, or a policy that
blocks local executables. The `cli` channel installs only an instruction block that tells the agent to query the vault
with the `brainatlas wiki` commands from the shell, and to capture verified findings with `wiki write` and `wiki reindex`.

## When to use it

Use `--channel cli` when the agent can run shell commands but cannot load an MCP server or a prompt hook. Use the
default channel (no flag) when MCP and hooks work: it is richer, because context can be injected automatically.

## Install

```text
brainatlas init --yes --vault <VAULT> --agents claude-code,codex,copilot-vscode,gemini-cli,kiro --channel cli
```

`--channel mcp` selects the default channel explicitly and removes the `channel` key from the configuration. Any other
value fails with `E_ARGUMENT`. Without `--channel` the configured channel is left as it is.

Changing the channel of an existing installation is refused with `E_CHANNEL_SWITCH`
(`Run brainatlas uninstall before changing the channel.`). The same error is returned when an adapter's files still
contain a BrainAtlas MCP entry or a BrainAtlas-managed hook.

## What is written

- The configuration gains `"channel": "cli"`.
- Each selected adapter writes only its managed instruction block or file, with the CLI payload: `CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/GEMINI.md`, the Copilot instructions file, or the Kiro steering file.
- Claude Code also gets `~/.claude/skills/brainatlas/SKILL.md` (global) or `<vault>/.claude/skills/brainatlas/SKILL.md`
  (vault scope). The whole skill file is managed.
- No MCP server entry, no hook, no settings change, and no skill file for other agents.

The payload names the installed `brainatlas` launcher and the commands:
`brainatlas wiki query "<project name and topic terms>" --json`, `brainatlas wiki read <path> --json`, and the
`list` / `index` / `status` variants. Claude Code's managed skill also documents capture with
`brainatlas wiki write <path>` (page on stdin), `brainatlas wiki reindex`, and `brainatlas wiki lint`.

## What is lost

- No automatic context injection: hooks and the MCP server are what put relevant pages in front of the agent.
- The agent must decide to search, so results depend on it following the instruction block.
- Every query starts a new process and reloads the vault; there is no long-lived MCP session or warm index.
- Writes and maintenance go through the CLI, not MCP tools; the agent must ask before saving a finding.

## Switch back to the default channel

```text
brainatlas uninstall
brainatlas init --yes --vault <VAULT> --agents claude-code,codex,copilot-vscode,gemini-cli,kiro
```

`uninstall` removes the instruction files, the skill file and the `channel` key, and restores every file it changed to
its pre-install bytes.
