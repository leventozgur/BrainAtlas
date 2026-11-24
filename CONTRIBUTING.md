# Contributing

BrainAtlas uses Node.js 20+, plain ESM JavaScript with JSDoc, `node:test`, and no build step. Native dependencies are not part of the product runtime.

## Development setup

From a clean checkout with the lockfile:

```sh
npm ci --ignore-scripts
npm test
npm run guard
npm run lint
npm run typecheck
```

Do not use `npm install` to update the lockfile as part of an unrelated change. Network access may be unavailable in the development environment; if dependencies are missing, report that rather than changing dependency policy.

## Lint

`npm run lint` runs ESLint with the flat config in `eslint.config.mjs`. ESLint is development-only: the root `devDependencies` are limited to `eslint`, `@eslint/js` and `globals`, the supply-chain guard allows exactly those dev roots, and they never enter a release archive. Fix findings in the code without changing behaviour; a narrow `// eslint-disable-next-line <rule> -- <reason>` is reserved for intentional patterns.

## Type check

`npm run typecheck` runs `tsc -p tsconfig.json` with `allowJs`/`checkJs` and `noEmit` over `packages/`, `modules/`, `scripts/` and `release/`; there is no build step and nothing is emitted. TypeScript and `@types/node` are development-only roots in the guard and never enter a release archive. Fix type errors by improving JSDoc annotations (or a precise `/** @type {X} */ (expr)` cast) without changing runtime behaviour; `// @ts-ignore` and `// @ts-nocheck` are not used.

## Formatting

`npm run format` rewrites every `*.mjs`/`*.js` file with Prettier using `.prettierrc.json` (120 columns, single quotes, semicolons, ES5 trailing commas); `npm run format:check` verifies the same formatting and runs in CI after `npm run typecheck`. Prettier is a development-only root in the guard and never enters a release archive. Formatting is a whitespace-only change: do not combine it with behaviour changes, and keep SPDX headers on the first line.

## Verify before publishing

Run `npm run release:verify -- --dir <folder>` on a built release folder before publishing.

Wall-clock latency budgets live in `tests/perf/` and run with `npm run test:perf`; they are not part of `npm test`, so run them on a quiet machine when you change a hook, retrieval or scanner timing path.

## Checking for date time-bombs

Tests that spawn a real CLI, hook or MCP process must derive their fixture timestamps from the real clock, because the child process does not receive the test's fixed `now`. Verify future safety by shifting the test clock, for example `BRAINATLAS_TEST_CLOCK_SHIFT_DAYS=60 node --import ./tests/helpers/shift-clock.mjs --test tests/acceptance/BA-01/*.test.mjs`, or run the whole suite with `BRAINATLAS_TEST_CLOCK_SHIFT_DAYS=60 NODE_OPTIONS="--import $PWD/tests/helpers/shift-clock.mjs" node scripts/run-tests.mjs`; the preload shifts `Date.now()`/`new Date()` and propagates the shift to spawned children through `NODE_OPTIONS`. The default `npm test` run does not use the preload. No date-shift artifacts remain in the suite; `tests/perf/hooks-latency.perf.test.mjs` and `tests/acceptance/Q-SLOW/slow-provider.test.mjs` are excluded from this check.

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
