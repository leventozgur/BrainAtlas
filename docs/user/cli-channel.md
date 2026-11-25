# The `cli` channel: instructions instead of MCP and hooks

On some machines an agent cannot register MCP servers or hooks: managed desktops, locked-down IDEs, or a policy that
blocks local executables. The `cli` channel installs only an instruction block that tells the agent to query and update
the vault with the `brainatlas wiki` commands from the shell.

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
`list` / `index` / `status` variants. For Claude Code (BA-43d), the `CLAUDE.md` block also asks the agent to save
verified, durable findings at the end of a substantial task, and the skill lists every write subcommand (`update
--append`, `update --patch`, `write`, `create-concept`, `create-entity`, `crosslinks`, `update-index`, with content on
standard input or `--file`) and what `E_CONFLICT`, `E_SECRET_DETECTED` and `E_READ_ONLY` mean. The Codex, Copilot,
Gemini CLI and Kiro texts describe only the read commands; the write commands work for them too.

A skill or `CLAUDE.md` block written by rc.12 to rc.17 (read-only text) is still recognised as BrainAtlas-managed:
`doctor` reports it as from an older version, `brainatlas init` replaces it with the current text, and `uninstall`
removes it. Run `brainatlas init` once after updating to get the write commands in the skill.

## What is lost

- No automatic context injection: hooks and the MCP server are what put relevant pages in front of the agent.
- The agent must decide to search, so results depend on it following the instruction block.
- Every query starts a new process and reloads the vault; there is no long-lived MCP session or warm index.
- Every MCP Wiki tool, read and write, is reachable through `brainatlas wiki` with the same results (BA-43d).
  Maintenance (`maintain`, `compact`) stays in the CLI, as with the default channel.

## Switch back to the default channel

```text
brainatlas uninstall
brainatlas init --yes --vault <VAULT> --agents claude-code,codex,copilot-vscode,gemini-cli,kiro
```

`uninstall` removes the instruction files, the skill file and the `channel` key, and restores every file it changed to
its pre-install bytes.
