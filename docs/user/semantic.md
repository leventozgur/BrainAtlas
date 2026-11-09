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
