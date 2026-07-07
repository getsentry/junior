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
3. Conversation work is enqueued to the durable conversation-work queue.
4. `/api/internal/agent/continue` processes queued conversation work.
5. The agent run continues with configured tools, loaded skills, and capability gates.
6. If sandbox traffic reaches a declared provider domain, the sandbox egress proxy lazily fetches actor-bound credentials and injects them at the host boundary.
7. If OAuth is required, Junior sends the link privately to the requesting user and resumes the blocked request after the callback.
8. Reply is posted back to the original Slack thread.
9. Successful completed sessions can schedule plugin background tasks through `/api/internal/plugin/tasks`.

## Why queue-backed processing exists

- Avoids long-running webhook request paths.
- Makes retries explicit and observable.
- Preserves thread execution invariants in background turns.

## Core invariants

- Webhook ingress and queue callbacks are required for production.
- Tool usage is agent-run scoped; sandbox credential leases are actor-bound and minted lazily only after forwarded provider traffic needs them.
- Registered plugin providers determine which provider credentials can be injected for matching provider domains.
- Failure states are logged and surfaced for operator recovery.

## Where to go next

- [Thread Routing](/concepts/thread-routing/)
- [Credentials & OAuth](/concepts/credentials-and-oauth/)
- [Reliability Runbooks](/operate/reliability-runbooks/)
