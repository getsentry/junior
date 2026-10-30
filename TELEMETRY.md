# Telemetry

## Goal

Use this when investigating Junior production incidents. Start with a Slack
thread/message, Sentry event, trace ID, event name, or model/tool symptom, then
use the query recipes below to find the failing turn and next query.

## Where To Query

- Slack thread/footer: query Sentry Logs and Spans by
  `gen_ai.conversation.id` or `messaging.message.conversation_id`, then run the
  conversation recipes.
- Sentry `event_id`: open the Sentry event, copy `trace_id`, then query the
  trace and matching logs.
- `trace_id` / `span_id`: open Sentry Traces/Spans first; use logs only to
  inspect event names and exception fields around that trace.
- Stable `event.name`: query Sentry Logs, then use the matching domain below for
  the next pivot.
- Tool/model symptom: query spans/logs by `gen_ai.tool.name`,
  `gen_ai.request.model`, or `gen_ai.operation.name`.

## Investigation Pivots

| Pivot                               | Meaning                       | Found In                  | First Query           |
| ----------------------------------- | ----------------------------- | ------------------------- | --------------------- |
| `event_id`                          | captured Sentry error         | failed Slack reply        | open event            |
| `gen_ai.conversation.id`            | Slack thread/run conversation | Slack footer, logs, spans | query trace/logs      |
| `trace_id`                          | end-to-end trace              | errors, logs, spans       | open trace            |
| `span_id`                           | one span in a trace           | logs, spans               | inspect span          |
| `messaging.message.conversation_id` | Slack thread                  | logs, spans               | thread logs           |
| `messaging.message.id`              | Slack message timestamp       | logs, spans               | message logs          |
| `messaging.destination.name`        | Slack channel                 | logs, spans               | channel-scoped search |
| `gen_ai.tool.name`                  | tool name                     | tool spans/logs           | tool failures         |
| `app.credential.provider`           | auth provider                 | auth logs                 | auth/resume search    |
| `user.id`                           | accountable person            | logs, spans, errors       | person's actions      |
| `app.task.id`                       | scheduled/event automation id | task lifecycle logs       | task timeline         |
| `app.task.run.id`                   | scheduled-automation run id   | scheduler run logs        | run outcome           |
| `app.dispatch.id`                   | agent dispatch id             | task/dispatch logs        | fire conversation     |

## Query Recipes

Conversation timeline from a Slack thread, footer link, or conversation ID.

```text
dataset=spans query='gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,trace,span.op,span.description,span.duration,error.type
sort=-timestamp
```

Conversation log history from the same pivot.

```text
dataset=logs query='gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,level,event.name,trace_id,span_id,error.type,exception.message
sort=timestamp
```

Trace log history after opening a Sentry event or trace.

```text
dataset=logs query='trace_id:"<trace_id>"'
fields=timestamp,level,event.name,span_id,gen_ai.conversation.id,error.type,exception.message
sort=timestamp
```

Recent failed or timed-out agent runs.

```text
dataset=logs query='event.name:agent.turn.timed_out OR event.name:agent.turn.failed OR event.name:agent.turn.provider_error'
fields=timestamp,event.name,trace_id,span_id,gen_ai.conversation.id,gen_ai.request.model,error.type
sort=-timestamp
```

Tool failures or slow tool calls.

```text
dataset=spans query='span.op:gen_ai.execute_tool gen_ai.tool.name:"<tool_name>"'
fields=timestamp,trace,span.description,span.duration,gen_ai.conversation.id,gen_ai.tool.call.result.size,error.type
sort=-timestamp
```

Large tool results.

```text
dataset=spans query='span.op:gen_ai.execute_tool gen_ai.tool.call.result.size:>20000'
fields=timestamp,trace,gen_ai.conversation.id,gen_ai.tool.name,gen_ai.tool.call.result.size,span.duration
sort=-gen_ai.tool.call.result.size
```

Search tool volume, truncation, and raw output size.

```text
dataset=spans query='span.op:gen_ai.execute_tool gen_ai.tool.name:[grep,findFiles] app.sandbox.search.raw_output_bytes:*'
fields=timestamp,trace,gen_ai.tool.name,span.duration,app.sandbox.search.raw_output_bytes,app.sandbox.search.parsed_records,app.sandbox.search.result_count,app.sandbox.search.result_bytes,app.sandbox.search.limit,app.sandbox.search.limit_reached
sort=-timestamp
```

