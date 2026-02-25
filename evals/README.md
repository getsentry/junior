# Behavior Evals

Keep evals simple:

1. Add a case to `evals/cases/slack-behaviors.yaml`.
2. Run `pnpm evals` (LLM judge scores each case from 0-100).

Execution uses the behavior harness (fake Slack threads/events) and then LLM-as-judge scoring.

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
    posts_contain:
      - "summary"
```

## Supported Event Types

- `new_mention`
- `subscribed_message`
- `assistant_thread_started`
- `assistant_context_changed`

## Common Expectations

- `posts_count`
- `posts_contain`
- `primary_thread_subscribed`
- `warning_events`
- `exception_events`
- `adapter_title_calls`
- `adapter_prompt_calls`
