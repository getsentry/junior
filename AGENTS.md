# Agent Instructions

Use **pnpm**: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm skills:check`.

## Commands

| Task                       | Command                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| Unit/integration test file | `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`            |
| Eval harness test file     | `pnpm --filter @sentry/junior-evals test path/to/file.test.ts`                 |
| Eval file                  | `pnpm --filter @sentry/junior-evals evals path/to/eval.eval.ts`                |
| Eval case                  | `pnpm --filter @sentry/junior-evals evals path/to/eval.eval.ts -t "case name"` |
| Generate package schema    | `pnpm --filter <package> db:generate`                                          |
| Release package alignment  | `pnpm release:check`                                                           |

For local evals, run `pnpm dev:env` once, start dependencies with `docker compose up -d postgres redis`, and ensure `cloudflared` is on `PATH`. Use the eval commands above without manually binding environment variables; the eval config loads repository env files and provisions its Postgres test databases.

## Required Workflows

- Use `/commit` for commits, `/pr-writer` for pull requests, and `/skill-writer` for skill changes.
- For tests, read `policies/testing.md`; harness mechanics live in `packages/junior/tests/README.md` and `packages/junior-evals/README.md`.
- Use evals for model interpretation, continuity, tool choice, routing, or reply quality.
- Prefer integration tests for product/runtime behavior; use unit tests for local deterministic logic.
- Validate non-Slack agent behavior with `pnpm cli -- chat ...`; see `packages/docs/src/content/docs/contribute/local-agent-validation.md`.

## Architecture Boundaries

- `packages/junior/src/chat/app/*` is composition-root only.
- `packages/junior/src/chat/ingress/*` owns inbound parsing, classification, and routing.
- `runtime/` orchestrates turns; `services/` owns domain decisions; `state/` persists by concern.
- Queue and worker code depends on injected runtime interfaces, not `@/chat/app/production`.
- Slack modules must not import runtime modules; shared modules must not expose provider SDK types.
- Group files by feature and import feature files directly; do not add feature-directory barrels.
- Do not add mutable runtime globals or test-only singleton mutation APIs.

## Engineering Defaults

- Prefer obvious code, small public interfaces, standards, and library-native behavior.
- Use hard cutovers for internal renames unless compatibility is explicitly required.
- Let unexpected failures reach the owning boundary; retry only expected transient failures.
- Exported functions need brief intent-focused JSDoc; follow `policies/code-comments.md`.
- Follow `policies/observability.md`; telemetry is not a product behavior assertion.

## Documentation Routing

- `policies/README.md`: durable repo-wide engineering rules.
- `TERMINOLOGY.md`: canonical repo-wide runtime vocabulary.
- Owning package or module `README.md`: implemented architecture and non-obvious invariants.
- Code, schemas, exported types, and tests: authoritative implementation contracts.
- `openspec/changes/<slug>/`: temporary implementation plans; delete completed plans.
- `TELEMETRY.md`: production investigation recipes.

- Read the owning module README before changing a shared runtime boundary.
- Plans cannot override policies; update a policy explicitly for an exception.

## Completion

- Search every consumer before changing a shared signature, error contract, or name.
- For non-trivial changes: discover, implement the smallest vertical slice, verify, summarize.
- Run applicable checks, move durable explanation beside code, and delete completed plans.
