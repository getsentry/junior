# Agent Instructions

## Core Principles

- Use the words in `TERMINOLOGY.md`. Do not invent synonyms, overloaded terms, or long compound names when an existing term fits.
- This is TypeScript/JavaScript, not Java. Prefer functions, plain objects, simple types, and small modules. Avoid class hierarchies, manager/factory names, and interface layers unless they solve a real problem; follow `policies/interface-design.md`.
- Optimize for the next maintainer. Choose the smallest design that solves the proven problem, keep complexity local, and avoid speculative abstractions, configuration, extension points, and wrappers; follow `policies/correctness-complexity.md`.
- Write for normal humans. Code, names, docs, plans, and explanations should make sense without a PhD or an architecture lecture. If they do not, simplify them.

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

## Workflow

- Use `/commit` for commits, `/pr-writer` for pull requests, and `/skill-writer` for skill changes.
- For non-trivial changes: discover, implement the smallest vertical slice, verify, and summarize.
- Search every consumer before changing a shared signature, error contract, or name; use a hard cutover unless compatibility is explicitly required.
- Let unexpected failures reach the owning boundary; retry only expected transient failures. Follow `policies/error-handling.md`.
- Exported functions need brief intent-focused JSDoc; follow `policies/code-comments.md`.
- Run applicable checks, move durable explanations beside the owning code, and delete completed plans.

## Testing And Validation

- Follow `policies/testing.md` and `policies/evals.md`: prefer integration tests for product/runtime behavior, evals for agent interpretation and reply quality, and unit tests for local deterministic logic.
- Test harness mechanics live in `packages/junior/tests/README.md` and `packages/junior-evals/README.md`.
- For local evals, run `pnpm dev:env` once, run `docker compose up -d postgres redis`, and ensure `cloudflared` is on `PATH`. Do not bind environment variables manually; the eval config loads repo env files and provisions test databases.
- Validate non-Slack agent behavior with `pnpm cli -- chat ...`; see `packages/docs/src/content/docs/contribute/local-agent-validation.md`.
- Telemetry is diagnostic, not a product behavior assertion; follow `policies/observability.md` and `TELEMETRY.md`.

## Architecture

- Read `packages/junior/src/chat/README.md` before changing shared chat runtime behavior; it owns flow, module boundaries, vocabulary, and invariants.
- Follow `policies/provider-boundaries.md`; provider modules do not import runtime orchestration, and shared modules do not expose provider SDK types.
- Group files by feature and import feature files directly; do not add feature-directory barrels.
- Do not add mutable runtime globals or test-only singleton mutation APIs.

## Where Rules Live

| Need                    | Source                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Repo-wide policy index  | `policies/README.md`                                                                                    |
| Runtime vocabulary      | `TERMINOLOGY.md`                                                                                        |
| Design and failures     | `policies/interface-design.md`, `policies/correctness-complexity.md`, `policies/error-handling.md`       |
| Provider boundaries     | `policies/provider-boundaries.md`                                                                       |
| Comments and telemetry  | `policies/code-comments.md`, `policies/observability.md`, `TELEMETRY.md`                                 |
| Chat architecture       | `packages/junior/src/chat/README.md`                                                                    |
| Testing and evals       | `policies/testing.md`, `policies/evals.md`, `packages/junior/tests/README.md`, `packages/junior-evals/README.md` |
| Local agent validation  | `packages/docs/src/content/docs/contribute/local-agent-validation.md`                                   |
| Temporary plans         | `openspec/changes/<slug>/`                                                                              |

Feature architecture and non-obvious invariants belong in the owning package or module `README.md`. Code, schemas, exported types, and tests are authoritative. Plans cannot override policy; update the policy for an exception.
