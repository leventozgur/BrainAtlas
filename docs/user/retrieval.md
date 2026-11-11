# Retrieval

BrainAtlas retrieves evidence from Markdown pages with BM25F, a field-aware ranking method. Text normalization folds Turkish and English case and diacritics and applies lightweight stemming. Results account for freshness and superseded status. When evidence is too weak, retrieval abstains.

Each result includes its page path, title, score, snippet, freshness (`stale`), and status. When a section matches, it also includes `heading`, `anchor`, and `headingPath`; the snippet starts with the matching heading line and includes that section's text. If no section matches, these heading fields are null and the snippet starts at the page body. Anchors use GitHub-style kebab case, with numeric suffixes for duplicates.

When a page has dated sections (for example `## Update 2026-03-04 — ...`) or a `Current state` section, the snippet prefers the section that is current: a `Current state` or `Güncel durum` heading first, then the newest date that is not in the future. Only sections that match the question about as well as the best one are considered, so an unrelated newer section is not shown. Ranking does not change; pages without dated or current headings show the same snippets as before.

When a page replaces a superseded page, its result includes `supersedes`, the list of the superseded page paths it replaces. The superseded pages themselves are not returned. The field is absent when a page replaces nothing.

## Identifiers

Identifiers such as `E_WIDGET_TIMEOUT`, `a1b2c3d`, `rc.12`, `src/lib/retry.mjs`, `--drain-timeout`, or `RouteSnapshotCache` are matched whole, so a page that contains one exactly ranks first for a query that names it. If a question is mostly about an identifier that no page contains, retrieval abstains with `reason: "identifier-not-found"` instead of returning pages that only share its fragments (for example `widget`). Common words such as `2026`, `v2`, or `follow-up` are not treated as identifiers, and neither are dates (`11.11.2025`, `2026.11.11`, `11/11/2025`, `2025-11-11`) or abbreviations such as `i.e` and `e.g`. The rules are in [the retrieval contract](../contracts/retrieval.md#identifiers-ba-03-additions-contract-version-1).

Limits: an identifier glued to a Turkish suffix without an apostrophe (for example `src/lib/retry.mjsin`) is not split from its suffix, so it is not matched. A path given with skipped segments (for example `d3/d5/deep_retry.mjs` for `d3/d4/d5/deep_retry.mjs`) is not matched either; the basename (`deep_retry.mjs`) and the consecutive suffixes are.

## Linked pages

Pages that link to each other, with `[[Page name]]` (or `[[name|label]]`, `[[name#section]]`) or a relative Markdown link to a sibling `.md` page, are connected in the index. When a question is answered by a page that is linked to another relevant page, the linked page can also appear among the results, even if the question does not use its words. Such a result is marked `via: "link"`. A result lists its direct neighbours in `related` (at most five paths) when it has any.

Links only add results around answers that were already found: an unanswered question still abstains, and a page without links gets exactly the same results as before. Links inside code blocks, external URLs and superseded pages are ignored.

## Provenance and trust

A page's frontmatter says how well it is established (`status`, and `verified` records; see [OKF-inspired metadata](okf.md)). Retrieval uses this when it ranks pages:

- A **verified** page (`status: confirmed` with at least one valid `verified` record) ranks higher among matching pages. Its result carries `trust: "verified"`.
- A **weak** page (`status: proposed` or `disputed`) ranks slightly lower. Its result carries `trust: "weak"`, and the prompt hook shows it as `Title [unverified] (path)`.
- Every other page is neutral: its score and position are unchanged, and its result has no `trust` field.

Trust changes only the order of pages that already match the question. It never decides whether an answer is given: a question with no good match still gets no answer, and a weak page still answers a question when it is the best match. A corpus whose pages have no provenance fields gets exactly the same results as before.

## Abstention threshold

The default `retrieval.abstainThreshold` is 0.35. Scores are compressed with a square root, making this default meaningful for natural-language queries. If you set a custom threshold, use the square root of its previous value to preserve equivalent strictness: for example, an old value of 0.5 maps to ≈0.71; an old value of 0.25 maps to 0.5.

## Measured retrieval quality

These measurements use synthetic data and small sample sizes; they are directional, not a broad production guarantee.  Measured by the maintainers in November 2026 with the repository evaluation tools.

| Evaluation | Before | After | Notes |
|---|---:|---:|---|
| Natural development set (n=100), recall@5 at threshold 0.35 | 0.337 | 0.747 | Square-root score scale; unanswered-query accuracy: 0.80. |
| Earlier development set, recall@5 at threshold 0.35 | 0.15 | 0.725 | Same threshold. |
| Independent semantic holdout v2, TR→EN (`wiki_query`) | 0/10 | 8/10 | EmbeddingGemma. |
| Independent semantic holdout v2, EN→TR (`wiki_query`) | 2/10 | 8/10 | EmbeddingGemma. |
| Independent semantic holdout v2, same-language synonyms (`wiki_query`) | 9/10 | 9/10 | No change. |
| Independent semantic holdout v2, difficult near-topic negatives abstained (`wiki_query`) | 2/10 | 2/10 | No improvement. |

In the measured setup, query latency p50 was ~1 ms with BM25 and ~60 ms with semantic retrieval. The model is 239 MB, the index is ~4 MB for 60 pages, and initial index setup took ~6 seconds (M1/16 GB). Linux/8 GB systems and other models were not measured.

## Measure on a checkout

Use `brainatlas eval` in an installed checkout, or run `npm run eval` from the repository root. The evaluation corpus and development sets are repository tools and are not included in releases.

## Limits

Semantic retrieval did not improve abstention on difficult near-topic negatives in this small holdout. Results are model- and machine-dependent; Linux/8 GB systems and models other than EmbeddingGemma were not measured. Turning off lightweight stemming reduced recall on the earlier development set from 1.0 to 0.675; conservative stemming showed no gain. See [Semantic retrieval](semantic.md) for setup and configuration.
