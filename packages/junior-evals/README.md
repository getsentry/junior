# Evals Spec

## Intent

Evals are end-to-end Slack conversation evaluations. They are the integration-style test layer for agent-facing behavior when model interpretation is part of the contract.

- We define conversation cases inline in TypeScript using `describeEval()` and the shared `slackEvals` harness options.
- We run the real runtime/harness against those fixtures.
- We score outcomes against the normalized `vitest-evals` session surface, backed by Junior's Pi client and the Vercel AI Gateway model `openai/gpt-5.4`.

## Layer Boundaries

Testing taxonomy and layer contracts are defined in:

- `specs/testing.md`
- `specs/eval-testing.md`
- `specs/integration-testing.md`
- `policies/evals.md`

Quick mapping:

- `tests/integration/*`: Slack/runtime integration and HTTP contract tests.
- `evals/*`: Integration-style coverage for conversation-level agent behavior and quality scoring through the runtime harness.
- `tests/unit/*` (or non-integration tests): isolated logic/invariant tests.

This separation is enforced by `pnpm lint`.

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
  - `evals/core/slack-message-delivery.eval.ts`
  - `evals/core/oauth-workflows.eval.ts`
  - `evals/core/skill-infra.eval.ts`
- Scheduler eval cases:
  - `evals/scheduler/workflows.eval.ts`
- Plugin eval cases:
  - `evals/github/skill-workflows.eval.ts`
  - `evals/memory/workflows.eval.ts`
  - `evals/sentry/skill-workflows.eval.ts`
- Helpers and event builders: `src/helpers.ts`
- Harness/runtime adapter: `src/behavior-harness.ts`

## Execution Model

For each `it()` case inside a `describeEval()` suite:

1. Replay events through the harness via `runEvalScenario()`.
2. Create a fresh runtime instance for the case via the chat composition root; do not mutate the production singleton runtime.
3. Route message events through real ingress + queue-worker behavior, with only the external queue transport replaced by an in-memory harness shim.
4. Return a standard `vitest-evals` `HarnessRun`; `result.session` is the canonical normalized surface for judge scoring and deterministic assertions.
5. Do not create a second repo-local transcript, event-log, or assertion schema when `vitest-evals` already has `session`, `toolCalls(result.session)`, `artifacts`, or `traces`.
6. `vitest-evals` scores the normalized session against `criteria` (A–E -> 1.0-0.0).

## Harness Boundaries

- Use the Slack eval harness for Slack/runtime behavior: mentions, thread/channel delivery, OAuth privacy, lifecycle/resume behavior, reactions, and Slack-visible side effects.
- Use an agent-level harness for prompt, skill routing, tool choice, provider/tool calls, and reply quality when Slack transport is not the behavior under test.
- The Slack eval harness session is an observed Slack output/tool/artifact projection. Do not add a repo-local sequencing layer to make it look like a full ordered conversation transcript.
- When the eval boundary is Junior's Pi agent or needs an ordered full-turn transcript, prefer `@vitest-evals/harness-pi-ai` primitives instead of rebuilding transcript capture locally. The Pi harness already owns normalized `session.messages`, `toolCalls(result.session)`, artifacts, traces, replay, and judge context.
- Do not assert against logs, spans, or status telemetry for product behavior. Use `vitest-evals` session/tool/artifact primitives for behavior contracts; reserve traces/spans for instrumentation tests or diagnostics.

Harness override knobs (in `EvalOverrides`):

- `auto_complete_mcp_oauth`: after our app genuinely starts an MCP OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `auto_complete_oauth`: after our app genuinely starts a generic OAuth flow for the listed providers, the harness immediately completes the fake provider callback.
- `credential_providers`: seed normal provider credentials for the listed providers. GitHub uses dummy GitHub App env vars plus an intercepted installation-token exchange; Sentry uses the normal OAuth token store.
- `fail_reply_call`: force a non-retryable reply failure on a specific call.
- `mock_image_generation`: stub the image-generation HTTP response with a valid image payload while still exercising the real attachment path.
- `plugin_dirs`: load plugin fixtures from eval-local directories without adding workspace packages.
- `reply_texts`: override returned reply text per call.
- `reply_timeout_ms`: lower or set the per-reply harness timeout for a specific scenario. It cannot exceed 30 seconds.
- `subscribed_decisions`: controls the subscribed-message reply gate in the harness. If you use it, do not claim that reply-selection behavior is being validated by the eval itself.

These knobs work by overriding services on the eval-local runtime instance. They must not reintroduce mutable global runtime behavior seams.

Tool replay:

- `webFetch` and `webSearch` are wrapped with `vitest-evals/replay` in the eval harness. Use `pnpm evals:record` to force fresh recordings under `.vitest-evals/recordings`.
- Keep committed recordings minimal and source-specific. Regenerate them from the evals that need replay, then review for stale exploratory fetches and secret-like values before committing.

## Running

- `pnpm evals`: Run all eval cases (from workspace root)
- `pnpm --filter @sentry/junior-evals evals`: Run from any directory
- `pnpm --filter @sentry/junior-evals evals evals/sentry/skill-workflows.eval.ts`: Run one eval file
- `pnpm --filter @sentry/junior-evals evals evals/sentry/skill-workflows.eval.ts -t "subscribed"`: Run one eval case by name

