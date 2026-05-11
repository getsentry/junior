---
spec: ./TELEMETRY.spec.md
---

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

Recent failed or timed-out turns.

```text
dataset=logs query='event.name:agent_turn_timeout OR event.name:agent_turn_failed OR event.name:agent_turn_provider_error'
fields=timestamp,event.name,trace_id,span_id,gen_ai.conversation.id,gen_ai.request.model,error.type
sort=-timestamp
```

Tool failures or slow tool calls.

```text
dataset=spans query='span.op:gen_ai.execute_tool gen_ai.tool.name:"<tool_name>"'
fields=timestamp,trace,span.description,span.duration,gen_ai.conversation.id,error.type
sort=-timestamp
```

Slack delivery failures after the agent turn ran.

```text
dataset=logs query='event.name:slack_thread_post_failed app.slack.error_code:*'
fields=timestamp,event.name,gen_ai.conversation.id,messaging.destination.name,app.slack.reply_stage,app.slack.error_code,app.slack.api_error,exception.message
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

Events: `webhook_platform_unknown`, `webhook_non_success_response`,
`webhook_handler_failed`, `slack_message_changed_side_channel_failed`

Spans: `http.server.request`

Attributes: `http.request.method`, `http.response.status_code`, `url.path`,
`app.request.id`

### Slack Delivery

Slack accepted the request but no final reply appeared.

Events: `agent_turn_started`, `agent_turn_completed`, `agent_turn_failed`,
`slack_thread_post_failed`, `assistant_status_update_failed`,
`slack_action_failed`, `slack_action_retrying`

Spans: `chat.turn`, `chat.reply`, `chat.slash_command`,
`chat.app_home_opened`, `chat.app_home_disconnect`

Attributes: `trace_id`, `span_id`, `gen_ai.conversation.id`,
`messaging.message.conversation_id`, `messaging.destination.name`,
`app.slack.reply_stage`, `app.slack.error_code`, `app.slack.api_error`

### Agent And Model

The turn timed out, returned no useful answer, or used unexpected reasoning.

Events: `agent_message_in`, `agent_message_out`, `agent_turn_timeout`,
`agent_turn_provider_error`, `agent_turn_execution_failure`,
`assistant_reply_generation_failed`

Spans: `ai.generate_assistant_reply`, `ai.chat_completion`,
`chat.route_thinking`, `ai.invoke_advisor`

Attributes: `gen_ai.operation.name`, `gen_ai.request.model`,
`gen_ai.response.finish_reasons`, `app.ai.outcome`,
`app.ai.reasoning_effort`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_creation.input_tokens`

### Tools, MCP, And Sandbox

A tool failed, an MCP call failed, a command exited non-zero, or sandbox startup was slow.

Events: `agent_tool_call_failed`, `mcp_tool_call_failed`,
`mcp_tool_manager_close_failed`, `sandbox_boot_requested`,
`sandbox_network_policy_restore_failed`

Spans: `execute_tool <toolName>`, `sandbox.acquire`, `sandbox.create`,
`sandbox.snapshot.resolve`, `sandbox.sync_skills`, `bash`

Attributes: `gen_ai.tool.name`, `gen_ai.tool.call.id`, `mcp.method.name`,
`process.executable.name`, `process.exit.code`, `app.sandbox.source`,
`app.sandbox.snapshot.resolve_outcome`

### Auth And Resume

A turn parked for auth, resumed late, or failed after callback.

Events: `credential_issue_failed`, `credential_issue_request`,
`credential_issue_success`, `mention_handler_auth_pause`,
`subscribed_message_handler_auth_pause`, `timeout_resume_handler_failed`,
`timeout_resume_lock_busy`, `oauth_callback_resume_complete`,
`mcp_oauth_callback_failed`

Spans: resumed `chat.turn`, `chat.reply`

Attributes: `app.credential.provider`, `app.credential.delivery`,
`app.ai.retryable_reason`, `app.ai.session_id`,
`app.ai.resume_checkpoint_version`

### Skills And Plugins

A skill/tool is missing, plugin discovery failed, or capability activation looks wrong.

Events: `startup_discovery_summary`, `plugin_loaded`,
`capability_catalog_loaded`, `skill_directory_read_failed`,
`skill_frontmatter_invalid`, `plugin_root_read_failed`

Spans: active turn spans carry plugin/skill attributes

Attributes: `app.skill.name`, `app.skill.count`, `app.plugin.name`,
`app.plugin.count`, `app.plugin.has_mcp`, `app.capability.names`,
`file.directory`, `app.file.skill_directory`

### Attachments And Web Search

Screenshots, file attachments, image context, or web search failed.

Events: `attachment_resolution_failed`, `attachment_skipped_size_limit`,
`image_attachment_processing_failed`, `conversation_image_context_hydrated`,
`conversation_image_vision_failed`, `web_search_failed`

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
| `SENTRY_RELEASE`            | Sentry release           | `VERCEL_GIT_COMMIT_SHA`       |
| `SENTRY_ENABLE_LOGS`        | structured logs          | true when `SENTRY_DSN` is set |
| `SENTRY_TRACES_SAMPLE_RATE` | traces                   | `1`                           |
| `SENTRY_ORG_SLUG`           | Slack footer trace links | unset                         |
| `JUNIOR_LOG_FORMAT`         | console format           | compact unless `structured`   |
