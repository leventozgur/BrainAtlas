# Semantic retrieval

Semantic retrieval is experimental and off by default. It is available with the Full or Custom profile when the semantic module is installed and the vault has a `wiki` directory. Run the guided setup:

```sh
brainatlas semanticSetup
```

The command checks Ollama, asks before downloading the configured model (by default `embeddinggemma:300m-qat-q4_0`, about 240 MB), builds an index, verifies an embedding, and enables semantic retrieval only after verification. It never installs or starts Ollama: installation needs a trusted platform-specific source, and silently starting a model can strain machines with limited memory. Follow the displayed official installation or server-start instructions if needed.

Use `brainatlas semanticSetup --dry-run` to inspect the plan without changes, or `brainatlas semanticSetup --yes` to approve the model download, indexing and configuration. Without a terminal and without `--yes`, the command behaves like a dry run. Use `brainatlas semanticSetup --mode rrf` to select reciprocal rank fusion, or `--mode semantic-primary` for semantic-first retrieval; omitting the flag keeps the configured mode. Add `--json` for a machine-readable report.

The guided setup sends vault text only to a loopback provider. The default provider also accepts only loopback addresses. Explicitly setting `semantic.allowRemote` to `true` permits remote providers for other semantic operations and sends query and page text to them; guided setup still requires loopback. The index resides under the configured state directory at `semantic/index.json`, outside the vault. Inspect it with `brainatlas semanticStatus` and refresh it with `brainatlas semanticIndex`.

To disable retrieval, run `brainatlas config set semantic.enabled false`. If Ollama was started as a Homebrew service and is no longer needed, run `brew services stop ollama`.

Measured on the evaluation corpus: approximately 239 MB model storage, 385 MB RAM, 5 seconds to index 60 pages, and 16 ms per query. Results vary by machine. Related but incorrect answers can score above the threshold; the threshold alone does not distinguish difficult negatives. The default `minScore` of 0.45 is calibrated for EmbeddingGemma and must be recalibrated when changing models.


## Prompt hook

When semantic retrieval is enabled, the prompt hook also uses it. Its search adds the query embedding to the same BM25 candidates, so a Turkish question can reach an English page. The hook reads the existing index and never writes it; run `brainatlas semanticIndex` after large Wiki changes. The embedding step has a 350 ms budget inside the hook deadline. If the provider is slow or stopped, if the index is missing or was built with another model, or if the provider URL is not loopback, the hook silently returns the same results as before semantic retrieval was enabled. The hook metrics record the outcome in the `semantic` field (`used` or `fallback:<reason>`); the prompt text is never recorded. Lite never loads the semantic module.

`semantic.keepAlive` (default `"30m"`) keeps the local embedding model loaded between prompts, so a warm embedding usually fits the hook budget; without it Ollama unloads the model after five idle minutes and the next embedding can miss the budget. It accepts `"0"` or a positive count followed by `s`, `m` or `h` (for example `"1h"`); embed requests carry that value as `keep_alive`. Setting it to `"0"` sends no field and restores Ollama's own default unload behaviour. It does not change the index fingerprint, so no re-index is needed. Change it with `brainatlas config set semantic.keepAlive 1h`. With semantic retrieval enabled, session start sends one `"warm-up"` embedding for the same provider, and a prompt whose semantic step missed its deadline sends one too; at most one is sent per state directory per minute. The hook writes its output first, then waits for the warm-up for at most 2000 ms without aborting it earlier; if less than 2000 ms remain on the hook deadline the warm-up is skipped. It never reads the vault or the index, sends no prompt or page text, and its failure, timeout or delay never changes the session-start card, the prompt output or the hook metrics. Lite, semantic-off, a missing `HOME` or `BRAINATLAS_OFFLINE=1` send no request at all.

## Slow machines

On a 2012 CPU with 8 GB RAM and a hard disk, an initial index of 819 chunks took approximately 16 minutes; a query took about 0.5 seconds. Times depend on the hardware and corpus. Run the first setup while the machine is idle. If interrupted, run `brainatlas semanticSetup --yes` again to resume saved progress. `brainatlas semanticStatus` reports the number of saved chunks as `partialChunks`.

`semantic.indexTimeoutMs` defaults to 120000 milliseconds per indexing request. Increase it if an indexing request times out on a slow machine. `semantic.indexBatchSize` defaults to 32, with a range of 1–64; increase it only when the provider can handle larger requests efficiently. Indexing adjusts batch size as requests complete. Query timeout remains controlled by `semantic.timeoutMs`.
