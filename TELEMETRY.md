# Telemetry

Stable telemetry names and the pivots for a Junior investigation.
`policies/observability.md` owns the naming rules. The owner in the Domains
table documents its attributes and how to read them. Paths are under
`packages/junior/src/` unless they name a package.

## Investigation Pivots

| Pivot                               | Meaning                      | Found in                    |
| ----------------------------------- | ---------------------------- | --------------------------- |
| `event_id`                          | captured Sentry error        | failure notice in Slack     |
| `trace_id` / `span_id`              | one trace / one span         | errors, logs, spans         |
| `gen_ai.conversation.id`            | Conversation                 | Slack footer, logs, spans   |
| `messaging.message.conversation_id` | Slack thread                 | logs, spans                 |
| `messaging.message.id`              | Slack message ts or queue id | logs, spans                 |
| `messaging.destination.name`        | Slack channel or queue topic | logs, spans                 |
| `event.name`                        | one stable event structure   | logs                        |
| `gen_ai.tool.name`                  | tool                         | `gen_ai.execute_tool` spans |
| `gen_ai.request.model`              | model                        | `gen_ai.chat` spans         |
| `gen_ai.response.id`                | AI Gateway generation id     | `gen_ai.chat` spans         |
| `service.instance.id`               | one Junior process           | logs, spans                 |
| `user.id`                           | accountable person           | logs, spans, errors         |
| `app.credential.provider`           | auth provider                | auth logs                   |
| `app.task.id` / `app.task.run.id`   | automation / one run         | task lifecycle logs         |
| `app.dispatch.id`                   | agent dispatch               | task and dispatch logs      |
| `app.review_item.id`                | Review item                  | review desk, delivery logs  |

- A fire Conversation uses `agent-dispatch:<dispatch_id>` as
  `gen_ai.conversation.id`.
- Production keeps only warnings and audit info events (`app.log.audit:true`),
  so most diagnostic counts are span attributes.

## Identity and Audit

Runs, resumes, and the sandbox egress proxy bind the same identity
attributes. Nested logs and spans inherit them.

- `user.*`: the accountable person. For a system Actor, this is the owner of
  delegated credentials, such as the Automation creator.
- `app.actor.type` (`user` or `system`), `app.actor.id`: who acted.
- `app.credential.allowed_when`, `app.task.id`: why delegated credentials were
  allowed, and for which Automation.
- `app.source.kind`, `app.task.id`, and `app.task.run.id` name the run Source.
- Each egress decision logs one event with `app.egress.policy.decision`
  (`allowed` or `denied`). A denial adds `app.sandbox.egress.policy.reason`.
- `sandbox.egress.upstream.requested` (audit) is each forwarded request.
  `app.credential.account` is `actor` (a person's OAuth token) or `app` (a
  credential that Junior owns). Plugins add `app.<provider>.*` facts, such as
  `app.github.repository`.
- `mcp.tool_call.completed` (audit) is each successful MCP tool call.
  `app.credential.account` is `service_account` or `actor`.

## Domains

| Symptom                              | Events and spans                                                                                     | Owner                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Webhook not routed                   | `webhook.*`, `slack.event.*`, span `slack.message.ingress`                                           | `chat/ingress/slack-webhook.ts`                                 |
| Queued but late, repeated, or no-op  | `conversation.queue.*`, `conversation.work.*`, spans `queue.publish`, `queue.process`                | `chat/task-execution/`                                          |
| No final Slack reply                 | `agent.turn.*`, `slack.thread.post.failed`, `slack.action.*`, spans `chat.turn`, `chat.reply`        | `chat/providers/slack/`                                         |
| Timeout, empty answer, bad reasoning | `agent.turn.*`, spans `gen_ai.invoke_agent`, `gen_ai.chat`, `agent.step.prepare`                     | `chat/agent/`                                                   |
| Automation run posted nothing        | `app.turn.answer` on `agent.message.generated`, `agent.turn.answer.*`                                | `chat/services/turn-result.ts`                                  |
| Slow or wrong action review          | `guardian.action_review.*`, span `guardian.action_review`, `app.guardian.*` on `gen_ai.execute_tool` | `chat/guardian/gate.ts`                                         |
| Tool, MCP, or sandbox failure        | `agent.tool_call.failed`, `mcp.*`, `sandbox.*`, spans `gen_ai.execute_tool`, `sandbox.*`, `bash`     | `chat/tool-support/`, `chat/sandbox/`                           |
| Code Mode script slow or failed      | `app.codemode.*` on `gen_ai.execute_tool` (`codemode`), nested `gen_ai.execute_tool` spans           | `chat/codemode/telemetry.ts`                                    |
| Tool calls ran one at a time         | `app.tool_batch.*` on `gen_ai.invoke_agent`, `app.sandbox.bash.wait_ms` on `bash`                    | `chat/agent/tool-batch.ts`                                      |
| Automation did not run or post       | `scheduled_automation.*`, `scheduled_automations.heartbeat.*`, `automation.blocked_notice.failed`    | `chat/scheduled-automations/`                                   |
| Review item change not delivered     | `review_item.*`, span `review_item.deliver`                                                          | `chat/review-items/`                                            |
| Auth parked or resume failed         | `sandbox.egress.credential.*`, `oauth.*`, `agent.continue.*`, `mcp.oauth_callback.failed`            | `chat/oauth-flow.ts`, `handlers/`                               |
| Egress denied, challenged, or missed | `sandbox.egress.policy.denied`, `sandbox.egress.challenged`, `sandbox.egress.auth_signal.missing`    | `chat/sandbox/sandbox.ts`                                       |
| Skill or plugin missing              | `startup.discovery.completed`, `plugin.*`, `skill.*`, span `plugin.hook`                             | `chat/plugins/`                                                 |
| Memory recall slow, empty, or noisy  | `app.memory.recall.*` on `plugin.hook` (`userPrompt`), span `gen_ai.rerank`                          | `packages/junior-memory`                                        |
| Attachment or web search failure     | `attachment.*`, `image.attachment.*`, `conversation.image.*`, `gen_ai.execute_tool` (`webSearch`)    | `chat/slack/vision-context.ts`                                  |
| Model request slow before gateway    | `app.ai.http.*`, `app.ai.event_loop.utilization` on `gen_ai.chat`                                    | `chat/pi/gateway-request-timing.ts`                             |
| Prompt cache reset between calls     | `app.ai.request.*` hashes, `gen_ai.usage.cache_*` on `gen_ai.chat`                                   | `chat/pi/request-prefix-attributes.ts`                          |
| Cache warmup cost or misses          | spans `cache_warming.warmup`, `cache_warming.backfill`, `app.cache_warming.*`                        | `chat/cache-warming/warmup.ts`                                  |
| Slow or failed context compaction    | span `agent.context_compaction`, `app.compaction.*`, `app.turn.compaction_wait_ms` on `chat.turn`    | `chat/services/context-compaction-*.ts`                         |
| Thread context too big or missing    | `app.thread_context.*` on `chat.reply` or `chat.turn`                                                | `chat/conversations/thread-context.ts`                          |
| Slow or failing SQL                  | automatic `db` spans; group by `db.query.text`; `app.db.transport`                                   | `db/neon.ts`                                                    |
| Push notification missing or late    | `notification.*`, spans `plugin.task` (`notifyReply`), `notification.push.send`                      | `chat/notifications/`                                           |
| Dashboard page or API slow           | `pageload`, `navigation`, `ui.render`, `deserialize`, `serialize`, `function` spans                  | `packages/junior-dashboard/src/client/sentry.ts`, `api/http.ts` |

