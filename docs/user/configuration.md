# Configuration

BrainAtlas keeps two kinds of settings:

- The **device config** (`config.json`) holds settings for this installation: vault path, agents, channels, hooks, semantic provider, scheduling and `readOnly`.
- The **vault standard** (`<vault>/.brainatlas/standard.json`) holds the settings that decide knowledge quality. Every device that opens the vault applies the same standard.

The vault standard is synced with the vault. `brainatlas init` writes it, and `brainatlas agent refresh` creates it when an existing vault does not have one. Refresh never overwrites an existing standard. `--plan` and `readOnly` skip the write.

## Vault standard keys

| Key | Meaning |
|---|---|
| `okf.level` | Wiki format check level: `warn` or `strict`. |
| `retrieval.budgetChars` | Maximum characters of retrieved context. |
| `retrieval.abstainThreshold` | Lowest retrieval confidence before an answer abstains. |
| `retrieval.exclude` | Vault-relative glob patterns left out of retrieval. Optional. |
| `safety.extraDenyGlobs` | Extra path deny globs for writes and sync. |

The standard also declares `standardVersion` and the minimum agent capabilities:

```json
{
  "standardVersion": 1,
  "okf": { "level": "warn" },
  "retrieval": { "budgetChars": 4000, "abstainThreshold": 0.35 },
  "safety": { "extraDenyGlobs": [] },
  "capabilities": { "minimum": { "read": true, "write": true } }
}
```

When the standard is present and valid, its values override the device config for these keys. A device config that also sets one of them keeps its value on disk, but the vault standard value is used at load time. A missing or invalid standard leaves the device values in effect. A standard written by a newer BrainAtlas is ignored until this device is updated.

## Change a setting

```sh
brainatlas config set okf.level strict
brainatlas config unset retrieval.exclude
```

For a vault standard key the command writes the standard file and prints that the key applies to every device that uses the vault. Add `--device` to keep the old behaviour and write only the device config; the vault standard still wins at load time, so this prints a warning when the values differ.

`brainatlas config get <key>` shows the effective value. With `--json` a vault standard key also reports its `source`: `standard`, `device` or `default`.

## Doctor conformance

`brainatlas doctor` reports a `conformance` block:

```json
{
  "conformance": {
    "standardVersion": 1,
    "policyVersion": 2,
    "adaptersCurrent": { "claude-code": true },
    "semantic": "off",
    "minimumMet": { "claude-code": true }
  }
}
```

`policyVersion` comes from the managed block in the vault `AGENTS.md`. `adaptersCurrent` is true when the adapter plan has no changes. `minimumMet` checks each agent's capabilities against `capabilities.minimum`; write is required only when the minimum asks for it and the device is not `readOnly`.

Conformance warnings never change `ok`. They cover a missing or invalid standard, a newer standard version, device values that the standard overrides, out-of-date adapter files and agents that miss the vault minimum.
