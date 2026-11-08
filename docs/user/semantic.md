# Semantic retrieval

Semantic retrieval is off by default and is available with the Full or Custom profile when the semantic module is installed. Install Ollama locally, run `ollama pull embeddinggemma:300m-qat-q4_0`, then set `semantic.enabled` to `true` using `brainatlas config set semantic.enabled true`. Build the index with `brainatlas semanticIndex`; inspect it with `brainatlas semanticStatus`.

The default provider accepts only loopback addresses. Setting `semantic.allowRemote` to `true` permits remote providers and sends query and page text to them. The index resides under the configured state directory at `semantic/index.json`, outside the vault. Set `semantic.enabled` to `false` to return to BM25 retrieval.

Measured on the evaluation corpus: approximately 239 MB model storage, 385 MB RAM, 5 seconds to index 60 pages, and 16 ms per query. Results vary by machine. Related but incorrect answers can score above the threshold; the threshold alone does not distinguish difficult negatives. The default `minScore` of 0.45 is calibrated for EmbeddingGemma and must be recalibrated when changing models.
