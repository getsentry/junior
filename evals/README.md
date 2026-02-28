# Evals Spec

## Intent

Evals are end-to-end Slack conversation evaluations.

- We define conversation cases inline in TypeScript using `slackEval()`.
- We run the real runtime/harness against those fixtures.
- We score outcomes with an LLM judge via `vitest-evals`.
- Deterministic assertions use Vitest `expect()`.

## What Is In Scope

- Conversation-level behavior under realistic thread/message flows.
- Tool use and output behavior as observed by the runtime.
- Logged warnings/exceptions and metadata exposed by the harness.

Not in scope:

- Isolated unit behavior (belongs in `tests/`).
- Mock-only prompt snapshots that bypass runtime flow.

## Sources Of Truth

- Eval cases: `evals/slack-behaviors.eval.ts`
- Helpers and event builders: `evals/helpers.ts`
- Harness/runtime adapter: `evals/behavior-harness.ts`

## Execution Model

For each case (`slackEval()` call):

1. Replay events through the harness via `runBehaviorEvalCase()`.
2. Run inline `expect()` assertions (deterministic — failure = score 0).
3. Return observed artifacts as JSON for LLM judgment.
4. `vitest-evals` scores the output against `criteria` (A–E → 1.0–0.0).

## Running

- `pnpm evals`: Run all eval cases
- `pnpm evals -- -t "subscribed"`: Filter by test name pattern
- `pnpm test`: Normal test suite (not evals)

## Authoring Rules

- Add new cases to `evals/slack-behaviors.eval.ts` using `slackEval()`.
- Use event builders (`mention`, `threadMessage`, `threadStart`) from `evals/helpers.ts`.
- For multi-turn, pass the same `thread` override so events land in one thread.
- Keep each case focused on one primary behavior.
- Use `expect()` for deterministic assertions and `criteria` for LLM judgment.

## Minimal Case

```typescript
slackEval("mention basic reply", {
  events: [mention("<@U_APP> summarize this")],
  assert: (result) => {
    expect(result.posts).toHaveLength(1);
  },
  criteria: "Posts exactly one reply to the mention.",
});
```
