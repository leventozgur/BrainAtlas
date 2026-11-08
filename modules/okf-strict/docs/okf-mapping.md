# OKF v0.2 inspired field mapping

This module is **inspired by OKF v0.2** concepts. It adapts a local evidence first Wiki profile and does not claim OKF v0.2 compliance.

| Local field or rule | Related OKF v0.2 concept | Local behavior |
|---|---|---|
| `generated` | Record creation or generation time | Strict mode requires a UTC timestamp (`YYYY-MM-DDTHH:mm:ss[.sss]Z`). |
| `status: confirmed` | Assertion or record status | Requires at least one `verified` record with date, evidence, scope, and a source listed in `sources`. |
| `verified[]` | Evidence and verification provenance | Each accepted record has a valid date and non-empty evidence, scope, and source fields. |
| `sources[]` | Source references | A verification record's `source` must match an entry in this list. |
| `stale_after` | Validity or review horizon | Accepts a UTC date/timestamp or positive `P<n>D` / `P<n>W` duration. |
| `status: superseded`, `superseded_by` | Supersession relation | The target must exist in the Wiki scan and must not itself be superseded. |
| `--changed` | Incremental validation scope | Restricts reported findings to the listed relative `wiki/*.md` pages. |
| `--as-of` | Time-aware validation | Uses an explicit UTC calendar date for date-sensitive checks. |

The local names and validation rules are BrainAtlas profile choices; mapping a concept does not establish normative equivalence.
