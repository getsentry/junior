---
title: Observability
description: Core signals and queries for webhook, queue, turn, and tool health.
type: reference
prerequisites:
  - /start-here/verify-and-troubleshoot/
related:
  - /operate/reliability-runbooks/
  - /operate/vercel-log-drains/
  - /reference/handler-surface/
---

## Key event signals

- `webhook.handler.failed`
- `conversation.work.failed`
- `conversation.work.recovery.failed`
- `agent.continue.schedule.failed`
- `agent.turn.failed`
- `agent.turn.timed_out`
- `agent.tool_call.failed`

## Key spans

- `http.server.request`
- `queue.enqueue_message`
- `queue.process_message`
- `chat.turn`
- `gen_ai.invoke_agent`
- `gen_ai.execute_tool`

## High-value attributes

- `http.response.status_code`
- `url.path`
- `app.queue.delivery_count`
- `messaging.message.conversation_id`
- `gen_ai.request.model`
- `error.type`

## Starter queries

```text
event.name:webhook.handler.failed
```

```text
event.name:conversation.work.failed OR event.name:conversation.work.recovery.failed
```

```text
event.name:conversation.work.pending.requeued OR event.name:conversation.work.lease_expired.requeued
```

```text
event.name:agent.continue.schedule.failed OR event.name:agent.continue.lock.busy
```

```text
event.name:agent.turn.timed_out OR event.name:agent.turn.failed
```

```text
event.name:agent.tool_call.failed
```

## Next step

Set up [Vercel Log Drains](/operate/vercel-log-drains/) to route runtime and build logs directly into Sentry, then use [Reliability Runbooks](/operate/reliability-runbooks/) for symptom-driven playbooks.
