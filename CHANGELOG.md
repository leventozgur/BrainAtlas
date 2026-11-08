# Changelog

## 0.1.0-rc.2 — 2026-11-08

- Added a self-contained release distribution folder and install kit (R-KIT).
- Added Git transport setup and sync operations (S-OPS), plus stable host identity configuration (S-HOSTID).
- Added Gemini CLI `BeforeAgent` and `SessionStart` hooks (A-GEMINI2).
- Hardened output redaction and health reporting (I-HARDEN).
- Added the MIT attribution for avenoxbeyin in `THIRD_PARTY_NOTICES.md`.

## 0.1.0-rc.1 — 2026-11-08 (local release candidate; signed with a development key, not published)

- Added Lite and Full release profiles with signed archive verification and install/update/rollback support.
- Added local configuration, vault paths, doctor/status checks, and managed uninstall behavior.
- Added coding-agent adapters for Claude Code, GitHub Copilot in VS Code, Kiro, Codex CLI, and Gemini CLI.
- Added MCP tools for Wiki retrieval, reading, status, lint, and controlled writes.
- Added bounded hooks, local secret filtering, path deny rules, and privacy-preserving hook metrics.
- Added OKF v0.2-inspired local metadata checks and optional strict module.
- Added optional Git and Dropbox synchronization modules; folder sync is experimental.
- Added optional semantic retrieval behind an evaluation gate; experimental and off by default.
- Added `migrate` (copy-based, source read-only), `adopt --plan` and `help`.
- Added session-end receipts with a human review queue (Full).
