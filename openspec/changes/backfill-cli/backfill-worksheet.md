# CLI Backfill Worksheet

## Canonical Spec

- New spec: `cli`

## Local Artifacts Reviewed

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

## External Sources

- npm package `bin` docs: https://docs.npmjs.com/files/package.json/
- npm scripts docs: https://docs.npmjs.com/cli/v11/using-npm/scripts/
- Node.js environment variable docs: https://nodejs.org/api/environment_variables.html
- Node.js process docs: https://nodejs.org/api/process.html
- Vite CLI docs: https://vite.dev/guide/cli/

## Current Behavior Summary

- Published package declares `bin: { "junior": "bin/junior.mjs" }`.
- Bin wrapper loads built CLI modules from `dist/cli`.
- CLI loads env files before running commands.
- Supported commands are `init <dir>`, `snapshot create`, and `check [dir]`.
- Invalid argv prints usage and returns exit code 1.
- Top-level command failures print `junior command failed: <message>` and exit 1.
- `init` refuses non-empty directories and file paths.
- `check` validates app-local plugins/skills, packaged plugin content, app files, removed config, config default keys, and version skew.
- `snapshot create` logs plugin/runtime dependency inputs, resolves a runtime snapshot, and skips when `JUNIOR_SKIP_SNAPSHOT=1`.

## Undefined Behavior

| Question                                         | Current Evidence                                              | Candidate Decision                                                 | Status |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| Should `--help` and `--version` be supported?    | No support today; invalid argv prints usage.                  | Add only if docs or users need it.                                 | open   |
| How stable is CLI text output?                   | Tests assert some lines exactly.                              | Stabilize command/summary/error semantics, not tree art or colors. | open   |
| Should `junior check` offer JSON output?         | Human output only.                                            | Defer until automation needs structured diagnostics.               | open   |
| Should snapshot runtime/timeout be configurable? | Hard-coded runtime `node22` and 10 minute timeout.            | Add flags/env only when multiple runtimes are supported.           | open   |
| Who owns scaffold dependency version drift?      | Init hardcodes versions; docs separately state prerequisites. | Release packaging or docs-site should verify scaffold docs.        | open   |

## Validation

- `openspec validate backfill-cli --strict` passed.
