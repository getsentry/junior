---
title: Thread Routing
description: How mentions, thread replies, and continuity decisions are handled.
---

## Routing rules (high-level)

- Mentions in channel threads are primary entry points.
- Thread follow-ups are processed in thread context.
- Runtime preserves conversation ownership and continuity boundaries.

## Continuity behavior

- Incoming events are normalized to thread identity.
- Queued processing carries thread context into background turns.
- Assistant replies are posted in-thread, not as new top-level messages.

## Failure behavior

- Retryable transport/provider failures are retried within bounded limits.
- Non-retryable failures produce explicit failure signals for operators.

## Operator checks

- Confirm Slack conversation/thread IDs are stable in traces/logs.
- Confirm reply posts map to the originating thread.
- Confirm retry storms are absent and bounded.

## Next step

Use [Observability](/operate/observability/) and [Reliability Runbooks](/operate/reliability-runbooks/) when routing behavior degrades.
