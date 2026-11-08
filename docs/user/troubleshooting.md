# Troubleshooting

Start with:

```sh
brainatlas doctor
brainatlas status
```

`doctor` reports whether the current release and configured adapter checks pass. It does not prove that every agent version loads its configuration or permits hooks.

| Symptom | Check |
|---|---|
| `brainatlas` command not found | Confirm the install's `~/.local/bin` is on `PATH`; run the installed shim by its full path if needed. |
| Node version error | Use Node.js 20 or newer. |
| Signature verification fails | Confirm archive, checksum/signature files, and allowed-signers file are from the same trusted release. Do not bypass verification unless accepting that risk. |
| Agent does not see BrainAtlas | Review adapter files, restart/reload the agent, verify workspace trust and MCP startup, then run `brainatlas doctor`. |
| Copilot context is missing | Copilot adapter uses session-start and pull-mode MCP, not per-prompt hooks. Verify the MCP server and organization policy. Global instruction location remains unverified. |
| Kiro hook does not run | The configured prompt trigger name is unverified. Use MCP pull-mode tools and verify compatibility with the installed Kiro version. |
| Update health check fails | Installer/update should retain or restore the prior release; run `brainatlas doctor`, then `brainatlas rollback` if needed. |
| Sync reports conflicts or pending deletes | Inspect conflict copies and pending-delete status; explicitly review and approve deletions before they propagate. |
| A write is refused by the safety filter | Review the page for secret-like content and sensitive paths. The filter cannot be disabled. Error output does not reveal matched values. |
