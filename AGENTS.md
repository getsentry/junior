# Agent Instructions

## Core Principles

- Use the words in `TERMINOLOGY.md`. Do not invent synonyms or long compound
  names when an existing term fits.
- This is TypeScript, not Java. Prefer functions, plain objects, simple types,
  and small modules. Follow `policies/interface-design.md`.
- Choose the smallest design that solves the proven problem. Avoid speculative
  abstractions, configuration, and wrappers. Follow
  `policies/correctness-complexity.md`.
- Write docs in ASD-STE100 English: common words, active voice, short
  sentences. Follow `policies/documentation.md`.
- Before you change code in a directory, read each `AGENTS.md` on the path from
  the repo root to that directory.

## Commands

Use **pnpm**: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm skills:check`.

| Task                   | Command                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| One test file          | `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`              |
| Eval harness test file | `pnpm --filter @sentry/junior-evals test path/to/file.test.ts`                   |
| One eval file or case  | `pnpm --filter @sentry/junior-evals evals:<suite> path/to/x.eval.ts [-t "case"]` |
| Eval suites            | `behavioral`, `integration`, `guardian`, `router`                                |
| Package schema         | `pnpm --filter <package> db:generate`                                            |
| Dashboard e2e          | `pnpm test:e2e:dashboard`                                                        |
| Release alignment      | `pnpm release:check`                                                             |
| Local agent check      | `pnpm cli -- chat ...` (see the `junior-qa` skill)                               |

## Workflow

- Use `/commit` for commits, `/pr-writer` for pull requests, and
  `/skill-writer` for skill changes.
- Discover, implement the smallest vertical slice, verify, and summarize.
- Search every consumer before you change a shared signature, error contract,
  or name. Use a hard cutover unless compatibility is required.
- Let unexpected failures reach the owning boundary. Retry only expected
  transient failures. Follow `policies/error-handling.md`.
- Exported functions need a brief JSDoc that states intent. Follow
  `policies/code-comments.md`.
- Do not add a paragraph to an `AGENTS.md` or `README.md` for each feature.
  Change a doc only when intent, an invariant, or a boundary changes.
- Delete completed plans.

## Testing

- Follow `policies/testing.md` and `policies/evals.md`.
- Runtime behavior belongs in integration tests through real Junior wiring.
  Fake only Slack and LLMs. Agent interpretation and reply quality belong in
  evals. Unit tests are only for isolated fixed logic.
- Before you add a test, find the primary owning scenario and extend it. A
  source change does not always need a new test.
- Do not test migrations, most visual changes, or the same assertion at more
  than one layer.
- Telemetry is diagnostic. Do not assert product behavior with it.

## Architecture

- Core owns the runtime and provider-neutral plugin contracts. Plugins own
  their provider behavior: routes, API fields, permissions, errors, and
  formatting. Follow `policies/provider-boundaries.md`.
- If a plugin needs a runtime capability, add the smallest provider-neutral
  contract to core or `packages/junior-plugin-api`.
- Group files by feature. Do not add feature-directory barrels.
- Code files have at most 1,000 lines and internal docs at most 120.
  `pnpm file-length:check` enforces this. Do not compress formatting to pass.
  Split at a feature boundary.
- Do not add mutable runtime globals or test-only singleton mutation APIs.
- Code, schemas, exported types, and tests are authoritative. Plans in
  `openspec/changes/<slug>/` cannot override policy.

## Where Rules Live

- Repo-wide policy: `policies/README.md`
- Chat runtime: `packages/junior/src/chat/AGENTS.md`
- Tests: `packages/junior/tests/AGENTS.md`
- Evals and recordings: `packages/junior-evals/AGENTS.md`
- Telemetry names: `TELEMETRY.md`