Pass eval file paths and `-t` filters directly after the `evals` script. Do not use `pnpm exec vitest` directly, and do not insert `--` before eval arguments.

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

- Add core cases under `evals/core/*.eval.ts` and plugin-specific cases under `evals/<plugin>/` using `describeEval()` with `slackEvals`.
- Use event builders (`mention`, `threadMessage`, `threadStart`) from `src/helpers.ts`.
- Use `auto_complete_mcp_oauth` or `auto_complete_oauth` when the harness should instantly complete the fake provider callback after our app has genuinely initiated auth.
- For multi-turn, pass the same `thread` override so events land in one thread.
- Keep each case focused on one primary behavior.
- Put semantic, model-dependent expectations in `criteria`.
- Put deterministic boundary expectations in normal Vitest assertions against `result.session`, `toolCalls(result.session)`, or `result.artifacts`. Prefer `vitest-evals` primitives over local helper-specific output shapes.
- New and edited evals must express `criteria` with `rubric({ pass, fail })`.
- Let the eval test name describe the scenario and expected outcome.
- `pass` should list observable pass conditions.
- `fail` should list forbidden outputs or failure conditions.
- Do not write judge criteria as one dense paragraph.
- Let the `describeEval()` block own the behavior area. The file path and `describeEval()` context already provide scope.
- Each eval name should only state the specific scenario and outcome.
- Prefer `when <trigger>, <outcome>` over vague labels like `continuity: remembers prior turn context`.
- Keep user prompts natural. They should read like plausible user requests, not scripted implementation instructions.
- Do not tell the assistant which exact internal command, tool, skill-loading step, or transport sequence to use unless that exact surface is what the user would naturally say and is the behavior under evaluation.
- If an eval only passes when the prompt prescribes internal mechanics, the eval is invalid and the product behavior is not adequately covered.

Do not do these in eval files:

- Do not import `@/chat/slack/*` directly.
- Do not use MSW Slack helpers (`queueSlackApiResponse`, `getCapturedSlackApiCalls`, `queueSlackApiError`, `queueSlackRateLimit`).
- Do not validate raw Slack Web API request payload shapes from evals.
- Do not invent parallel transcript, event-log, or tool-call schemas for assertions. If the existing `vitest-evals` primitives are insufficient, improve the harness boundary first.
- Do not validate implementation internals (exact tool names, sandbox IDs, or other non-user-visible details) unless the scenario explicitly evaluates those surfaces.

## File Naming Strategy

- Core evals: `evals/core/`
- Scheduler evals: `evals/scheduler/`
- Plugin evals: `evals/<plugin-name>/` (e.g. `evals/github/`, `evals/sentry/`)
- File naming: `<journey>-and-<constraint>.eval.ts` or `<feature>-workflows.eval.ts`
  - Examples:
    - `routing-and-continuity.eval.ts`
    - `lifecycle-and-resilience.eval.ts`
    - `oauth-workflows.eval.ts`
    - `skill-workflows.eval.ts`
- Test naming inside a describe block: `when <trigger>, <user-observable outcome>`
  - Examples:
    - `when a thread message explicitly mentions Junior, post a direct reply`
    - `when a default repo is set in one turn, reuse it in the next turn without asking again`

## Eval Quality Rubric

Follow `policies/evals.md` for the repo-wide defaults on invariant-based criteria and over-prescription.

Good conversational evals should:

- Start from realistic user events/messages (mentions, follow-ups, thread lifecycle events).
- Describe user-visible outcomes first (reply count, reply content, metadata effects visible to Slack users).
- Use concrete real-world scenarios (incident updates, planning follow-ups, capability setup requests), not abstract mechanics like "posted two replies."
- Use judge criteria written in product language, not implementation language.
- Use rubric sections that are easy for maintainers to scan in a failure: a short `pass` list and a focused `fail` list only when it describes a real regression.
- Keep rubric bullets at the behavior level. Prefer "uses the stored repo as the target" over requiring exact wording or incidental reply ordering.
- Omit incidental variation from the rubric unless it affects the behavior contract.
- Omit `fail` bullets unless they describe a real regression or unsafe side effect.
- Use fake/nonexistent external targets unless the eval explicitly opts into live provider access.
- Cover realistic failure behavior with clear user-visible errors.
- Use `toolCalls(result.session)` when tool/provider evidence proves behavior at a real boundary, such as source grounding, mutation safety, provider routing, or auth sequencing.

Avoid:

- Criteria tied to exact internal tool call names (`bash`, etc.) when user-visible behavior is what matters.
- User prompts that prescribe exact internal commands or tool choices just to force the desired path.
- Prompts that can hit random external URLs or mutate real provider resources for a behavior that can be tested with fake references.
- Cases that only validate mocks or internal state transitions without conversational context.

## Minimal Case

```typescript
import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Routing", slackEvals, (it) => {
  it("when explicitly mentioned, post one direct reply", async ({ run }) => {
    await run({
      events: [mention("<@U_APP> summarize this")],
      criteria: rubric({
        pass: ["The assistant posts exactly one reply to the mention."],
      }),
    });
  });
});
```
