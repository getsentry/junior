# Telemetry Usage Runbooks

This guide is non-normative and focused on operating Junior with Sentry telemetry.
Use it to answer production questions with traces and logs.

## How To Use This Guide

- Pick the runbook that matches the symptom.
- Run the listed query recipes first.
- Follow the drill-down sequence to narrow root cause.
- Build dashboards from the suggested panels.

## 1) Webhook Ingress Health

Question: Are webhook requests accepted and routed without elevated failures?

Primary signals:
- Span: `http.server.request` (`op:http.server`)
- Logs: `webhook_platform_unknown`, `webhook_non_success_response`, `webhook_handler_failed`
- Attributes: `http.response.status_code`, `url.path`, `platform`

Query recipes:
- `event.name:webhook_handler_failed`
- `event.name:webhook_non_success_response http.response.status_code:[400,599]`
- `span.op:http.server url.path:"/api/webhooks"`

Dashboard panels:
- Webhook request count by status code
- Webhook 5xx rate over time
- Top webhook error events by `event.name`

Drill-down:
1. Filter to failing `http.response.status_code` classes.
2. Group by `platform` and `url.path`.
3. Open sample traces and inspect child queue/sandbox spans.

## 2) Queue Enqueue + Processing Reliability

Question: Are messages being enqueued, deduped, and processed successfully?

Primary signals:
- Spans: `queue.enqueue_message`, `queue.process_message`
- Logs: `queue_ingress_enqueued`, `queue_ingress_dedup_hit`, `queue_callback_failed`, `queue_message_failed`
- Attributes: `app.queue.message_id`, `app.queue.message_kind`, `app.queue.delivery_count`, `app.queue.topic`

Query recipes:
- `event.name:queue_callback_failed OR event.name:queue_message_failed`
- `event.name:queue_ingress_dedup_hit`
- `span.op:queue.process_message`

Dashboard panels:
- Queue processing duration percentile
- Queue callback failure count
- Dedup hit ratio (`queue_ingress_dedup_hit` vs `queue_ingress_enqueued`)

Drill-down:
1. Filter failures by `app.queue.message_kind`.
2. Pivot on `app.queue.delivery_count` to isolate retry-heavy failures.
3. Trace `queue.process_message` into `chat.turn`/`chat.reply`.

## 3) Assistant Turn + Model Execution

Question: Are chat turns completing within expected latency and without provider failures/timeouts?

Primary signals:
- Spans: `chat.turn`, `chat.reply`, `ai.generate_assistant_reply`
- Logs: `agent_turn_started`, `agent_turn_completed`, `agent_turn_failed`, `agent_turn_timeout`, `agent_turn_provider_error`
- Attributes: `gen_ai.request.model`, `app.ai.outcome`, `app.ai.turn_timeout_ms`, `messaging.message.conversation_id`

Query recipes:
- `event.name:agent_turn_timeout`
- `event.name:agent_turn_failed OR event.name:agent_turn_provider_error`
- `span.op:gen_ai.invoke_agent`

Dashboard panels:
- Assistant turn success/error counts by model
- Agent invocation duration percentile
- Timeout count over time

Drill-down:
1. Slice by `gen_ai.request.model` and `deployment.environment.name`.
2. Compare timeout spikes with queue delivery retries.
3. Inspect tool-call child spans inside slow traces.

## 4) Tool Execution Reliability

Question: Which tools are failing or slow, and with what error classes?

Primary signals:
- Span family: `execute_tool <tool_name>` (`op:gen_ai.execute_tool`)
- Logs: `agent_tool_call_started`, `agent_tool_call_completed`, `agent_tool_call_failed`, `agent_tool_call_invalid_input`
- Attributes: `gen_ai.tool.name`, `gen_ai.tool.call.id`, `app.ai.tool_duration_ms`, `app.ai.tool_outcome`, `error.type`

Query recipes:
- `event.name:agent_tool_call_failed`
- `event.name:agent_tool_call_invalid_input`
- `span.op:gen_ai.execute_tool`

Dashboard panels:
- Tool failure count by `gen_ai.tool.name`
- Tool duration percentile by `gen_ai.tool.name`
- Tool error type distribution

Drill-down:
1. Group failures by `gen_ai.tool.name`.
2. Compare `error.type` vs validation failures.
3. Open traces to see upstream turn context and sandbox reuse/source attributes.

## 5) Sandbox + Snapshot + Package Install Health

Question: Are sandboxes being acquired efficiently, and are dependency snapshots/install phases healthy?

Primary signals:
- Spans: `sandbox.acquire`, `sandbox.create`, `sandbox.snapshot.resolve`, `sandbox.snapshot.lock_wait`, `sandbox.snapshot.build`, `sandbox.snapshot.install_system`, `sandbox.snapshot.install_npm`, `sandbox.snapshot.capture`, `bash`
- Logs/errors: setup failures surfaced as `sandbox setup failed (...)` with error telemetry
- Attributes: `app.sandbox.source`, `app.sandbox.snapshot.cache_hit`, `app.sandbox.snapshot.resolve_outcome`, `app.sandbox.snapshot.rebuild_reason`, `app.sandbox.snapshot.dependency_count`, `app.sandbox.snapshot.install.system_count`, `app.sandbox.snapshot.install.npm_count`, `process.exit.code`, `error.type`

Query recipes:
- `span.op:sandbox.snapshot.resolve`
- `span.op:sandbox.snapshot.install.system OR span.op:sandbox.snapshot.install.npm`
- `span.op:sandbox.create app.sandbox.snapshot.cache_hit:false`
- `span.op:sandbox.snapshot.lock_wait`

Dashboard panels:
- Snapshot resolve outcomes over time (`app.sandbox.snapshot.resolve_outcome`)
- Snapshot cache-hit ratio (`app.sandbox.snapshot.cache_hit`)
- Snapshot install phase duration percentiles
- Sandbox create failures by `error.type`

Drill-down:
1. Track cache-hit drops first (`cache_hit:false` growth).
2. If rebuilds spike, group by `app.sandbox.snapshot.rebuild_reason`.
3. If build latency spikes, separate lock-wait vs install spans.
4. For install failures, inspect `error.type` and failing phase span.

## 6) OAuth + Credential Issuance Flows

Question: Are credential/OAuth flows starting, delivering private guidance, and recovering correctly?

Primary signals:
- Logs: `jr_rpc_oauth_start`, `oauth_private_delivery_failed`, `oauth_dm_fallback_failed`, `credential_issue_request`, `credential_issue_success`, `credential_issue_failed`
- Attributes: `app.reason`, capability/request context keys, user/thread correlation

Query recipes:
- `event.name:jr_rpc_oauth_start`
- `event.name:credential_issue_failed OR event.name:oauth_private_delivery_failed OR event.name:oauth_dm_fallback_failed`
- `event.name:credential_issue_request OR event.name:credential_issue_success`

Dashboard panels:
- OAuth start volume
- Credential issue success/failure counts
- Private delivery fallback failure counts

Drill-down:
1. Compare request vs success event volume.
2. Group failures by `app.reason`.
3. Follow related conversation/thread IDs to confirm resume completion.

## Starter Dashboard Pack

Create these first:
- Runtime health: webhook 5xx, queue callback failures, agent turn failures.
- Latency: queue process duration, model invocation duration, sandbox create duration.
- Snapshot efficiency: cache-hit ratio and resolve outcome trends.
- Credential reliability: issue success/failure and OAuth delivery fallback failures.
