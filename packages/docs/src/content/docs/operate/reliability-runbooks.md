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

- `event.name:webhook_handler_failed`
- `event.name:webhook_non_success_response`
- `span.op:http.server url.path:"/api/webhooks"`

## Queue callback failures

Question: are messages enqueued and processed successfully?

Check:

- `event.name:conversation_work_failed OR event.name:conversation_work_recovery_failed`
- `event.name:conversation_work_pending_requeued OR event.name:conversation_work_lease_expired_requeued`
- `event.name:agent_continue_schedule_failed OR event.name:agent_continue_lock_busy`
- `span.op:queue.process_message`

## Turn execution failures

Question: are assistant turns timing out or failing due to provider/tool issues?

Check:

- `event.name:agent_turn_timeout`
- `event.name:agent_turn_failed OR event.name:agent_turn_provider_error`
- `span.op:gen_ai.invoke_agent`

## Tool failure hotspots

Question: which tools fail most and why?

Check:

- `event.name:agent_tool_call_failed`
- `event.name:agent_tool_call_invalid_input`
- `span.op:gen_ai.execute_tool`

## Recovery order

1. Confirm release boundary where failures started.
2. Triage highest-error symptom first (webhook, queue, turn, tool).
3. Apply rollback/hotfix.
4. Re-run health + Slack-thread verification.

## Next step

Use [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) for first-response checks, then return to [Observability](/operate/observability/) to confirm recovery.
