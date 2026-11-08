# AUDIT findings

Final privacy, secret, dependency license, notice, and security review. Scope is documentation only; product code is unchanged.

## Severity summary

| Severity | Findings |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 4 |
| Low | 1 |

## Medium

1. **Third-party notice has unresolved attribution and stale npm inventory wording.** `THIRD_PARTY_NOTICES:5-6` — confirm the source URL/copyright line and update the notice to point to the completed [dependency inventory](./dependencies.md) and release attribution handling.
2. **Plan output is not uniformly redacted.** `packages/cli/src/index.mjs:310-322,596,601,625,672,723` — init adapter `before`/`after` text is redacted, but other plan forms may expose absolute paths or journal fields. Redact user-specific paths and secret-bearing journal data before serializing every `--plan` response.
3. **Update metadata uses global fetch directly.** `packages/cli/src/index.mjs:642-655` — offline mode blocks this request, but it is not fetch-injected like Dropbox/Ollama. Inject the fetch implementation for consistent isolation and deterministic coverage.
4. **Several writes bypass atomic-write helpers.** `packages/core/src/retrieval/index.mjs:128-131`; `modules/sync-git/src/index.mjs:214-216`; `modules/sync-folder/src/index.mjs:171-184`; `packages/core/src/vault/index.mjs:86-97`; `release/build-release.mjs:108-112` — path safety/scoped checks exist in these paths, but an interruption can leave a partial cache, object, append, archive, or checksum. Use atomic replacement where partial files would be harmful; retain append/exclusive-create semantics where intentional. Full list is in [security-checklist.md](./security-checklist.md).

## Low

1. **Upstream contributor email metadata is present in vendored NOTICE.** `vendor/llmwiki-core/NOTICE:197-198,229-230,2556,2647` (all matched lines listed in [privacy.md](./privacy.md)) — these are upstream attribution contacts rather than repository user configuration. Preserve required attribution; review only if distribution policy excludes contact metadata.

## Clean checks

- Dependency licenses: all external packages are MIT, ISC, BSD-2-Clause, or BSD-3-Clause; no install scripts marked in the lockfile.
- Vendored `@llmwiki/core`: LICENSE and NOTICE exist; the 48-file `dist/` tree hash matches `VENDORED.md`.
- Privacy scan: no user-specific absolute paths, non-exempt IPs, or non-fixture private-key blocks found. Candidate emails and safety-rule matches (including synthetic fixture keys) are reported by location/class only.
- `npm run guard`: PASS. `npm test`: PASS (524 passed, 16 skipped, 0 failed).
