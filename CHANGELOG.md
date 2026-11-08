# Changelog

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
