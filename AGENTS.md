# Agent Instructions

## Package Manager

Use **pnpm**: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm skills:check`

## Commit Attribution

AI commits MUST include:

```
Co-Authored-By: (agent model name) <email>
```

## File-Scoped Commands

| Task                  | Command                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Unit test file        | `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`                                 |
| Integration test file | `pnpm --filter @sentry/junior exec vitest run path/to/file.test.ts`                                 |
| Eval file             | `pnpm --filter @sentry/junior-evals exec vitest run -c vitest.evals.config.ts path/to/eval.test.ts` |

## Key Conventions

- Use `/commit` skill for any commit operation.
- Use `/create-pr` skill for any PR creation operation.
- Use `/skill-creator` skill when creating or updating skills.
- Prefer integration tests for most product/runtime changes that need real wiring.
- Use evals as the integration-style layer for agent/prompt/natural-language behavior. See `packages/junior-evals/README.md`.
- Run evals from Codex as escalated host commands when they need real Vercel Sandbox/network access; use `pnpm evals` for the full suite.
- Use instrumentation conventions from `specs/logging/index.md`.
- Use OpenTelemetry semantic keys for logs; when no semantic key exists, use `app.*`.
- Keep release package lists aligned across `.craft.yml`, `scripts/bump-release-versions.mjs`, `.github/workflows/ci.yml`, `README.md`, and release docs; verify with `pnpm release:check`.
- Minimize defensive programming — no fallbacks when systems are expected to work. Ensure errors are captured correctly. Use retries for expected network failures, nothing more.
- Prefer minimal interfaces and simple components across the codebase.
- Keep public surfaces small: fewer exported types/functions, fewer integration points, explicit contracts.
- Prefer composition over abstractions that add indirection without clear reuse.
- Prefer standards/library-native patterns before custom infrastructure.
- Prefer standards-based streaming surfaces over custom transport loops.
- Chat SDK streaming standard: pass `AsyncIterable<string>` to `thread.post(...)`.
- Pi SDK streaming standard: consume `Agent` events (`message_update`/`text_delta`) and bridge deltas into the `AsyncIterable` shim.
- Avoid bespoke Slack `chat.update` loops unless required by a hard platform limitation.
- Prefer hard cutover for command or skill renames and behavior migrations unless backward compatibility is explicitly requested.
- Prefer integration tests over unit tests when real runtime wiring is needed and the contract is not model interpretation itself.
- Use evals when the contract is agent-facing behavior, prompt interpretation, natural-language routing, continuity, or reply quality.
- Use unit tests only for small local deterministic logic and algorithms.
- If a test needs multiple mocks to prove a user-visible workflow, it is probably in the wrong layer.
- Logs, spans, status telemetry, and other monitoring output are not behavior contracts. Do not add assertions for them, and do not mock logging/monitoring modules unless the test is explicitly about instrumentation.

## Engineering Principles

- Optimize for obvious code over flexible-but-indirect abstractions.
- Keep public interfaces small and intention-revealing.
- Let file/module structure carry context so names do not have to.
- Keep exported names role-specific; keep local helper names short.
- Prefer domain language over mechanism language.
- Every exported function must have a brief JSDoc comment explaining its intent (the _why_, not the _what_).

## Policies

- `policies/README.md` (when to add a policy doc and how policy docs should stay scoped)
- `policies/code-comments.md` (repo default for code comments, docstrings, and exported-function JSDoc)
- `policies/policy-template.md` (template for adding new policy docs)

## Investigation-First Development

- Before implementing anything that depends on an external system (Vercel, Slack, bundler, framework), read the relevant documentation or source code first. State the constraint being relied on before writing code.
- Before removing an architectural layer, prove the replacement handles all known edge cases in a working proof-of-concept. Do not remove the incumbent until the replacement is verified end-to-end.
- When changing a function signature, error contract, or shared pattern, grep for all consumers and verify each one still works. Do not assume fixing one call site is sufficient.
- If a fix attempt fails, stop. Re-read the error, trace the full system from input to output, and identify the root cause before trying another fix. Do not commit progressive patches that address symptoms layer-by-layer.
- When implementing message handling or Slack interactions, explicitly verify both DM and channel paths, and both first-delivery and retry paths.
- Slack-specific runtime and contract rules live in `specs/slack-agent-delivery-spec.md`, `specs/slack-outbound-contract-spec.md`, and `.agents/skills/slack-development/SKILL.md`. Keep `AGENTS.md` as a pointer, not a duplicate.

## Architecture Discipline

- `packages/junior/src/chat/app/*` is composition-root only: wire concrete services there, not in runtime/service modules.
- `packages/junior/src/chat/ingress/*` is the canonical home for inbound routing logic; do not add new patch-style ingress modules.
- Do not add mutable runtime behavior globals or test-only singleton mutation APIs (`set*ForTests`, `reset*ForTests`, observer globals for core behavior).
- Prefer small consumer-owned service interfaces over broad deps bags or service locators.
- Do not leak third-party SDK types across chat subsystem boundaries when a small local interface will do; keep vendor SDKs inside infrastructure modules.
- `runtime/` orchestrates turns and turn-scoped formatting, `services/` do domain work (reply policy, delivery planning, channel intent, attachment validation), `state/` persists by concern, `ingress/` only normalizes/routes.
- **Feature-based colocation**: group files by domain feature, not by technical role. Within a module, create subdirectories for each feature domain (e.g., `tools/slack/`, `tools/web/`, `tools/sandbox/`, `tools/skill/`). Shared contracts and cross-cutting utilities live at the module root. Only extract to a shared location when 2+ features need the same code.
- Do not use barrel `index.ts` re-exports inside feature subdirectories — import directly from the source file. A module-root `index.ts` is acceptable as a composition root that wires features together.
- Queue and worker paths must depend on injected runtime interfaces or factories, not import the production singleton from `@/chat/bot`.
- Do not use prototype patching or import-side-effect modules as the intended long-term ingress architecture.
- Prefer domain-role names over mechanism names: avoid `patch`, vague `behavior`, and ambiguous `runtime` labels for non-runtime modules.
- Tests and evals should create local runtimes via factories/fixtures and spy at real boundaries instead of patching the production singleton.

## Codex Execution Checklist

- Read local contracts first: `AGENTS.md`, relevant `specs/*`, and required `SKILL.md` files.
- For any test addition/update, you MUST read `specs/testing/index.md` first, then choose the layer with this rule: integration by default for product/runtime changes, evals for agent-facing/model-dependent behavior, unit only for local deterministic logic.
- Derive explicit invariants before editing and keep them stable through implementation.
- Use an explicit sequence for non-trivial tasks: discover -> minimal vertical slice -> verify -> summarize.
- Falsify risky assumptions early using the narrowest deterministic check.
- Reuse existing repository patterns before introducing new abstractions.
- Treat completion as gated: typecheck/build checks, targeted tests, and contract/spec updates when behavior changes.

## Known Specs

- `specs/index.md` (spec taxonomy, naming rules, and canonical vs archive guidance)
- `specs/security-policy.md` (global runtime/container/token security policy)
- `specs/chat-architecture-spec.md` (chat composition, service, and test-seam architecture contract)
- `specs/slack-agent-delivery-spec.md` (Slack entry surfaces, reply delivery, continuation, files, images, and resume behavior contract)
- `specs/slack-outbound-contract-spec.md` (Slack outbound boundary, message/file/reaction safety rules, and markdown-to-`mrkdwn` ownership)
- `specs/slack-rendering-spec.md` (Slack `mrkdwn` output contract: allow-list / forbid-list for the Slack surface — draft)
- `specs/skill-capabilities-spec.md` (capability declaration + broker/injection contract)
- `specs/oauth-flows-spec.md` (OAuth authorization code flow + Slack UX contract)
- `specs/harness-agent-spec.md` (agent loop and output contract)
- `specs/agent-session-resumability-spec.md` (multi-slice turn resumability and timeout recovery contract)
- `specs/agent-execution-spec.md` (agent execution rubric and completion gates)
- `specs/logging/index.md` (logging/tracing spec index)
- `specs/plugin-spec.md` (plugin architecture for self-contained provider integrations)
- `specs/testing/index.md` (testing taxonomy and layer boundaries: unit/integration/eval)
- Historical evaluations and superseded trackers live under `specs/archive/`.
