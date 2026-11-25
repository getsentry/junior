# Agent Instructions

Read the reference files at the end when your work touches their area.

## Rules

Each rule names what enforces it. When you correct an agent, add or tighten
the check first. A rule that only review enforces is a judgment call.

| Rule | Enforced by |
| --- | --- |
| Don't state the obvious. Minimize visual noise in UI. In UI copy, agent replies, Slack messages, docs, and PR text, cut what the context already shows. | Review |
| Use the words in `TERMINOLOGY.md`. Do not invent synonyms. | Review |
| A person's attention is the scarcest thing Junior spends. Ask for it only for an answer, a result, or a step that only they can take, and name which. Do the obviously right work, including upkeep of Junior's own work, and tell nobody. | Review |
| Build the smallest design that solves the proven problem. When output lacks information, use the data the system already stores before you add a hook or lookup. No speculative abstractions, hooks, configuration, or wrappers. | Review, `policies/correctness-complexity.md` |
| Generate deterministic output, such as links, IDs, and formats, in code. Do not fix it with prompt or tool text. | Review, `design/prompts.md` |
| Write TypeScript, not Java: functions, plain objects, simple types, small modules. | Review |
| Search every consumer before you change a shared signature, error contract, or name. Use a hard cutover unless compatibility is required. | `pnpm typecheck` |
| Let unexpected failures reach the owning boundary. Retry only expected transient failures. | `tool-error-classification:check` for tools, review elsewhere |
| Core owns the runtime and provider-neutral plugin contracts. Plugins own provider routes, API fields, permissions, errors, and formatting. | ast-grep `no-core-plugin-*` |
| No mutable runtime globals. No test-only singleton mutation APIs. | `test-architecture:check` for tests, review elsewhere |
| Query tables with the Drizzle query builder. Use `sql` only for expressions inside a builder query, or for statements without a table. | oxlint `junior/no-raw-sql-queries` |
| Store money in Postgres as whole micro-USD: a `bigint` column or an integer metric named `*_micro_usd`. Convert with `packages/junior/src/db/micro-usd.ts`. | `money-units:check` |
| Read GitHub state from GitHub through the plugin cache. Do not copy it into tables. | `provider-state:check` |
| A construct in reply content, such as a table or a card, must render on every surface that shows replies: natively, or with a fallback that keeps its content. | `reply-rendering:check` |
| Group files by feature and name paths by role. No feature-directory barrels. | Review |
| Exported functions get a brief JSDoc that states intent. | Review |
| Docs use ASD-STE100 English: common words, active voice, short sentences. | Review |
| A check baseline may only shrink. Fix the new violation. Do not add or raise an entry. | `baseline-growth:check` |
| Dashboard E2E ends only after the reads and writes it causes. Do not let a read stay open when the test ends. | the open-request check in `e2e/test.ts` |
| A Frameshift screenshot change that your diff did not cause is a bug. Find why the shot changed and fix it, or open an issue with the before and after. Do not ignore it or call it noise. | Review, `e2e/screenshot.ts` fails a shot that keeps changing |
| This is the only `AGENTS.md`. Do not add one in a directory. Put intent in a code comment next to the code that it governs. | `file-length:check` |
| Change this file or a `README.md` only when intent, an invariant, or a boundary changes. Do not commit implementation plans. Track planned work in GitHub issues. | Review |
| `design/` states the intent that people set for each system. Add, change, or remove a line there only after the person you work for confirms that exact text and its intent. Never change it as part of other work. | Review |

## Enforcement

To prevent a problem or correct an agent, use the first of these that works:

1. A check that fails in CI: an oxlint or ast-grep rule, or a `*:check`
   script.
2. Directory structure and semantic names.
3. Steering text: this file, `policies/`, prompts, and tool descriptions.
   `design/prompts.md` states its intent, and the `build-tools` skill says
   how to write it.

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

## iOS app

`apps/ios` is the native client. Read `apps/ios/README.md` first. It uses
only the public MCP server (`/api/mcp`), never dashboard `/api/*` routes.
One simulator can use about 10 GB of memory, so:

- Test logic with `swift test` in `apps/ios/Packages/JuniorKit`. It needs no
  simulator.
- Build and run only with `apps/ios/scripts/xcbuild.sh` and `sim.sh`.
- Do not shut down a simulator that you did not boot. Shut down one that you
  boot, and check `xcrun simctl list devices booted` before you finish.
- Run only the UI tests that the change needs.
- Do not clean-build or delete DerivedData or the shared cache to fix a build
  until you know the cause.

## Reference

- `TERMINOLOGY.md`: canonical words for code and docs.
- `TELEMETRY.md`: span, metric, and attribute names.
- `design/`: the goals and rules of each major system.
- `policies/correctness-complexity.md`: how much design a fix needs.
- `policies/interface-design.md`: module shape, file layout, lifecycle state.
- `policies/error-handling.md`: where failures are caught or retried.
- `policies/runtime-boundary-schemas.md`: validating data at runtime edges.
- `policies/provider-boundaries.md`: what belongs in core vs. a plugin.
- `policies/context-bound-systems.md`: passing authority, destination, scope.
- `policies/security.md`: credentials, sandbox, and model access.
- `policies/conversation-access.md`: when one Conversation may read, find,
  or act on another.
- `policies/data-redaction.md`: conversation privacy and redaction.
- `policies/serverless-background-work.md`: work that must outlive a request.
- `policies/observability.md`: telemetry for diagnosis.
- `policies/performance.md`: awaits, fan-out, and query refreshes.
- `policies/agentic-semantics.md`: choices that depend on meaning or intent.
- `policies/testing.md`: what to test and where.
- `policies/test-adapters.md`: shared test adapters.
- `policies/evals.md`: agent-facing evals.
- `policies/frontend-components.md`: dashboard UI ownership and styling.
- `policies/code-comments.md`: when and how to comment.
- `policies/documentation.md`: internal docs.
