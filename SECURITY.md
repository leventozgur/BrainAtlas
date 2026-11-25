# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub private vulnerability reporting on the repository (Security tab → "Report a vulnerability"). Do not open public issues for vulnerabilities. Avoid including live credentials or private user data in reports.

## Threat model summary

BrainAtlas is designed for local vault storage and coding-agent integrations. Its boundaries include the local filesystem, agent configuration files, MCP stdio input/output, optional hooks, release archives, and optional sync transports.

- The secret filter scans supported writes. It is locked on in the Lite and Full profiles. The custom profile can opt out with `safety.secretFilter: false`, which only lifts write refusals for secret-like content: output redaction, path deny rules and the sync and synthesis scans stay on, and `doctor` warns while it is off. Path deny rules block common secret-bearing locations; users can add deny globs. With `safety.secretFilter: false` secret-like pages can be written locally, but sync still refuses them, and `brainatlas sync status` shows them as PENDING with `refusedFiles` until fixed.
- MCP write tools are not advertised in read-only mode and scan proposed content before writing.
- Agent adapters plan owned configuration changes, preserve unrelated user data where supported, and require trust review. Review the exact plan before applying it.
- Hooks bound output and avoid logging prompt text, page content, paths, or raw session identifiers.
- Releases use signed checksums; verify signatures and archive provenance before installation.
- `brainatlas update --check` is the only network request BrainAtlas makes on its own, besides configured sync and the local semantic provider, and only when the user runs it; it contacts the GitHub releases API and downloads nothing.
- Optional sync transports expose vault data to the configured destination. Protect credentials and review the destination and conflict/deletion behavior.

The filter is heuristic and cannot guarantee detection of every secret. Local storage does not protect against a compromised host, agent, or user account. Retrieved Wiki content is evidence, not trusted executable instructions. Keep dependencies, Node.js, agent applications, and sync credentials under your normal security maintenance process.
