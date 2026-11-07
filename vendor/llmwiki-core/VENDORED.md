# Vendored: microsoft/llmwiki `packages/core`

| | |
|---|---|
| Upstream | https://github.com/microsoft/llmwiki |
| Tag | `v1.0.1` |
| Commit | `e09126f257c1fcf8e63234382748a51cf6a5df7f` |
| Package | `@llmwiki/core` 0.1.2 (as built from the tag) |
| License | MIT (see `LICENSE`, `NOTICE`) |
| Files | 48 files under `dist/` (`*.js`, `*.d.ts`; source maps removed) |
| Tree hash | `b0643613339cde38a55c20e2e9d8418916b61234c5d3166fa329304313e3aa24` |

The tree hash is `sha256` over the sorted per-file `shasum -a 256` listing of `dist/`.

## Reproduce

```sh
git clone https://github.com/microsoft/llmwiki.git && cd llmwiki
git checkout e09126f257c1fcf8e63234382748a51cf6a5df7f   # tag v1.0.1
npm ci --ignore-scripts
npm run build --workspace=packages/core              # tsc
rsync -a --exclude='*.map' packages/core/dist/ <BrainAtlas>/vendor/llmwiki-core/dist/
cd <BrainAtlas>/vendor/llmwiki-core
find dist -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256   # must equal the tree hash above
```

## Local changes

None. `package.json` is reduced to the runtime fields (name, version, exports, dependencies) and marked private.
BrainAtlas replaces upstream search with its own BM25F retrieval at the MCP layer (D-08/D-09); the vendored files are not patched.
