# Agent Instructions

Read the reference files at the end when your work touches their area.

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
- Store state only when its owner cannot give it on read. Read it from the
  provider, or derive it from rows that you already store.
- Group files by feature. No feature-directory barrels.
- Exported functions get a brief JSDoc that states intent.
- Docs use ASD-STE100 English: common words, active voice, short sentences.
- Put intent in a code comment next to the code that it governs.
- Change this file or a `README.md` only when intent, an invariant, or a
  boundary changes. Delete completed plans. Plans in `openspec/changes/`
  cannot override policy.

## Enforcement

To prevent a problem or correct an agent, use the first of these that works:

1. A check that fails in CI: an oxlint or ast-grep rule, or a `*:check`
   script.
2. Directory structure and semantic names.
3. Steering text: this file, `policies/`, prompts, and tool descriptions.
   `policies/agent-steering.md` owns how to write it.

When you correct an agent, fix the mistake and add or update its row. A
"Review" row that is corrected again needs a check.

| Rule                                                    | Enforced by                        |
| ------------------------------------------------------- | ---------------------------------- |
| Query tables with Drizzle; `sql` only inside a builder  | `junior/no-raw-sql-queries`        |
| Parse URLs with `URL`, not a regex                      | `junior/no-regex-url-parsing`      |
| Read the bot name from config, never write "Junior"     | ast-grep `no-hardcoded-bot-name`   |
| Parse data at its edge; no new type assertions          | `pnpm type-assertions:check`       |
| Import a service; no optional fallback to it for tests  | `junior/no-service-fallback`       |
| Loop with `for...of`, not `forEach`                     | `unicorn/no-array-for-each`        |
| Bound a list's concurrency with `pLimit(N).map`         | `pnpm unbounded-concurrency:check` |
| Call models through `@/chat/core-model`                 | `no-restricted-imports`            |
| Only the repo root has an `AGENTS.md`                   | `pnpm file-length:check`           |
| Store only state that the owner cannot give on read     | Review                             |

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
| Eval suites            | `behavioral`, `integration`, `guardian`, `classifiers`                           |
| Package schema         | `pnpm --filter <package> db:generate`                                            |
| Dashboard e2e          | `pnpm test:e2e:dashboard`                                                        |
| Release alignment      | `pnpm release:check`                                                             |
| Local agent check      | `pnpm cli -- chat ...` (see the `junior-qa` skill)                               |
| File length            | `pnpm file-length:check` (code max 1,000 lines, core docs max 120)               |

Split long files at a feature boundary. Do not compress formatting to pass.

## Reference

- `TERMINOLOGY.md`: canonical words for code and docs.
- `TELEMETRY.md`: span, metric, and attribute names.
- `policies/correctness-complexity.md`: how much design a fix needs.
- `policies/interface-design.md`: function and module shape, lifecycle state.
- `policies/error-handling.md`: where failures are caught or retried.
- `policies/runtime-boundary-schemas.md`: validating data at runtime edges.
- `policies/provider-boundaries.md`: what belongs in core vs. a plugin.
- `policies/context-bound-systems.md`: passing authority, destination, and
  scope.
- `policies/security.md`: credentials, sandbox, and model access.
- `policies/conversation-access.md`: when one Conversation may read, find,
  or act on another.
- `policies/data-redaction.md`: conversation privacy and redaction.
- `policies/serverless-background-work.md`: work that must survive request
  edges.
- `policies/observability.md`: telemetry for diagnosis.
- `policies/system-prompt.md`: system prompt blocks.
- `policies/prompt-markers.md`: tags, untrusted text, IDs, and escaping in
  model-read text.
- `policies/agent-steering.md`: steering agent behavior.
- `policies/agentic-semantics.md`: choices that depend on meaning or intent.
- `policies/tool-design.md`: model-facing tool contracts.
- `policies/testing.md`: what to test and where.
- `policies/test-adapters.md`: shared test adapters.
- `policies/evals.md`: agent-facing evals.
- `policies/frontend-components.md`: dashboard UI ownership and styling.
- `policies/code-comments.md`: when and how to comment.
- `policies/documentation.md`: internal docs.
