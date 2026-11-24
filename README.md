# BrainAtlas

**Evidence-first memory for coding agents.** BrainAtlas keeps project knowledge in a local Markdown Wiki, retrieves relevant evidence through MCP and supported hooks, and lets agents work from cited context.

## What it is

- A local knowledge vault with pages, an index, a log, and optional metadata checks.
- An MCP server with bounded read and retrieval tools, status and lint, and controlled writes when read-only mode is off.
- Agent adapters that preview and manage only their owned configuration, with trust review steps.

BrainAtlas is designed for coding agents, but the vault does not restrict content type: non-project notes work too.

BrainAtlas is not a hosted knowledge service, a general-purpose agent, or a guarantee that an agent follows retrieved evidence. It does not send telemetry. The secret filter is on by default and locked in the Lite and Full profiles; only the custom profile can opt out of its write refusals. Core configuration sets telemetry to false. See [Security](SECURITY.md).

## Profiles

| Profile | Contents | Notes |
|---|---|---|
| Lite | Core only; no optional modules | Secret filtering enabled; telemetry off. Recommended starting profile. |
| Full | Core plus modules marked for Full in the selected release | Optional modules include sync, semantic retrieval, receipts, and strict OKF-inspired checks. Availability depends on release contents. |

Semantic retrieval is experimental, opt-in, uses local Ollama, and is off by default; on the independent semantic holdout v2 (`wiki_query`, EmbeddingGemma), TR→EN rose from 0/10 to 8/10 and EN→TR from 2/10 to 8/10, while difficult near-topic negatives were not improved (2/10 abstained before and after). See [Retrieval](docs/user/retrieval.md) and [Semantic retrieval](docs/user/semantic.md) for details. Folder sync is experimental. Review module status before enabling optional functionality.

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

Settings live in the BrainAtlas configuration file (`~/Library/Application Support/BrainAtlas/config.json` on macOS; other paths are in the [config contract](docs/contracts/config.md)). Read and change them with `brainatlas config get [KEY]`, `brainatlas config set KEY VALUE [--plan]` and `brainatlas config unset KEY [--plan]`; `--plan` previews the change without writing it.

| Feature | Default | Turn on / off | Details |
|---|---|---|---|
| Prompt hook injection | on (`hooks.mode normal`) | `brainatlas config set hooks.mode economic` injects only for question-like prompts or `/sb`, `@sb`; `manual` injects only for `/sb` or `@sb` and also turns off the session-start recap; `normal` restores it | [Agent setup](docs/user/agents.md) |
| Progressive disclosure | off (`hooks.disclosure` absent = `full`) | `brainatlas config set hooks.disclosure progressive`; `brainatlas config unset hooks.disclosure` restores `full` | [Retrieval](docs/user/retrieval.md) |
| Semantic retrieval (Full, experimental) | off | `brainatlas config set semantic.enabled true` / `false`; needs local Ollama | [Semantic retrieval](docs/user/semantic.md) |
| Search scope | `wiki/` when present; root navigation pages excluded | `brainatlas config set retrieval.exclude '["drafts/**"]'`; `[]` excludes nothing; `brainatlas config unset retrieval.exclude` restores the default | [Retrieval](docs/user/retrieval.md) |
| MCP write tools | on | `brainatlas config set readOnly true` leaves only the read tools; `false` restores writes | [Contracts](docs/contracts/) |
| Shell instead of MCP and hooks | off (default channel is MCP) | `brainatlas init --channel cli` or per agent `--channel claude-code=cli,kiro=mcp`; to change the channel of an installed agent later use `brainatlas agent set <agent> --channel mcp\|cli` | [CLI channel](docs/user/cli-channel.md) |
| Add, remove or switch one agent | per `init --agents` | `brainatlas agent list` (shows detected agents); `brainatlas agent add <agent> [--channel mcp\|cli] [--plan]`; `brainatlas agent remove <agent> [--plan]` | [Agent setup](docs/user/agents.md) |
| Folder or Git sync (Full, experimental) | off | Configured with `sync.transport`; see the guide before enabling | [Sync](docs/user/sync.md) |
| Telemetry and secret filter | off / on, locked | Cannot be changed (`E_LOCKED_KEY`); the custom profile may set `safety.secretFilter` to `false` | [Security](SECURITY.md) |

To stop BrainAtlas completely, run `brainatlas uninstall` (the vault is kept).

### Commands

| Command | Purpose | Writes? |
|---|---|---|
| `brainatlas wiki query\|read\|index\|list\|status\|lint` | Read-only Wiki tools from the shell; same results as the MCP read tools | no |
| `brainatlas maintain [--repo DIR]` | Report stale, broken, orphan and oversized pages | no (unless `--queue`) |
| `brainatlas compact --page wiki/<page>.md --plan\|--apply` | Move older dated sections of a long page into `wiki/archive/` without losing lines | `--apply` only |
| `brainatlas usage [--days N]` | Summarize content-free hook metrics | no |
| `brainatlas ui [--no-open] [--json]` | Experimental local panel for status, agent channels and settings (127.0.0.1 only) | panel apply only |
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

Vault and state are local. BrainAtlas has no telemetry. The secret filter scans content before supported writes; it is locked on in Lite and Full. In the custom profile `brainatlas config set safety.secretFilter false` stops refusing writes with secret-like content, while output redaction, path deny rules and sync scans stay on. Default path-deny rules also block sensitive locations and files. Hooks return bounded context and their metrics omit prompt text, page content, paths, and raw session identifiers. Optional sync transports move vault data only when configured; understand the selected transport and credentials before enabling it.

See [Security](SECURITY.md), [Sync](docs/user/sync.md), and the [contracts](docs/contracts/).

## Comparison and related work

BrainAtlas does not publish feature comparisons with other tools because their features change and were not independently verified.

- The LLM Wiki pattern popularised by Andrej Karpathy: the idea of an LLM-maintained Wiki or note collection, with no code from that work used here.
- Microsoft llmwiki core (vendored in this repository, MIT; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)).
- avenoxbeyin (https://github.com/avenoxai/avenoxbeyin): design patterns only (BM25 `k1=1.5` and `b=0.75`, vault-id hash pattern, release and installation patterns), MIT, no code copied; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

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
