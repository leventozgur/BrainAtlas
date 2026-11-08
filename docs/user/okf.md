# OKF-inspired metadata

BrainAtlas includes a local metadata profile **inspired by OKF v0.2**. It does not claim conformance to an external OKF standard. In Lite, core lint reports findings; the optional `okf-strict` module is available in Full/Custom releases and adds strict validation gates.

The local page profile recognizes these frontmatter fields:

| Field | Meaning and accepted form |
|---|---|
| `type` | Page type used by the local Wiki. |
| `generated` | UTC date or timestamp string. |
| `status` | Local assertion status; a confirmed page should have verification evidence. |
| `sources` | List of source references. |
| `verified` | Verification records with UTC `date`, evidence, scope, and a source listed in `sources`. |
| `stale_after` | UTC date/timestamp or positive `P<n>D` / `P<n>W` duration. |
| `superseded_by` | Successor `wiki/*.md` path when `status` is superseded. |
| `aliases`, `keywords` | Recommended lists for entity and concept pages. |

Example shape (supply real evidence for actual knowledge):

```yaml
---
type: concept
generated: "2026-01-15"
status: draft
sources: []
verified: []
stale_after: P90D
aliases: []
keywords: []
---
```

Missing recommended fields produce warnings. Invalid frontmatter or field types produce errors. Expired pages and confirmed-but-unverified claims produce warnings. Date-only scalars should be quoted to avoid YAML reader differences. See [the local rules](../contracts/okf-rules.md) and [field mapping](../../modules/okf-strict/docs/okf-mapping.md).
