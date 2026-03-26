# Evals Spec

## Intent

Evals are end-to-end Slack conversation evaluations.

- We define conversation cases inline in TypeScript using `slackEval()`.
- We run the real runtime/harness against those fixtures.
- We score outcomes with an LLM judge via `vitest-evals`.

## Layer Boundaries

Testing taxonomy and layer contracts are defined in:

- `specs/testing/index.md`
- `specs/testing/evals-spec.md`
- `specs/testing/integration-spec.md`

Quick mapping:

- `tests/integration/*`: Slack/runtime integration and HTTP contract tests.
- `evals/*`: Conversation-level behavior and quality scoring through the runtime harness.
- `tests/unit/*` (or non-integration tests): isolated logic/invariant tests.

This separation is enforced by `pnpm run test:slack-boundary`.

## What Is In Scope

- Conversation-level behavior under realistic thread/message flows.
- Tool use and output behavior as observed by the runtime.
- Slack-visible metadata exposed by the runtime and harness.

Not in scope:

- Isolated unit behavior (belongs in unit tests).
- Low-level Slack HTTP payload contract checks (belongs in integration tests).

## Sources Of Truth

- Core eval cases:
  - `evals/core/passive-behavior.eval.ts`
  - `evals/core/routing-and-continuity.eval.ts`
  - `evals/core/lifecycle-and-resilience.eval.ts`
  - `evals/core/media-and-attachments.eval.ts`
  - `evals/core/oauth-workflows.eval.ts`
  - `evals/core/skill-infra.eval.ts`
- Plugin eval cases:
  - `evals/github/skill-workflows.eval.ts`
  - `evals/sentry/skill-workflows.eval.ts`
- Helpers and event builders: `evals/helpers.ts`
- Harness/runtime adapter: `evals/behavior-harness.ts`

## Execution Model

For each case (`slackEval()` call):

1. Replay events through the harness via `runEvalScenario()`.
2. Create a fresh runtime instance for the case via the chat composition root; do not mutate the production singleton runtime.
3. Route message events through real ingress + queue-worker behavior, with only the external queue transport replaced by an in-memory harness shim.
4. Return observed artifacts as JSON for LLM judgment, including structured `assistant_posts` with text plus actual attached-file metadata, and Slack-visible metadata.
5. `vitest-evals` scores the output against `criteria` (A–E → 1.0–0.0).

Harness override knobs (in `EvalOverrides`):

- `auto_complete_mcp_oauth`: after our app genuinely starts an MCP OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `auto_complete_oauth`: after our app genuinely starts a generic OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `fail_reply_call`: force a non-retryable reply failure on a specific call.
- `mock_image_generation`: stub the image-generation HTTP response with a valid image payload while still exercising the real attachment path.
- `plugin_dirs`: load plugin fixtures from eval-local directories without adding workspace packages.
- `reply_texts`: override returned reply text per call.
- `subscribed_decisions`: controls the subscribed-message reply gate in the harness. If you use it, do not claim that reply-selection behavior is being validated by the eval itself.

These knobs work by overriding services on the eval-local runtime instance. They must not reintroduce mutable global runtime behavior seams.

## Running

- `pnpm evals`: Run all eval cases (from workspace root)
- `pnpm --filter @sentry/junior-evals evals`: Run from any directory
- `pnpm --filter @sentry/junior-evals evals -- -t "subscribed"`: Filter by test name pattern

## Optional CI Runs

- On pull requests, the `Evals` workflow runs when either eval-related files changed or the PR has the `trigger-evals` label.
- Adding the `trigger-evals` label triggers a run immediately; adding unrelated labels does not.
- Eval-related files are:
  - `packages/junior-evals/evals/**`
  - `packages/junior-evals/vitest.evals.config.ts`
  - `packages/junior/src/**`
- The simplest CI setup is `VERCEL_OIDC_TOKEN` alone. It covers both AI Gateway auth and Vercel Sandbox auth.
- The fallback CI setup is `AI_GATEWAY_API_KEY` plus `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
- This repo is not intended to configure those GitHub Actions secrets right now. The workflow support and setup doc are future-facing.
- Setup details for GitHub Actions live in `evals/github-actions.md`.

Evals require real Vercel Sandbox access. If sandbox bootstrap fails, the eval fails immediately (no local fallback path).

## Authoring Rules

- Add core cases under `evals/core/*.eval.ts` and plugin-specific cases under `evals/<plugin>/` using `slackEval()`.
- Use event builders (`mention`, `threadMessage`, `threadStart`) from `evals/helpers.ts`.
- Use `auto_complete_mcp_oauth` or `auto_complete_oauth` when the harness should instantly complete the fake provider callback after our app has genuinely initiated auth.
- For multi-turn, pass the same `thread` override so events land in one thread.
- Keep each case focused on one primary behavior.
- Encode all expectations in `criteria`; do not add deterministic inline assertions.
- Keep user prompts natural. They should read like plausible user requests, not scripted implementation instructions.
- Do not tell the assistant which exact internal command, tool, skill-loading step, or transport sequence to use unless that exact surface is what the user would naturally say and is the behavior under evaluation.
- If an eval only passes when the prompt prescribes internal mechanics, the eval is invalid and the product behavior is not adequately covered.

Do not do these in eval files:

- Do not import `@/chat/slack/*` directly.
- Do not use MSW Slack helpers (`queueSlackApiResponse`, `getCapturedSlackApiCalls`, `queueSlackApiError`, `queueSlackRateLimit`).
- Do not validate raw Slack Web API request payload shapes from evals.
- Do not validate implementation internals (exact tool names, sandbox IDs, or other non-user-visible details) unless the scenario explicitly evaluates those surfaces.

## File Naming Strategy

- Core evals: `evals/core/`
- Plugin evals: `evals/<plugin-name>/` (e.g. `evals/github/`, `evals/sentry/`)
- File naming: `<journey>-and-<constraint>.eval.ts` or `<feature>-workflows.eval.ts`
  - Examples:
    - `routing-and-continuity.eval.ts`
    - `lifecycle-and-resilience.eval.ts`
    - `oauth-workflows.eval.ts`
    - `skill-workflows.eval.ts`
- Test naming: `<area>: <user-observable outcome>`
  - Examples:
    - `routing: explicit mention forces reply`
    - `skills: default repo setup via natural language`

## Eval Quality Rubric

Good conversational evals should:

- Start from realistic user events/messages (mentions, follow-ups, thread lifecycle events).
- Describe user-visible outcomes first (reply count, reply content, metadata effects visible to Slack users).
- Use concrete real-world scenarios (incident updates, planning follow-ups, capability setup requests), not abstract mechanics like "posted two replies."
- Use judge criteria written in product language, not implementation language.
- Cover realistic failure behavior (clear user-visible errors) without depending on internal tool wiring.
- Keep eval output payload user-facing (assistant posts + Slack-visible metadata), excluding low-level tool-call traces.

Avoid:

- Criteria tied to exact internal tool call names (`bash`, etc.) when user-visible behavior is what matters.
- User prompts that prescribe exact internal commands or tool choices just to force the desired path.
- Cases that only validate mocks or internal state transitions without conversational context.

## Minimal Case

```typescript
slackEval("mention basic reply", {
  events: [mention("<@U_APP> summarize this")],
  criteria: "Posts exactly one reply to the mention.",
});
```