Slack delivery failures after the agent turn ran.

```text
dataset=logs query='event.name:slack.thread.post.failed app.slack.error_code:*'
fields=timestamp,event.name,gen_ai.conversation.id,messaging.destination.name,app.slack.reply_stage,app.slack.error_code,app.slack.api_error,exception.message
sort=-timestamp
```

Scheduled automation lifecycle by task id.

```text
dataset=logs query='app.task.id:"<task_id>"'
fields=timestamp,event.name,app.task.id,app.task.run.id,app.dispatch.id,app.task.schedule.kind,app.task.destination.visibility,app.task.result_message_ts,messaging.destination.name
sort=timestamp
```

Scheduled automation fire path by channel.

```text
dataset=logs query='event.name:scheduled_automation.run.dispatched messaging.destination.name:"<channel_id>"'
fields=timestamp,event.name,app.task.id,app.task.run.id,app.dispatch.id,app.task.schedule.kind,app.task.destination.visibility
sort=-timestamp
```

Recent scheduled-automation create/fire outcomes.

```text
dataset=logs query='event.name:scheduled_automation.create.completed OR event.name:scheduled_automation.run.claimed OR event.name:scheduled_automation.run.dispatched OR event.name:scheduled_automation.run.completed OR event.name:scheduled_automation.run.failed OR event.name:scheduled_automation.run.blocked OR event.name:scheduled_automation.run.skipped'
fields=timestamp,event.name,app.task.id,app.task.run.id,app.dispatch.id,app.task.schedule.kind,app.task.status,messaging.destination.name
sort=-timestamp
```

Credentialed provider writes, with whose authority they used. Write-grant
egress requests are audit events (`app.log.audit:true`), so Sentry keeps them
in production. Other info events stay out of Sentry in production.

```text
dataset=logs query='app.log.audit:true event.name:sandbox.egress.upstream.requested'
fields=timestamp,user.id,app.actor.type,app.actor.id,app.credential.allowed_when,app.task.id,gen_ai.conversation.id,app.provider.name,app.grant.name,http.request.method,server.address,url.path,http.response.status_code
sort=-timestamp
```

Auth, credential, and resume failures.

```text
dataset=logs query='app.credential.provider:"<provider>"'
fields=timestamp,event.name,gen_ai.conversation.id,app.credential.provider,app.ai.retryable_reason,exception.message
sort=-timestamp
```

## Identity

Runs, resumes, and the sandbox egress proxy bind the same identity attributes.
Nested logs and spans inherit them.

- `user.id`, `user.name`, `user.email`, `user.full_name`: the accountable
  person. For a user Actor, this is that user. For a system Actor, this is the
  owner of delegated credentials, such as the Automation creator. It is empty
  when a system run has no delegated credentials. Sentry also uses `user.id`
  for its user features.
- `app.actor.type`, `app.actor.id`: who acted. The type is `user` or `system`.
- `app.credential.allowed_when`, `app.task.id`: why delegated credentials were
  allowed, and for which Automation.

Do not add app-specific keys under `user.*`. Put facts about the request in
`app.*`.

## Domains

### Database Queries

PostgreSQL queries that are slow, frequent, or failing.

Spans: Sentry's automatic `pg` and Neon spans (`sentry.op` `db`, origin
`auto.db.postgres` or `auto.db.neon`). Node Postgres also adds `pg-pool.connect`
and `pg.connect` spans.

Attributes: `db.system.name`, `db.namespace`, `db.user`, `db.query.summary`,
`db.query.text`, `server.address`, `server.port`, `error.type`

`db.query.text` keeps parameter placeholders and never includes parameter values.
The SDK replaces inline SQL literals with `?` and removes SQL comments.
Group by `db.query.text` to identify one query shape. Group by
`db.query.summary` for a lower-cardinality operation and target view.

### Webhook Ingress

Slack or Vercel webhook delivery/routing failures.

Events: `webhook.response.unsuccessful`, `webhook.handler.failed`,
`slack.event.persist.failed`, `slack.event.routing.failed`,
`slack.event.enqueue.failed`

