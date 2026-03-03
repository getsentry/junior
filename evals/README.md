# Evals Spec

## Intent

Evals are end-to-end Slack conversation evaluations.

- We define conversation cases inline in TypeScript using `slackEval()`.
- We run the real runtime/harness against those fixtures.
- We score outcomes with an LLM judge via `vitest-evals`.

## Slack Test Taxonomy

- `tests/integration/*`: Slack HTTP contract tests using MSW (`queueSlackApiResponse`, `getCapturedSlackApiCalls`, request payload assertions).
- `evals/*`: Conversation-level behavior and quality scoring through the runtime harness.
- `tests/*` (non-integration): Unit and domain tests without Slack HTTP contract assertions.

This separation is enforced by `pnpm run test:slack-boundary`.

## What Is In Scope

- Conversation-level behavior under realistic thread/message flows.
- Tool use and output behavior as observed by the runtime.
- Logged warnings/exceptions and metadata exposed by the harness.

Not in scope:

- Isolated unit behavior (belongs in `tests/`).
- Mock-only prompt snapshots that bypass runtime flow.

## Sources Of Truth

- Eval cases:
  - `evals/conversational/routing-and-continuity.eval.ts`
  - `evals/conversational/lifecycle-and-resilience.eval.ts`
  - `evals/conversational/skill-workflows.eval.ts`
- Helpers and event builders: `evals/helpers.ts`
- Harness/runtime adapter: `evals/behavior-harness.ts`

## Execution Model

For each case (`slackEval()` call):

1. Replay events through the harness via `runBehaviorEvalCase()`.
2. Return observed artifacts as JSON for LLM judgment.
3. `vitest-evals` scores the output against `criteria` (A–E → 1.0–0.0).

## Running

- `pnpm evals`: Run all eval cases
- `pnpm evals -- -t "subscribed"`: Filter by test name pattern
- `pnpm test`: Normal test suite (not evals)

Evals require real Vercel Sandbox access. If sandbox bootstrap fails, the eval fails immediately (no local fallback path).

## Authoring Rules

- Add new conversational cases under `evals/conversational/*.eval.ts` using `slackEval()`.
- Use event builders (`mention`, `threadMessage`, `threadStart`) from `evals/helpers.ts`.
- For multi-turn, pass the same `thread` override so events land in one thread.
- Keep each case focused on one primary behavior.
- Encode all expectations in `criteria`; do not add deterministic inline assertions.

Do not do these in eval files:

- Do not import `@/chat/slack-actions/*` directly.
- Do not use MSW Slack helpers (`queueSlackApiResponse`, `getCapturedSlackApiCalls`, `queueSlackApiError`, `queueSlackRateLimit`).
- Do not validate raw Slack Web API request payload shapes from evals.
- Do not validate implementation internals (exact tool names, sandbox IDs, or other non-user-visible details) unless the scenario explicitly evaluates those surfaces.

## File Naming Strategy

- Directory: `evals/conversational/`
- File naming: `<journey>-and-<constraint>.eval.ts` or `<feature>-workflows.eval.ts`
  - Examples:
    - `routing-and-continuity.eval.ts`
    - `lifecycle-and-resilience.eval.ts`
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
- Cases that only validate mocks or internal state transitions without conversational context.

## Minimal Case

```typescript
slackEval("mention basic reply", {
  events: [mention("<@U_APP> summarize this")],
  criteria: "Posts exactly one reply to the mention.",
});
```