## Trace Shape

- `slack.message.ingress` records sender, team, and `app.slack.membership`
  before membership checks, never message text, names, or emails.
- On `queue.*` spans, `messaging.*` describes the Vercel Queue, not Slack.
  `queue.process` starts a new trace.
- `chat.turn` continues the trace of its oldest input and links to the
  others and to `queue.process`. An Event Turn is a child of `queue.process`.
- A Slack Turn queues its plugin tasks, so each `plugin.task` is in its own
  trace. Find it by `gen_ai.conversation.id`.
- For the sandbox cost of a Turn, add only the top-level `sandbox.*` spans
  under its `chat.turn`.
- A `db` span with `app.db.transport: http` ran over Neon's HTTP endpoint. One
  without it ran on a WebSocket client. `db.query.text` keeps placeholders.
- Server spans and errors keep no URL query strings, fragments, request
  bodies, or credential headers. Sandbox egress paths show `<token>`.

## Query Recipes

A numeric `app.*` attribute needs the `tags[<key>,number]` form in queries.

Conversation timeline from a Slack thread, footer link, or conversation ID.

```text
dataset=spans query='gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,trace,span.op,span.description,span.duration,error.type
sort=-timestamp
```

Conversation or trace log history. Use `trace_id:"<trace_id>"` for a trace.

```text
dataset=logs query='gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,level,event.name,trace_id,span_id,error.type,exception.message
sort=timestamp
```

Recent failed or timed-out agent runs.

```text
dataset=logs query='event.name:agent.turn.timed_out OR event.name:agent.turn.failed OR event.name:agent.turn.provider_error'
fields=timestamp,event.name,trace_id,gen_ai.conversation.id,gen_ai.request.model,error.type
sort=-timestamp
```

Tool failures or slow tool calls. Code Mode nested calls also match.

```text
dataset=spans query='span.op:gen_ai.execute_tool gen_ai.tool.name:"<tool_name>"'
fields=timestamp,trace,span.duration,gen_ai.conversation.id,gen_ai.tool.call.result.size,error.type
sort=-timestamp
```

Slack delivery failures after the agent turn ran.

```text
dataset=logs query='event.name:slack.thread.post.failed app.slack.error_code:*'
fields=timestamp,gen_ai.conversation.id,messaging.destination.name,app.slack.reply_stage,app.slack.error_code,app.slack.api_error
sort=-timestamp
```

Scheduled automation lifecycle by task id.

```text
dataset=logs query='app.task.id:"<task_id>"'
fields=timestamp,event.name,app.task.run.id,app.dispatch.id,app.task.schedule.kind,app.task.status,messaging.destination.name
sort=timestamp
```

Provider egress decisions, with whose authority they used.

```text
dataset=logs query='has:app.egress.policy.decision'
fields=timestamp,event.name,app.egress.policy.decision,app.sandbox.egress.policy.reason,user.id,app.actor.type,app.credential.account,app.source.kind,app.task.id,app.provider.name,http.request.method,server.address,url.path
sort=-timestamp
```

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
