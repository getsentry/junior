---
title: Observability
description: Core signals and queries for webhook, queue, turn, and tool health.
type: reference
summary: Use core events, spans, and query patterns to monitor Junior webhook, queue, turn, and tool health.
prerequisites:
  - /start-here/verify-and-troubleshoot/
related:
  - /operate/reliability-runbooks/
  - /reference/handler-surface/
---

## Key event signals

- `webhook_handler_failed`
- `queue_callback_failed`
- `agent_turn_failed`
- `agent_turn_timeout`
- `agent_tool_call_failed`

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
event.name:webhook_handler_failed
```

```text
event.name:queue_callback_failed OR event.name:queue_message_failed
```

```text
event.name:agent_turn_timeout OR event.name:agent_turn_failed
```

```text
event.name:agent_tool_call_failed
```

## Next step

Use symptom-driven playbooks in [Reliability Runbooks](/operate/reliability-runbooks/).
