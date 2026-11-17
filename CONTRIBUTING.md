# Contributing

BrainAtlas uses Node.js 20+, plain ESM JavaScript with JSDoc, `node:test`, and no build step. Native dependencies are not part of the product runtime.

## Development setup

From a clean checkout with the lockfile:

```sh
npm ci --ignore-scripts
npm test
npm run guard
npm run lint
```

Do not use `npm install` to update the lockfile as part of an unrelated change. Network access may be unavailable in the development environment; if dependencies are missing, report that rather than changing dependency policy.

## Lint

`npm run lint` runs ESLint with the flat config in `eslint.config.mjs`. ESLint is development-only: the root `devDependencies` are limited to `eslint`, `@eslint/js` and `globals`, the supply-chain guard allows exactly those dev roots, and they never enter a release archive. Fix findings in the code without changing behaviour; a narrow `// eslint-disable-next-line <rule> -- <reason>` is reserved for intentional patterns.

## Verify before publishing

Run `npm run release:verify -- --dir <folder>` on a built release folder before publishing.

Wall-clock latency budgets live in `tests/perf/` and run with `npm run test:perf`; they are not part of `npm test`, so run them on a quiet machine when you change a hook, retrieval or scanner timing path.

## Change guidelines

- Treat `docs/contracts/*.md` as API contracts. Do not change a signature or contract without an explicit proposal and review.
- Keep tests isolated: inject `env.HOME` and `XDG_*`, use temporary directories, clean them up, and do not read or write the real home directory.
- Tests must not require network access or listening sockets; use fakes for external services.
- Never put secret values, prompt text, or page content in logs, metrics, or error messages.
- Use Node 20-compatible APIs and `node:test` with `node:assert/strict`.
- Replace `E_NOT_IMPLEMENTED` stub expectations with behavior tests when implementing a module.
- Run `npm test` and `npm run guard` before submitting. Do not commit generated personal data or credentials.

## Pull requests

Explain the behavior change, affected contracts/modules, and test results. Include migration and security implications when applicable. Keep changes focused and do not include unrelated lockfile updates.
