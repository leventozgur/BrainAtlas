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

## Features and how to turn them on or off

Settings live in the BrainAtlas configuration file (`~/Library/Application Support/BrainAtlas/config.json` on macOS; other paths are in the [config contract](docs/contracts/config.md)). Read and change them with `brainatlas config get [KEY]` and `brainatlas config set KEY VALUE [--plan]`; `--plan` previews the change without writing it.

| Feature | Default | Turn on / off | Details |
|---|---|---|---|
| Prompt hook injection | on (`hooks.mode normal`) | `brainatlas config set hooks.mode economic` injects only for question-like prompts or `/sb`, `@sb`; `manual` injects only for `/sb` or `@sb` and also turns off the session-start recap; `normal` restores it | [Agent setup](docs/user/agents.md) |
| Progressive disclosure | off (`hooks.disclosure` absent = `full`) | Set `"disclosure": "progressive"` under `hooks` in the config file. In this release `config set` does not accept this key yet. Remove the key to turn it off | [Retrieval](docs/user/retrieval.md) |
| Semantic retrieval (Full, experimental) | off | `brainatlas config set semantic.enabled true` / `false`; needs local Ollama | [Semantic retrieval](docs/user/semantic.md) |
| Search scope | `wiki/` when present; root navigation pages excluded | Add `"exclude": ["drafts/**"]` under `retrieval` in the config file (`config set` does not accept this key yet); `[]` excludes nothing; remove the key for the default | [Retrieval](docs/user/retrieval.md) |
| MCP write tools | on | `brainatlas config set readOnly true` leaves only the read tools; `false` restores writes | [Contracts](docs/contracts/) |
| Shell instead of MCP and hooks | off (default channel is MCP) | `brainatlas init --channel cli`; to switch an existing install run `brainatlas uninstall` first | [CLI channel](docs/user/cli-channel.md) |
| Folder or Git sync (Full, experimental) | off | Configured with `sync.transport`; see the guide before enabling | [Sync](docs/user/sync.md) |
| Telemetry and secret filter | off / on, locked | Cannot be changed (`E_LOCKED_KEY`) | [Security](SECURITY.md) |

To stop BrainAtlas completely, run `brainatlas uninstall` (the vault is kept).

### Commands

| Command | Purpose | Writes? |
|---|---|---|
| `brainatlas wiki query\|read\|index\|list\|status\|lint` | Read-only Wiki tools from the shell; same results as the MCP read tools | no |
| `brainatlas maintain [--repo DIR]` | Report stale, broken, orphan and oversized pages | no (unless `--queue`) |
| `brainatlas compact --page wiki/<page>.md --plan\|--apply` | Move older dated sections of a long page into `wiki/archive/` without losing lines | `--apply` only |
| `brainatlas usage [--days N]` | Summarize content-free hook metrics | no |
| `brainatlas doctor`, `status` | Check installation health | no |

Guides: [Wiki CLI](docs/user/wiki-cli.md), [Maintenance report](docs/user/maintain.md), [Compact](docs/user/compact.md), [Usage](docs/user/usage.md).

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
- [Maintenance report](docs/user/maintain.md)
- [Read-only Wiki CLI (`brainatlas wiki`)](docs/user/wiki-cli.md)
- [CLI channel (instructions instead of MCP and hooks)](docs/user/cli-channel.md)
- [Compact long pages](docs/user/compact.md)
- [Usage summary and feedback](docs/user/usage.md)
- [Semantic retrieval (experimental)](docs/user/semantic.md)
- [Troubleshooting](docs/user/troubleshooting.md)
- [Demo recording script](docs/user/demo-gif-script.md)
