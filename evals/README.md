# Evals Spec

## Intent

Evals are end-to-end Slack conversation evaluations.

- We define conversation fixtures in YAML.
- We run the real runtime/harness against those fixtures.
- We score outcomes with an LLM-as-a-judge.

This is intentionally close to `~/src/ash/evals`: scenario fixtures + real execution + judged outcomes.

## What Is In Scope

- Conversation-level behavior under realistic thread/message flows.
- Tool use and output behavior as observed by the runtime.
- Logged warnings/exceptions and metadata exposed by the harness.

Not in scope:

- Isolated unit behavior (belongs in `tests/`).
- Mock-only prompt snapshots that bypass runtime flow.

## Sources Of Truth

- Cases: `evals/cases/slack-behaviors.yaml`
- Harness/runtime adapter: `evals/behavior-harness.ts`
- Judge suite entrypoint: `evals/llm-judge.eval.ts`

## Execution Model

For each case:

1. Load YAML fixture.
2. Replay events through the harness.
3. Collect observed artifacts:
   - posts
   - tool calls
   - warning/exception events
   - thread metadata and adapter calls
4. Build a judge prompt with expected behavior + observed artifacts.
5. Ask judge model for structured JSON:
   - `score` (0-100)
   - `reasoning` (short)

## Running

- `pnpm evals`: LLM-judged eval run (default eval command)
- `pnpm test`: normal test suite

## Fixture Contract

Each case in `slack-behaviors.yaml` includes:

- `id`
- `description`
- `events[]`
- `expected`
- optional `behavior` overrides for harness conditions

Supported event types:

- `new_mention`
- `subscribed_message`
- `assistant_thread_started`
- `assistant_context_changed`

Common expected fields:

- `posts_count` / `min_posts`
- `tool_calls_include`
- `primary_thread_subscribed`
- `warning_events`
- `exception_events`
- `adapter_title_calls`
- `adapter_prompt_calls`
- `log_events`
- `log_event_attributes`
- `sandbox_id_present`
- `sandbox_ids_count`
- `sandbox_ids_unique_count`

## Authoring Rules

- Model fixtures after real Slack turns (thread IDs, mentions, author info).
- Keep each case focused on one primary behavior.
- Prefer adding new cases over widening old ones.
- Include expected signals that make failures diagnosable (posts/tool/log fields).
- Avoid brittle assertions on incidental formatting unless that is the behavior under test.

## Minimal Case

```yaml
- id: mention_basic_reply
  description: Mention posts a reply.
  events:
    - type: new_mention
      thread:
        id: thread-basic
      message:
        text: "<@U_APP> summarize this"
        is_mention: true
  expected:
    posts_count: 1
```
