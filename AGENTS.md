# Agent Instructions

## Core Principles

- Use the words in `TERMINOLOGY.md`. Do not invent synonyms, overloaded terms, or long compound names when an existing term fits.
- This is TypeScript/JavaScript, not Java. Prefer functions, plain objects, simple types, and small modules. Avoid class hierarchies, manager/factory names, and interface layers unless they solve a real problem; follow `policies/interface-design.md`.
- Optimize for the next maintainer. Choose the smallest design that solves the proven problem, keep complexity local, and avoid speculative abstractions, configuration, extension points, and wrappers; follow `policies/correctness-complexity.md`.
- Write docs, policies, plans, and explanations in ASD-STE100 English. Use common words, active voice, short sentences, and one idea per sentence. Keep required terms from `TERMINOLOGY.md` and explain them when needed. Remove other jargon.

Use **pnpm**: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm skills:check`.

## Commands

| Task                       | Command                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| Unit/integration test file | `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`                        |
| Eval harness test file     | `pnpm --filter @sentry/junior-evals test path/to/file.test.ts`                             |
| Behavioral eval file       | `pnpm --filter @sentry/junior-evals evals:behavioral path/to/eval.eval.ts`                 |
| Behavioral eval case       | `pnpm --filter @sentry/junior-evals evals:behavioral path/to/eval.eval.ts -t "case name"`  |
| Integration eval file      | `pnpm --filter @sentry/junior-evals evals:integration path/to/file.eval.ts`                |
| Integration eval case      | `pnpm --filter @sentry/junior-evals evals:integration path/to/file.eval.ts -t "case name"` |
| Guardian eval file         | `pnpm --filter @sentry/junior-evals evals:guardian path/to/file.eval.ts`                   |
| Guardian eval case         | `pnpm --filter @sentry/junior-evals evals:guardian path/to/file.eval.ts -t "case name"`    |
| Generate package schema    | `pnpm --filter <package> db:generate`                                                      |
| Dashboard e2e              | `pnpm test:e2e:dashboard`                                                                  |
| Release package alignment  | `pnpm release:check`                                                                       |

## Workflow

- Use `/commit` for commits, `/pr-writer` for pull requests, and `/skill-writer` for skill changes.
- For non-trivial changes: discover, implement the smallest vertical slice, verify, and summarize.
- Search every consumer before changing a shared signature, error contract, or name; use a hard cutover unless compatibility is explicitly required.
- When adding or renaming a shared export, search its exact name and the canonical domain terms a maintainer would use. The owner and consumers should be easy to distinguish without knowing the file path first.
- Let unexpected failures reach the owning boundary; retry only expected transient failures. Follow `policies/error-handling.md`.
- Exported functions need brief intent-focused JSDoc; follow `policies/code-comments.md`.
- Run applicable checks, move durable explanations beside the owning code, and delete completed plans.

## Testing And Validation

- Follow `policies/testing.md` and `policies/evals.md`. Product/runtime behavior belongs in integration tests through real Junior wiring (fake only Slack and LLMs via shared harnesses); agent interpretation and reply quality belong in evals; unit tests are reserved for isolated deterministic logic.
- Before adding a test, search every test layer for the behavior and extend its primary owning scenario. A source change does not automatically require a new test, and equal- or higher-fidelity existing coverage is sufficient.
- Do not write automated tests for migrations or migration SQL. Use migration metadata and schema generation checks, then test the resulting product behavior through its primary owning scenario.
- Do not add tests for most visual changes. Layout, styling, spacing, theme, copy presentation, and other look-and-feel work should be manually QA'd with visual evidence. Do not add unit, component, snapshot, or browser regression tests just because a UI file changed.
- Add automated coverage for UI only when the change owns a product behavior contract: navigation, interaction, accessibility state, request or response shape, auth gating, or a realistic failure path. Even then, extend the primary owning scenario instead of adding a new junk case.
- Do not repeat the same behavioral assertion at multiple layers or add one test per implementation branch. Add cross-layer coverage only for a distinct contract or failure boundary, and use representative cases unless exhaustive inputs protect a local deterministic invariant.
- Test harness mechanics live in `packages/junior/tests/README.md` and `packages/junior-evals/README.md`.
- For local evals, run `pnpm dev:env` once, run `docker compose up -d postgres redis`, and ensure `cloudflared` is on `PATH`. Do not bind environment variables manually; the eval config loads repo env files and provisions test databases.
- Validate non-Slack agent behavior with `pnpm cli -- chat ...`; see `packages/docs/src/content/docs/contribute/local-agent-validation.md`.
- Telemetry is diagnostic, not a product behavior assertion; follow `policies/observability.md` and `TELEMETRY.md`.

## Architecture

- Core owns the runtime and provider-neutral plugin contracts. Plugins own their domain behavior.
- Keep all provider-specific routes, API fields, permissions, errors, formatting, and policy in the owning plugin package. For example, GitHub behavior belongs in `packages/junior-github`.
- If a plugin needs a runtime capability, add the smallest provider-neutral contract to core or `packages/junior-plugin-api`. Do not add the provider's decision to core.
- Treat provider names, hosts, routes, and control flow in core as an architecture warning even when a static dependency rule cannot detect the problem. Follow `policies/provider-boundaries.md`.
- Read `packages/junior/src/chat/README.md` before changing shared chat runtime behavior; it owns flow, module boundaries, vocabulary, and invariants.
- Group files by feature and import feature files directly; do not add feature-directory barrels.
- Keep formatter output. Do not compress or undo formatting to keep a code file
  below 1,000 lines. Split a formatted file that exceeds 1,000 lines at a clear
  feature or ownership boundary. Existing exceptions must stay named and
  explained in `scripts/file-length-exceptions.mjs`; follow
  `policies/correctness-complexity.md`.
- Do not add mutable runtime globals or test-only singleton mutation APIs.

## Where Rules Live

| Need                   | Source                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Repo-wide policy index | `policies/README.md`                                                                                             |
| Runtime vocabulary     | `TERMINOLOGY.md`                                                                                                 |
| Design and failures    | `policies/interface-design.md`, `policies/correctness-complexity.md`, `policies/error-handling.md`               |
| Frontend components    | `policies/frontend-components.md`, `packages/junior-dashboard/src/client/components/README.md`                   |
| Agent steering         | `policies/agent-steering.md`                                                                                     |
| Provider boundaries    | `policies/provider-boundaries.md`                                                                                |
| Comments and telemetry | `policies/code-comments.md`, `policies/observability.md`, `TELEMETRY.md`                                         |
| Chat architecture      | `packages/junior/src/chat/README.md`                                                                             |
| Testing and evals      | `policies/testing.md`, `policies/evals.md`, `packages/junior/tests/README.md`, `packages/junior-evals/README.md` |
| Local agent validation | `packages/docs/src/content/docs/contribute/local-agent-validation.md`                                            |
| Temporary plans        | `openspec/changes/<slug>/`                                                                                       |

Feature architecture and non-obvious invariants belong in the owning package or module `README.md`. Code, schemas, exported types, and tests are authoritative. Plans cannot override policy; update the policy for an exception.
