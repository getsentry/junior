# Agent Instructions

Before you change code in a directory, read each `AGENTS.md` on the path from
the repo root. Read the reference files at the end when your work touches
their area.

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

## Reference

Vocabulary and names:

- `TERMINOLOGY.md`: canonical words for code and docs.
- `TELEMETRY.md`: span, metric, and attribute names.

Policies in `policies/`:

- `correctness-complexity.md`: how much design a fix needs.
- `interface-design.md`: function and module shape.
- `error-handling.md`: where failures are caught or retried.
- `runtime-boundary-schemas.md`: validating data at runtime edges.
- `provider-boundaries.md`: what belongs in core vs. a plugin.
- `context-bound-systems.md`: passing authority, destination, and scope.
- `security.md`: credentials, sandbox, and model access.
- `data-redaction.md`: conversation privacy and redaction.
- `serverless-background-work.md`: work that must survive request edges.
- `observability.md`: telemetry for diagnosis.
- `system-prompt.md`, `agent-steering.md`, `agentic-semantics.md`: prompt
  text and agent behavior.
- `tool-design.md`: model-facing tool contracts.
- `testing.md`, `test-adapters.md`, `evals.md`: what to test and where.
- `frontend-components.md`: dashboard UI ownership and styling.
- `code-comments.md`, `documentation.md`: comments and internal docs.

Package rules:

- `packages/junior/src/chat/AGENTS.md`: chat runtime.
- `packages/junior/tests/AGENTS.md`: test layout and fixtures.
- `packages/junior/migrations/AGENTS.md`: database migrations.
- `packages/junior-evals/AGENTS.md`: evals and recordings.
- `packages/junior-dashboard/AGENTS.md`: dashboard.
- `packages/junior-plugin-api/AGENTS.md`: plugin contracts.
