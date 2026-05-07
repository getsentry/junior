---
title: Execution Model
description: End-to-end runtime lifecycle from webhook ingress to threaded response.
type: conceptual
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
5. Agent turn runs with configured tools, loaded skills, and capability gates.
6. If an authenticated command needs provider access, the runtime infers the required capability, fetches requester-bound credentials for that turn, and injects them at the host boundary.
7. If OAuth is required, Junior sends the link privately to the requesting user and resumes the blocked request after the callback.
8. Reply is posted back to the original Slack thread.

## Why queue-backed processing exists

- Avoids long-running webhook request paths.
- Makes retries explicit and observable.
- Preserves thread execution invariants in background turns.

## Core invariants

- Webhook ingress and queue callback are both required for production.
- Tool and credential usage is capability-gated, requester-bound, and turn-scoped.
- Loaded skill plugins determine which provider credentials can be injected at all.
- Failure states are logged and surfaced for operator recovery.

## Where to go next

- [Thread Routing](/concepts/thread-routing/)
- [Credentials & OAuth](/concepts/credentials-and-oauth/)
- [Reliability Runbooks](/operate/reliability-runbooks/)
