# BrainAtlas

**Evidence-first memory for coding agents.** BrainAtlas keeps project knowledge in a local Markdown Wiki, retrieves relevant evidence through MCP and supported hooks, and lets agents work from cited context.

## What it is

- A local knowledge vault with pages, an index, a log, and optional metadata checks.
- An MCP server with bounded read and retrieval tools, status and lint, and controlled writes when read-only mode is off.
- Agent adapters that preview and manage only their owned configuration, with trust review steps.

BrainAtlas is not a hosted knowledge service, a general-purpose agent, or a guarantee that an agent follows retrieved evidence. It does not send telemetry. The secret filter is always enabled and cannot be disabled. Core configuration sets telemetry to false. See [Security](SECURITY.md).

## Profiles

| Profile | Contents | Notes |
|---|---|---|
| Lite | Core only; no optional modules | Secret filtering enabled; telemetry off. Recommended starting profile. |
| Full | Core plus modules marked for Full in the selected release | Optional modules include sync, semantic retrieval, receipts, and strict OKF-inspired checks. Availability depends on release contents. |

Semantic retrieval is experimental, opt-in, uses local Ollama, and is off by default; a measured difference was observed in cross-language retrieval. See [Retrieval](docs/user/retrieval.md) and [Semantic retrieval](docs/user/semantic.md) for details. Folder sync is experimental. Review module status before enabling optional functionality.

## Supported agents

| Agent | Integration mode in this repository | Trust review |
|---|---|---|
| Claude Code | MCP, prompt and session-start hooks, managed `CLAUDE.md` pointer | Review the planned MCP, hook, and instruction edits. |
| GitHub Copilot in VS Code | MCP, session-start hook, managed instructions | Per-prompt hooks are unsupported by Copilot; context uses session-start plus pull-mode MCP. Global instructions path is unverified. |
| Kiro | MCP, steering file, prompt hook | Prompt trigger name and compatibility are unverified; review before relying on it. |
| Codex CLI | MCP and managed instruction pointer; hook support is adapter-dependent | Review the resulting MCP and instruction configuration. |
| Gemini CLI | MCP, managed instruction pointer, `BeforeAgent` and `SessionStart` hooks | Enable the hook entries in Gemini's `/hooks` panel if required. |

Adapters can create or modify agent configuration. Inspect the plan and trust review, then confirm the agent loads the MCP server and instructions. See [Agent setup](docs/user/agents.md).

## Quickstart

### Online

Releases are published on GitHub Releases: https://github.com/leventozgur/BrainAtlas/releases. Each release attaches the complete distribution folder (Lite and Full archives, `install.sh`, `release/`, `SHA256SUMS`, `SHA256SUMS.sig`). Download every file of one release into an empty folder and continue with the offline steps below. The maintainer signing key fingerprint is `SHA256:PPcml0QiRHQJrtPnqWMXF77PgJhPT27GOHboOMJCw40`; compare it with `release/allowed_signers` before installing. Node.js 20 or newer and `ssh-keygen` are required.

### Offline

Obtain the complete Lite distribution folder from a trusted source. It includes the archive, signed checksum files and allowed-signers file. The archive filename below is a placeholder; substitute the actual release version.

```sh
sh install.sh --from brainatlas-<v>-lite.tgz --allowed-signers release/allowed_signers --yes
brainatlas init --profile lite --agents claude-code,copilot-vscode,kiro
brainatlas doctor
```

Review any agent trust prompts and verify integration in each agent. See [Installation](docs/user/install.md) for signature and verification details.

## Update, rollback, and uninstall

Install an update from a verified release archive with `brainatlas update --from <archive>`. The CLI checks release health and restores the prior release if the new one fails its health check. Use `brainatlas rollback` to return to the prior release. Run `brainatlas uninstall` to remove BrainAtlas-managed installation and adapter changes; the configured vault is preserved. Review `--plan` output where supported before applying changes.

## Privacy and security model

Vault and state are local. BrainAtlas has no telemetry. The secret filter scans content before supported writes; it is always on and cannot be disabled. Default path-deny rules also block sensitive locations and files. Hooks return bounded context and their metrics omit prompt text, page content, paths, and raw session identifiers. Optional sync transports move vault data only when configured; understand the selected transport and credentials before enabling it.

See [Security](SECURITY.md), [Sync](docs/user/sync.md), and the [contracts](docs/contracts/).

## Comparison (as of 2026-11)

This is a high-level comparison of project types, not a feature benchmark. Verify current product details and upstream documentation before publishing or making a tool choice.

| Project/type | General approach | BrainAtlas distinction |
|---|---|---|
| claude-mem | Persistent memory/context for Claude Code | BrainAtlas is designed for multiple coding agents, a local Markdown evidence vault, and MCP-based retrieval. **Verify current feature details before publishing.** |
| basic-memory | Markdown-based knowledge management with agent integrations | BrainAtlas focuses on coding-agent evidence retrieval, controlled writes, privacy filters, and agent adapters. **Verify current feature details before publishing.** |
| Karpathy-style LLM wiki setups | LLM-maintained Wiki or notes, often built from scripts and prompts | BrainAtlas packages a structured local Wiki, retrieval interfaces, safety checks, and release/update tooling. Implementations vary; verify before publishing. |
| avenoxbeyin | Reference project named in the development brief | Public identity and capabilities are not verifiable from this offline repository. **Verify before publishing; no comparative claims made.** |

## User guides

- [Install and verify releases](docs/user/install.md)
- [Agent integrations and trust review](docs/user/agents.md)
- [Retrieval behavior and measured quality](docs/user/retrieval.md)
- [OKF-inspired metadata](docs/user/okf.md)
- [Sync behavior](docs/user/sync.md)
- [Troubleshooting](docs/user/troubleshooting.md)
- [Demo recording script](docs/user/demo-gif-script.md)