Spans: Sentry's automatic `http.server` span, `slack.message.ingress`

Attributes: `http.request.method`, `http.response.status_code`, `url.path`.
Webhook logs carry `app.request.id`.

Signed Slack message and mention events get a `slack.message.ingress` span
before membership checks. It carries conversation, channel, and message IDs,
plus these fields:

- `app.slack.user_id`, `app.slack.bot_id`: sender IDs from the event.
- `app.slack.team_id`, `app.slack.enterprise_id`: installation envelope IDs.
- `app.slack.user_team`, `app.slack.source_team`, `app.slack.event_team`:
  separate Slack fields, not interchangeable membership evidence.
- `app.slack.event_id`, `app.slack.event_type`, `app.slack.event_subtype`:
  event correlation and kind.
- `app.slack.is_ext_shared_channel`: envelope sharing flag, not membership.
- `app.slack.membership`: `verified`, `unverified`, or `not_checked`.
  `unverified` includes missing identity data, not just external authors.
  `not_checked` includes ignored events and failures before the check completes.

Identity fields record `missing` or `invalid` instead of absent or malformed
values. They do not contain message text, names, emails, or raw payloads.
A verified author does not imply the message was queued or received a reply.
These attributes belong to ingress; do not expect them on later worker spans.

```text
dataset=spans query='span.op:slack.message.ingress gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,trace,app.slack.user_id,app.slack.team_id,app.slack.user_team,app.slack.source_team,app.slack.event_team,app.slack.membership
sort=timestamp
```

### Conversation Work

A message was queued, but the worker started late, ran again, or did no work.

Events: `conversation.queue.message.rejected`,
`conversation.work.processing.disabled`

Spans: `conversation.work.publish` (`queue.publish`),
`conversation.work.process` (`queue.process`)

Attributes: `gen_ai.conversation.id`, `messaging.system`,
`messaging.destination.name`, `messaging.message.id`,
`messaging.message.body.size`, `messaging.message.receive.latency`,
`messaging.message.retry.count`, `app.worker.outcome`,
`app.worker.pending_count`

