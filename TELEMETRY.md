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
| `app.task.id`                       | scheduled/event task id       | task lifecycle logs       | task timeline         |
| `app.task.run.id`                   | scheduled-task run id         | scheduler run logs        | run outcome           |
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

Scheduled task lifecycle by task id.

```text
dataset=logs query='app.task.id:"<task_id>"'
fields=timestamp,event.name,app.task.id,app.task.run.id,app.dispatch.id,app.task.schedule.kind,app.task.destination.visibility,app.task.result_message_ts,messaging.destination.name
sort=timestamp
```

Scheduled task fire path by channel.

```text
dataset=logs query='event.name:scheduled_task.run.dispatched messaging.destination.name:"<channel_id>"'
fields=timestamp,event.name,app.task.id,app.task.run.id,app.dispatch.id,app.task.schedule.kind,app.task.destination.visibility
sort=-timestamp
```

Recent scheduled-task create/fire outcomes.

```text
dataset=logs query='event.name:scheduled_task.create.completed OR event.name:scheduled_task.run.claimed OR event.name:scheduled_task.run.dispatched OR event.name:scheduled_task.run.completed OR event.name:scheduled_task.run.failed OR event.name:scheduled_task.run.blocked OR event.name:scheduled_task.run.skipped'
fields=timestamp,event.name,app.task.id,app.task.run.id,app.dispatch.id,app.task.schedule.kind,app.task.status,messaging.destination.name
sort=-timestamp
```

Auth, credential, and resume failures.

```text
dataset=logs query='app.credential.provider:"<provider>"'
fields=timestamp,event.name,gen_ai.conversation.id,app.credential.provider,app.ai.retryable_reason,exception.message
sort=-timestamp
```

## Domains

### Webhook Ingress

Slack or Vercel webhook delivery/routing failures.

Events: `webhook.response.unsuccessful`, `webhook.handler.failed`,
`slack.event.persist.failed`, `slack.event.routing.failed`,
`slack.event.enqueue.failed`

Spans: `http.server.request`

Attributes: `http.request.method`, `http.response.status_code`, `url.path`,
`app.request.id`

### Slack Delivery

Slack accepted the request but no final reply appeared.

Events: `agent.turn.started`, `agent.turn.completed`, `agent.turn.failed`,
`slack.thread.post.failed`, `assistant.status.update.failed`,
`slack.action.failed`, `slack.action.retrying`

Spans: `chat.turn`, `chat.reply`, `chat.slash_command`,
`chat.app_home_opened`, `chat.app_home_disconnect`

Attributes: `trace_id`, `span_id`, `gen_ai.conversation.id`,
`messaging.message.conversation_id`, `messaging.destination.name`,
`app.slack.reply_stage`, `app.slack.error_code`, `app.slack.api_error`

### Agent And Model

The turn timed out, returned no useful answer, or used unexpected reasoning.

Events: `agent.message.received`, `agent.message.generated`,
`agent.turn.timed_out`,
`agent.turn.provider_error`, `agent.turn.execution.failed`,
`agent.turn.empty_output.retrying`,
`agent.turn.empty_output.exhausted`, `assistant.reply.generation.failed`,
`guardian.action_review.retrying`, `guardian.action_review.exhausted`

`guardian.action_review.exhausted` is a tool-boundary Sentry capture after three
consecutive action-review denials. The agent still receives a normal tool
rejection that says not to keep retrying.

Spans: `ai.generate_assistant_reply`, `ai.chat_completion`,
`chat.route_thinking`, `gen_ai.invoke_agent`, `gen_ai.chat`

Attributes: `gen_ai.operation.name`, `gen_ai.request.model`,
`gen_ai.response.finish_reasons`, `app.ai.outcome`,
`app.ai.reasoning_effort`, `app.ai.model_profile`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.input_tokens.cached`,
`gen_ai.usage.input_tokens.cache_write`, `app.ai.reasoning_tokens`,
`app.ai.empty_output.attempt`, `app.ai.provider_error.kind`,
`app.guardian.review_attempt`,
`app.ai.cost.input_usd`, `app.ai.cost.output_usd`,
`app.ai.cost.cache_read_usd`, `app.ai.cost.cache_write_usd`,
`app.ai.cost.total_usd`

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
`app.sandbox.snapshot.resolve_outcome`, `app.sandbox.search.raw_output_bytes`,
`app.sandbox.search.parsed_records`,
`app.sandbox.search.result_count`, `app.sandbox.search.emitted_lines`,
`app.sandbox.search.result_bytes`, `app.sandbox.search.limit`,
`app.sandbox.search.limit_reached`, `app.tool.missing_annotations`

### Scheduled Tasks

A reminder or recurring task was created, claimed, dispatched, completed, or
failed without an obvious Slack error.

Events: `scheduled_task.create.completed`, `scheduled_task.run.claimed`,
`scheduled_task.run.dispatched`, `scheduled_task.run.completed`,
`scheduled_task.run.failed`, `scheduled_task.run.blocked`,
`scheduled_task.run.skipped` (heartbeat `shouldSkipRun` and claim-time late/stale
skips), `scheduled_tasks.heartbeat.dispatched`,
`scheduled_tasks.heartbeat.failed`, `task.execution.stat_failed`

Spans: create-turn `gen_ai.execute_tool` for `slackScheduleCreateTask`; fire
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
`sandbox.egress.credential.unavailable`, `plugin.credential.rejected`,
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

| Setting                     | Controls                 | Default                       |
| --------------------------- | ------------------------ | ----------------------------- |
| `SENTRY_DSN`                | Sentry ingestion         | disabled                      |
| `SENTRY_ENVIRONMENT`        | Sentry environment       | `VERCEL_ENV` or `NODE_ENV`    |
| `SENTRY_RELEASE`            | Sentry release           | `<Junior version>+<VERCEL_GIT_COMMIT_SHA>` |
| `SENTRY_ENABLE_LOGS`        | structured logs          | true when `SENTRY_DSN` is set |
| `SENTRY_TRACES_SAMPLE_RATE` | traces                   | `1`                           |
| `SENTRY_ORG_SLUG`           | Slack footer trace links | unset                         |
| `JUNIOR_LOG_FORMAT`         | console format           | compact unless `structured`   |
