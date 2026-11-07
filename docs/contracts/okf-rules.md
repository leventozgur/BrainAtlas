# BrainAtlas local OKF warning profile

This is a local, warning-oriented metadata profile. It does not claim conformance to an external OKF standard. `checkPage(page, {asOf})` and `checkVault(vaultDir, {asOf, level, changed})` return stable findings shaped as `{path, rule, severity, message}`. Finding messages never include page body text.

| Rule | Severity | Meaning |
|---|---|---|
| `required.<field>` | warn | One of `generated`, `status`, `sources`, `verified`, or `stale_after` is absent. |
| `frontmatter.invalid` | error | Frontmatter could not be parsed. |
| `type.invalid`, `status.invalid`, `generated.invalid`, `sources.invalid`, `verified.invalid`, `stale_after.invalid` | error | A field does not match the local profile type/value rules. |
| `generated.future` | error | `generated` is later than the check's as-of date. |
| `confirmed.unverified` | warn | A confirmed page has no verification record. |
| `stale.expired` | warn | `stale_after` has passed, based on the latest verified date or `generated`. |
| `superseded.target-required` | warn | A superseded page has no valid `wiki/*.md` target. |
| `superseded.target-unexpected` | warn | A non-superseded page sets `superseded_by`. |
| `superseded.target-missing` | warn | Full vault scan cannot find the successor page. |
| `recommended.aliases`, `recommended.keywords` | warn | Entity/concept page omits one of these recommended lists. |
| `date.unquoted.generated`, `date.unquoted.stale_after`, `date.unquoted.verified` | warn | A date-only scalar is unquoted and may be coerced by another YAML reader. |
| `page.unreadable` | error | A requested page could not be read. |

`generated` and `verified[].date` accept UTC date or UTC timestamp strings. `stale_after` accepts a date, timestamp, or positive `P<n>D` / `P<n>W` duration. Supersession target existence is checked only during a full scan. The `level` option is reserved for callers; this profile always reports warning findings and does not silently promote them.
