---
title: Reliability Runbooks
description: Symptom-driven runbooks for production incidents.
type: troubleshooting
prerequisites:
  - /operate/observability/
related:
  - /start-here/verify-and-troubleshoot/
  - /reference/handler-surface/
---

## Webhook ingress failures

Question: are webhook requests accepted and routed correctly?

Check:

- `event.name:webhook.handler.failed`
- `event.name:webhook.response.unsuccessful`
- `span.op:http.server url.path:"/api/webhooks"`

## Queue callback failures

Question: are messages enqueued and processed successfully?

Check:

- `event.name:conversation.work.failed OR event.name:conversation.work.recovery.failed`
- `event.name:conversation.work.pending.requeued OR event.name:conversation.work.lease_expired.requeued`
- `event.name:agent.continue.schedule.failed OR event.name:agent.continue.lock.busy`
- `span.op:queue.process_message`

## Turn execution failures

Question: are assistant turns timing out or failing due to provider/tool issues?

Check:

- `event.name:agent.turn.timed_out`
- `event.name:agent.turn.failed OR event.name:agent.turn.provider_error`
- `span.op:gen_ai.invoke_agent`

## Tool failure hotspots

Question: which tools fail most and why?

Check:

- `event.name:agent.tool_call.failed`
- `event.name:agent.tool_call.input_invalid`
- `span.op:gen_ai.execute_tool`

## Recovery order

1. Confirm release boundary where failures started.
2. Triage highest-error symptom first (webhook, queue, turn, tool).
3. Apply rollback/hotfix.
4. Re-run health + Slack-thread verification.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for first-response checks, then return to [Observability](/operate/observability/) to confirm recovery.