These spans use the [Sentry queue span conventions](https://develop.sentry.dev/sdk/telemetry/traces/modules/queues/),
so they show in the Sentry Queues view. Each conversation work queue send gets
one `queue.publish` span. Each queue message that the worker processes gets one
`queue.process` span. The process span starts a new trace. A Slack `chat.turn`
span links to it. See Slack Delivery.

On these spans, the `messaging.*` attributes describe the queue, not Slack:

- `messaging.system`: `vercel_queue`.
- `messaging.destination.name`: the queue topic, such as
  `junior_conversation_work`.
- `messaging.message.id`: the Vercel Queue message ID. The publish span does
  not have it when Vercel Queue accepts the send without an ID.
- `messaging.message.body.size`: on the publish span, the JSON payload size in
  bytes.
- `messaging.message.receive.latency`: on the process span, the milliseconds
  from queue send to worker start.
- `messaging.message.retry.count`: on the process span, `0` on the first
  delivery. Higher values are redeliveries.
- `app.worker.outcome`: the worker result, such as `completed`, `active`,
  `no_work`, `yielded`, `lost_lease`, `pending_requeued`, or `failed`.
  `active` means another worker holds the lease. A rejected message records
  the reject reason, such as `invalid_record`.
- `app.worker.pending_count`: pending mailbox messages when the worker read
  the Conversation state.

```text
dataset=spans query='span.op:[queue.publish,queue.process] gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,trace,span.op,span.duration,messaging.message.id,messaging.message.receive.latency,messaging.message.retry.count,app.worker.outcome,app.worker.pending_count
sort=timestamp
```

### Slack Delivery

Slack accepted the request but no final reply appeared.

Events: `agent.turn.started`, `agent.turn.completed`, `agent.turn.failed`,
`slack.thread.post.failed`, `assistant.status.update.failed`,
`slack.action.failed`, `slack.action.retrying`

Spans: `chat.turn`, `chat.reply`, `chat.slash_command`,
`chat.app_home_opened`, `chat.app_home_disconnect`

Attributes: `trace_id`, `span_id`, `gen_ai.conversation.id`,
`messaging.message.conversation_id`, `messaging.destination.name`,
`app.slack.reply_stage`, `app.slack.error_code`, `app.slack.api_error`,
`app.turn.input_count`, `app.turn.delivery_lag_ms`, `app.turn.wait_ms`

A Slack `chat.turn` span records mailbox timing for its input messages:

- `app.turn.input_count`: input messages in the batch that started the turn.
- `app.turn.delivery_lag_ms`: Slack send time to webhook receipt for the
  oldest input message.
- `app.turn.wait_ms`: webhook receipt of the oldest input message to the start
  of the `chat.turn` span. It includes queue wait and worker setup.

For the oldest input message, delivery lag, wait, and the `chat.turn` duration
are contiguous.

A Slack `chat.turn` span is in the trace of a Slack webhook request:

- Ingress stores the `sentry-trace` and `baggage` headers of its
  `slack.message.ingress` span on the mailbox entry.
- `chat.turn` continues the trace of the oldest input message that has these
  headers. Its parent is that `slack.message.ingress` span. The trace keeps the
  sampling decision of the ingress request.
- `chat.turn` has a span link to the `slack.message.ingress` span of each other
  input message, and a span link to the `queue.process` span of the worker.
- Without stored headers, `chat.turn` is a child of the `queue.process` span.
  Headers that are not valid start a new trace.

A Turn that yields, times out, or waits for auth continues in a resumed slice.
Each resumed slice has its own `chat.turn` span in the trace of the first slice:

- The first save of the Turn cursor stores the active `sentry-trace` and
  `baggage` headers. Later saves keep them.
- A resumed `chat.turn` continues that trace. Its parent is the span that was
  active at the first save. It has a span link to the `queue.process` span of
  the worker.

The timing attributes are absent when the value is negative. A negative value
is clock skew between Slack and Junior hosts, not latency. Resumed `chat.turn`
spans do not record these attributes.

```text
dataset=spans query='span.op:chat.turn has:app.turn.wait_ms'
fields=timestamp,trace,span.duration,app.turn.input_count,app.turn.delivery_lag_ms,app.turn.wait_ms
sort=-app.turn.wait_ms
```

First feedback is the earliest `http.client` span for
`POST slack.com/api/reactions.add` or
`POST slack.com/api/assistant.threads.setStatus` in the turn's trace. For a
mention, ingress adds the processing reaction before the worker runs. Use the
ingress `reactions.add` span for a mention. It is in the same trace as the
turn.

A mention turn also calls `reactions.add` again, and Slack returns an
`already_reacted` error. This is a known double reaction. #2318 tracks it.

Each reply post attempt has an `http.client` span named
`POST slack.com/api/chat.postMessage` under `chat.turn`. It carries
`messaging.message.id` when Slack accepts the post.

### Agent And Model

The turn timed out, returned no useful answer, or used unexpected reasoning.

Events: `agent.message.received`, `agent.message.generated`,
`agent.turn.timed_out`,
`agent.turn.provider_error`, `agent.turn.execution.failed`,
`agent.turn.empty_output.retrying`,
`agent.turn.empty_output.exhausted`, `agent.turn.automation_result.reminded`,
`assistant.reply.generation.failed`,
`guardian.action_review.retrying`, `guardian.action_review.exhausted`

`guardian.action_review.exhausted` is a tool-boundary Sentry capture after three
consecutive action-review denials. The agent still receives a normal tool
rejection that says not to keep retrying.

Spans: `ai.generate_assistant_reply`, `ai.chat_completion`,
`chat.route_thinking`, `gen_ai.invoke_agent`, `gen_ai.chat`

Attributes: `gen_ai.operation.name`, `gen_ai.request.model`,
`gen_ai.response.finish_reasons`, `app.ai.outcome`, `app.automation.result`,
`app.ai.reasoning_effort`, `app.ai.model_profile`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.input_tokens.cached`,
`gen_ai.usage.input_tokens.cache_write`, `app.ai.reasoning_tokens`,
`app.ai.empty_output.attempt`, `app.ai.provider_error.kind`,
`app.ai.provider_error.summary`, `app.ai.provider_error.retry_attempt`,
`app.guardian.review_attempt`,
`app.ai.cost.input_usd`, `app.ai.cost.output_usd`,
`app.ai.cost.cache_read_usd`, `app.ai.cost.cache_write_usd`,
`app.ai.cost.total_usd`, `app.ai.time_to_first_byte_ms`,
`gen_ai.response.time_to_first_chunk`, `app.ai.first_token_type`,
`gen_ai.response.streaming`

Each `gen_ai.chat` span records how long the model took to start its reply.
Both times start just before the model request:

- `app.ai.time_to_first_byte_ms`: milliseconds to the first stream event of
  any type. This is almost always Pi's `start` event, which Pi sends when the
  HTTP response arrives.
- `gen_ai.response.time_to_first_chunk`: seconds to the first event with model
  content. This is the time to first token. The OTel GenAI and Sentry
  conventions use this name and unit for the first content chunk.
- `app.ai.first_token_type`: the type of that first content event. Content
  events are the content block events: `text_*`, `thinking_*`, and
  `toolcall_*`. Block `*_start` events count, because the model has started
  the block and a tool call start already has the tool name. `start`, `done`,
  and `error` do not count.
- `gen_ai.response.streaming`: `true` when any event arrived. `false` when the
  call failed or was aborted before any event. A terminal `error` event is not
  a response event. A call that fails after `start` but before content has a
  time to first byte and no time to first token.

```text
dataset=spans query='span.op:gen_ai.chat gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,trace,gen_ai.request.model,app.ai.time_to_first_byte_ms,gen_ai.response.time_to_first_chunk,app.ai.first_token_type,gen_ai.response.streaming,span.duration
sort=timestamp
```

### Tools, MCP, And Sandbox

A tool failed, an MCP call failed, a command exited non-zero, or sandbox startup was slow.

Events: `agent.tool_call.failed`, `mcp.tool_call.failed`,
`mcp.tool_annotations.missing`, `plugin.tool_annotations.missing`,
`mcp.tool_manager.close.failed`, `sandbox.boot.requested`,
`sandbox.network_policy_restore.failed`

Spans: `execute_tool <toolName>`, `sandbox.acquire`, `sandbox.create`,
`sandbox.snapshot.resolve`, `sandbox.sync_skills`, `bash`

Attributes: `gen_ai.tool.name`, `gen_ai.tool.call.id`,
`gen_ai.tool.call.result`, `gen_ai.tool.call.result.size`, `mcp.method.name`,
`process.executable.name`, `process.exit.code`, `app.sandbox.source`,
`app.sandbox.acquire.outcome`,
`app.sandbox.snapshot.resolve_outcome`, `app.sandbox.search.raw_output_bytes`,
`app.sandbox.search.parsed_records`,
`app.sandbox.search.result_count`, `app.sandbox.search.emitted_lines`,
`app.sandbox.search.result_bytes`, `app.sandbox.search.limit`,
`app.sandbox.search.limit_reached`, `app.tool.missing_annotations`

`app.sandbox.acquire.outcome` on `sandbox.acquire` tells which path returned
the sandbox:

- `memory`: the runtime already held the sandbox.
- `resumed`: `sandbox.get` reopened the stored sandbox.
- `created`: `sandbox.create` booted a new sandbox. Its
  `app.sandbox.source` and `app.sandbox.snapshot.*` attributes tell how.

Workspace switches create their sandbox outside `sandbox.acquire`. To find the
sandbox cost of one turn, add the durations of the top-level `sandbox.*` spans
under its `chat.turn` span. Do not add nested `sandbox.*` spans again.

```text
dataset=spans query='span.op:sandbox.acquire'
fields=timestamp,trace,span.duration,app.sandbox.acquire.outcome
sort=-span.duration
```

Sandbox egress events: `sandbox.egress.upstream.requested` is logged for every
forwarded request outside production. In production, it is logged only for
write grants, as an audit event. Attributes: `app.provider.name`,
`app.grant.name`, `app.grant.access`, `app.log.audit`, and the identity
attributes below. The proxy binds them from the signed credential token.

### Scheduled automations

A scheduled automation was created, claimed, dispatched, completed, or failed
without an obvious Slack error.

Events: `scheduled_automation.create.completed`, `scheduled_automation.run.claimed`,
`scheduled_automation.run.dispatched`, `scheduled_automation.run.completed`,
`scheduled_automation.run.failed`, `scheduled_automation.run.blocked`,
`scheduled_automation.run.skipped` (heartbeat `shouldSkipRun` and claim-time late/stale
skips), `scheduled_automations.heartbeat.dispatched`,
`scheduled_automations.heartbeat.failed`, `task.execution.stat_failed`,
`automation.blocked_notice.failed` (the creator notice for a blocked
Scheduled automation or Event automation did not send)

Spans: create-turn `gen_ai.execute_tool` for `slackScheduleCreateAutomation`; fire
path `POST /api/internal/agent/continue` for the dispatch conversation

Attributes: `app.task.id`, `app.task.type`, `app.task.status`,
`app.task.schedule.kind`, `app.task.schedule.timezone`,
`app.task.credential_mode`, `app.task.destination.channel_id`,
`app.task.destination.team_id`, `app.task.destination.visibility`,
`app.task.destination.audience`, `app.task.next_run_at`, `app.task.run.id`,
`app.task.run.status`, `app.task.run.scheduled_for`,
`app.task.result_message_ts`, `app.dispatch.id`,
`messaging.destination.name`

Pivot from create confirmation or Tasks page with `app.task.id`. From a fire
conversation, use `app.dispatch.id` or `agent-dispatch:<dispatch_id>` as
`gen_ai.conversation.id`.

### Auth And Resume

A turn parked for auth, resumed late, or failed after callback.

Events: `sandbox.egress.credential.needed`,
`sandbox.egress.credential.unavailable`, `sandbox.egress.upstream_auth.rejected`,
`sandbox.egress.upstream_auth.retrying`, `plugin.credential.rejected`,
`subscribed_message.authorization.required`, `agent.continue.schedule.failed`,
`agent.continue.lock.busy`, `agent.continue.lock.retrying`,
`oauth.callback.resume.completed`, `oauth.callback.resume.busy`,
`mcp.oauth_callback.failed`

Spans: resumed `chat.turn`, `chat.reply`

Attributes: `app.credential.provider`, `app.credential.delivery`,
`app.ai.retryable_reason`, `app.ai.session_id`,
`app.ai.resume_session_version`

### Skills And Plugins

A skill/tool is missing, plugin discovery failed, or capability activation looks wrong.

Events: `startup.discovery.completed`, `plugin.loaded`,
`skill.directory.read.failed`, `skill.frontmatter.invalid`,
`skill.load.stat.failed`, `plugin.root.read.failed`

Spans: active turn spans carry plugin/skill attributes

Attributes: `app.skill.name`, `app.skill.count`, `app.plugin.name`,
`app.plugin.count`, `app.plugin.has_mcp`, `app.capability.names`,
`file.directory`, `app.file.skill_directory`

### Attachments And Web Search

Screenshots, file attachments, image context, or web search failed.

Events: `attachment.resolution.failed`, `attachment.size_limit.skipped`,
`image.attachment.processing.failed`, `conversation.image.context.hydrated`,
`conversation.image.vision.failed`, `web.search.failed`

Spans: model/tool spans around vision or search calls

Attributes: `app.message.attachment_count`,
`app.message.prompt_attachment_count`, `app.conversation_image.analyzed`,
`app.web_search.query`, `app.web_search.retryable`, `app.web_search.timeout`,
`file.name`, `file.size`, `app.file.id`, `app.file.mime_type`

## Configuration

| Setting                     | Controls                 | Default                                    |
| --------------------------- | ------------------------ | ------------------------------------------ |
| `SENTRY_DSN`                | Sentry ingestion         | disabled                                   |
| `SENTRY_ENVIRONMENT`        | Sentry environment       | `VERCEL_ENV` or `NODE_ENV`                 |
| `SENTRY_RELEASE`            | Sentry release           | `<Junior version>+<VERCEL_GIT_COMMIT_SHA>` |
| `SENTRY_ENABLE_LOGS`        | structured logs          | true when `SENTRY_DSN` is set              |
| `SENTRY_TRACES_SAMPLE_RATE` | traces                   | `1`                                        |
| `SENTRY_ORG_SLUG`           | Slack footer trace links | unset                                      |
| `JUNIOR_LOG_FORMAT`         | console format           | compact unless `structured`                |
