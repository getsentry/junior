---
title: Execution Model
description: End-to-end runtime lifecycle from webhook ingress to threaded response.
type: conceptual
summary: Understand the request lifecycle from Slack ingress through queue processing to threaded response delivery.
prerequisites:
  - /start-here/quickstart/
related:
  - /concepts/thread-routing/
  - /concepts/credentials-and-oauth/
  - /operate/reliability-runbooks/
---

## Runtime lifecycle

1. Slack sends an event to `/api/webhooks/slack`.
2. Junior validates and routes the event.
3. Thread work is enqueued to `junior-thread-message`.
4. `/api/queue/callback` processes queued work.
5. Agent turn runs with configured tools, skills, and capability gates.
6. Reply is posted back to the original Slack thread.

## Why queue-backed processing exists

- Avoids long-running webhook request paths.
- Makes retries explicit and observable.
- Preserves thread execution invariants in background turns.

## Core invariants

- Webhook ingress and queue callback are both required for production.
- Tool/credential usage is capability-gated and requester-bound.
- Failure states are logged and surfaced for operator recovery.

## Where to go next

- [Thread Routing](/concepts/thread-routing/)
- [Credentials & OAuth](/concepts/credentials-and-oauth/)
- [Reliability Runbooks](/operate/reliability-runbooks/)
