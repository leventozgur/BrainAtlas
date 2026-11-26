# Usage summary and feedback

BrainAtlas can summarize the content-free metrics that the prompt hook writes to the vault's state directory.

## Summary

```sh
brainatlas usage [--days N] [--json]
```

`N` is an integer of at least 1 and defaults to 7. The output counts prompts and outcomes, and reports
injection rate, mean results, duration p50/p95, mean characters, shadow comparison rates and feedback
counts. Missing metric files count as zero records.

After the `Prompts:` line it also prints `Events: prompt <n>, session-start <n>` and one line per client,
sorted by client name: `  <client>: prompt <n>, session-start <n>, last <ISO|never>`. The final
`Metrics:` line names the per-vault `metrics/hooks.jsonl` file that was read. The JSON form adds
`events`, `byClient` and `stateDir`; the existing keys keep their values.

## Feedback

```sh
brainatlas usage feedback useful|not-useful
```

The word is appended to `metrics/feedback.jsonl` with the same file permissions as the hook metrics.
Any other word is refused.

## Shadow mode

Shadow mode is opt-in. Set `retrieval.shadow.abstainThreshold` in the configuration to run one extra
lexical search; the hook output does not change, and the metric record only gains aggregate comparison
values. Metrics never contain prompt text, page paths, titles or the raw session id.
