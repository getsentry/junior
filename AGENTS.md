# Agent Instructions

Before you change code in a directory, read each `AGENTS.md` on the path from
the repo root. Repo-wide policy is indexed in `policies/README.md`. Telemetry
names live in `TELEMETRY.md`.

## Rules

- Don't state the obvious. In UI copy, agent replies, Slack messages, docs,
  and PR text, cut what the context already shows.
- Use the words in `TERMINOLOGY.md`. Do not invent synonyms.
- Build the smallest design that solves the proven problem. No speculative
  abstractions, configuration, or wrappers.
- Write TypeScript, not Java: functions, plain objects, simple types, small
  modules.
- Search every consumer before you change a shared signature, error contract,
  or name. Use a hard cutover unless compatibility is required.
- Let unexpected failures reach the owning boundary. Retry only expected
  transient failures.
- Core owns the runtime and provider-neutral plugin contracts. Plugins own
  provider routes, API fields, permissions, errors, and formatting.
- No mutable runtime globals. No test-only singleton mutation APIs.
- Group files by feature. No feature-directory barrels.
- Exported functions get a brief JSDoc that states intent.
- Docs use ASD-STE100 English: common words, active voice, short sentences.
- Change an `AGENTS.md` or `README.md` only when intent, an invariant, or a
  boundary changes. Delete completed plans. Plans in `openspec/changes/`
  cannot override policy.

## Testing

- Runtime behavior: integration tests through real Junior wiring. Fake only
  Slack and LLMs.
- Agent interpretation and reply quality: evals. Unit tests: isolated fixed
  logic only.
- Extend the owning scenario before you add a test. Do not test migrations,
  most visual changes, or one assertion at two layers.
- Telemetry is diagnostic. Do not assert product behavior with it.

## Commands

Use **pnpm**: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm skills:check`.

| Task                   | Command                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| One test file          | `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`              |
| Eval harness test file | `pnpm --filter @sentry/junior-evals test path/to/file.test.ts`                   |
| One eval file or case  | `pnpm --filter @sentry/junior-evals evals:<suite> path/to/x.eval.ts [-t "case"]` |
| Eval suites            | `behavioral`, `integration`, `guardian`, `router`, `classifiers`                 |
| Package schema         | `pnpm --filter <package> db:generate`                                            |
| Dashboard e2e          | `pnpm test:e2e:dashboard`                                                        |
| Release alignment      | `pnpm release:check`                                                             |
| Local agent check      | `pnpm cli -- chat ...` (see the `junior-qa` skill)                               |
| File length            | `pnpm file-length:check` (code max 1,000 lines, core docs max 120)               |

Split long files at a feature boundary. Do not compress formatting to pass.

Use `/commit` for commits, `/pr-writer` for pull requests, and
`/skill-writer` for skill changes.
