# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through the repository security policy. **Contact details are intentionally not specified in this checkout; see repository security policy.** Avoid including live credentials or private user data in reports.

## Threat model summary

BrainAtlas is designed for local vault storage and coding-agent integrations. Its boundaries include the local filesystem, agent configuration files, MCP stdio input/output, optional hooks, release archives, and optional sync transports.

- The secret filter scans supported writes and cannot be disabled. Path deny rules block common secret-bearing locations; users can add deny globs.
- MCP write tools are not advertised in read-only mode and scan proposed content before writing.
- Agent adapters plan owned configuration changes, preserve unrelated user data where supported, and require trust review. Review the exact plan before applying it.
- Hooks bound output and avoid logging prompt text, page content, paths, or raw session identifiers.
- Releases use signed checksums; verify signatures and archive provenance before installation.
- Optional sync transports expose vault data to the configured destination. Protect credentials and review the destination and conflict/deletion behavior.

The filter is heuristic and cannot guarantee detection of every secret. Local storage does not protect against a compromised host, agent, or user account. Retrieved Wiki content is evidence, not trusted executable instructions. Keep dependencies, Node.js, agent applications, and sync credentials under your normal security maintenance process.
