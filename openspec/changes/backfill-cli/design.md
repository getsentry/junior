# Design: CLI Baseline

## Sources Reviewed

- `packages/junior/package.json`
- `packages/junior/bin/junior.mjs`
- `packages/junior/src/cli/main.ts`
- `packages/junior/src/cli/run.ts`
- `packages/junior/src/cli/env.ts`
- `packages/junior/src/cli/init.ts`
- `packages/junior/src/cli/check.ts`
- `packages/junior/src/cli/snapshot-warmup.ts`
- `packages/junior/tests/unit/cli/cli-run.test.ts`
- `packages/junior/tests/unit/cli/build-contract.test.ts`
- `packages/junior/tests/unit/cli/env.test.ts`
- `packages/junior/tests/unit/cli/init-cli.test.ts`
- `packages/junior/tests/unit/cli/check-cli.test.ts`
- `packages/junior/tests/unit/cli/snapshot-warmup-cli.test.ts`
- `packages/docs/src/content/docs/start-here/quickstart.md`
- `packages/docs/src/content/docs/start-here/deploy-to-vercel.md`
- `packages/docs/src/content/docs/start-here/existing-app.md`

External primary sources reviewed:

- npm `package.json` docs for the `bin` field and executable linking.
- npm scripts docs for package binary availability in scripts.
- Node.js environment variable docs for native `.env` loading through `process.loadEnvFile`.
- Node.js `process` docs for current `loadEnvFile` behavior.
- Vite CLI docs as deployment-adjacent prior art for command usage/help conventions.

## Current Command Surface

`junior` supports three commands:

| Command                  | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `junior init <dir>`      | Scaffold a Junior app in an empty target directory.                                |
| `junior snapshot create` | Resolve or build sandbox runtime dependency snapshots for enabled plugin packages. |
| `junior check [dir]`     | Validate app-local and packaged plugin/skill/app configuration.                    |

The package binary is `packages/junior/bin/junior.mjs`. It loads built CLI modules from `dist/cli/*.js`, so build configuration must include every module the bin loader imports.

## Compatibility Model

The stable contract is:

- command names and required/optional positional arguments;
- exit code success/failure semantics;
- generated scaffold files and key package scripts;
- validation scope and error/warning classification;
- snapshot dependency input discovery and skip behavior;
- package-bin module availability.

The unstable contract is:

- colorized symbols;
- exact status tree formatting;
- incidental progress wording that is not used for automation.

Tests may assert important summary lines and error text, but specs should avoid freezing every presentational detail.

## Prior-Art Interpretation

- npm package binaries are package metadata, not runtime imports. Junior therefore needs a build-contract test proving `bin/junior.mjs` can load the built modules it names.
- `.env` loading should use Node's native loader rather than adding another dotenv parser. Junior layers app and workspace roots so `pnpm exec junior ...` works from nested app paths.
- CLI validators should distinguish errors from warnings: errors fail the command, warnings do not.
- Build-time snapshot warmup should be explicit and skippable because it can need external sandbox/network credentials.

## Undefined Behavior

- There is no `--help` or `--version` command. Invalid argv prints usage and exits 1.
- `junior check` output currently includes Unicode status symbols and color when supported; no compatibility level is documented for terminal rendering.
- `junior init` writes fixed dependency versions/ranges that may drift from docs and release policy.
- Snapshot warmup uses hard-coded runtime and timeout defaults; no CLI flags currently expose them.
- The CLI has no structured JSON output for automation.

## Verification Strategy

- Unit tests own command dispatch, env loading, scaffolding, validation, snapshot warmup, and build-entry contracts.
- Docs-site checks should cover public tutorials that document command usage.
- Release packaging should ensure the `bin` file and built `dist/cli` modules are included in packed artifacts.
