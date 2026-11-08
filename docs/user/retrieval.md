# Retrieval

BrainAtlas retrieves evidence from Markdown pages with BM25F, a field-aware ranking method. Text normalization folds Turkish and English case and diacritics and applies lightweight stemming. Results account for freshness and superseded status. When evidence is too weak, retrieval abstains.

Each result includes its page path, title, score, snippet, freshness (`stale`), and status. When a section matches, it also includes `heading`, `anchor`, and `headingPath`; the snippet starts with the matching heading line and includes that section's text. If no section matches, these heading fields are null and the snippet starts at the page body. Anchors use GitHub-style kebab case, with numeric suffixes for duplicates.

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
