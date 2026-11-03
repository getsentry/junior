# Telemetry

Stable telemetry names and the pivots for a Junior incident investigation.
`policies/observability.md` owns the naming rules, emission, and data safety.
The code that emits a signal owns its full attribute list.

## Investigation Pivots

Start from what you have. Query Sentry Logs and Spans with the pivot, then
move to the domain below.

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
- Production keeps only audit info events (`app.log.audit:true`), such as
  `sandbox.egress.upstream.requested` for write grants. Outside production,
  that event is logged for every forwarded request.

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

Code Mode scripts, with their nested call counts and failures.

```text
dataset=spans query='span.op:gen_ai.execute_tool gen_ai.tool.name:codemode'
fields=timestamp,trace,span.duration,gen_ai.conversation.id,app.codemode.call.count,app.codemode.call.peak_concurrency,app.codemode.call.rejected_count,app.codemode.run_ms,app.codemode.error.kind
sort=-timestamp
```

Automatic memory recall outcomes, next to the hook latency. The
`app.memory.recall.*` attributes are on recalls that reached the reranker.
The child `gen_ai.rerank` span has the reranker latency and `error.type`.

```text
dataset=spans query='span.op:plugin.hook app.plugin.hook:userPrompt app.plugin.name:memory app.memory.recall.candidate.count:*'
fields=timestamp,trace,span.duration,app.memory.recall.candidate.count,app.memory.recall.admitted.count,app.memory.recall.injected.count,app.memory.recall.score.max
sort=-timestamp
```

Nested tool calls from Code Mode scripts.

```text
dataset=spans query='span.op:gen_ai.execute_tool gen_ai.tool.dispatcher.name:codemode'
fields=timestamp,trace,gen_ai.tool.name,gen_ai.tool.call.id,span.duration,app.guardian.decision,error.type
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

Slow model requests, with the phases before the gateway saw them. See
[Model Requests](#model-requests).

```text
dataset=spans query='span.op:gen_ai.chat gen_ai.response.time_to_first_chunk:>5'
fields=timestamp,trace,gen_ai.response.id,service.instance.id,app.ai.http.queue_ms,app.ai.http.connect_ms,app.ai.http.body_send_ms,app.ai.http.response_wait_ms,app.ai.event_loop.utilization,app.ai.gateway.vercel_id
sort=-timestamp
```

Auth, credential, and resume failures.

```text
dataset=logs query='app.credential.provider:"<provider>"'
fields=timestamp,event.name,gen_ai.conversation.id,app.credential.provider,app.ai.retryable_reason,exception.message
sort=-timestamp
```

## Identity

Runs, resumes, and the sandbox egress proxy bind the same identity
attributes. Nested logs and spans inherit them.

- `user.*`: the accountable person. For a system Actor, this is the owner of
  delegated credentials, such as the Automation creator. It is empty when a
  system run has no delegated credentials.
- `app.actor.type` (`user` or `system`), `app.actor.id`: who acted.
- `app.credential.allowed_when`, `app.task.id`: why delegated credentials were
  allowed, and for which Automation.
- Do not add app-specific keys under `user.*`. Put request facts in `app.*`.

## Domains

| Symptom                              | Events and spans                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Webhook not routed                   | `webhook.*`, `slack.event.*`, span `slack.message.ingress`                                                   |
| Queued but late, repeated, or no-op  | `conversation.queue.*`, `conversation.work.*`, spans `queue.publish`, `queue.process`                        |
| No final Slack reply                 | `agent.turn.*`, `slack.thread.post.failed`, `slack.action.*`, spans `chat.turn`, `chat.reply`                |
| Timeout, empty answer, bad reasoning | `agent.turn.*`, `guardian.action_review.*`, spans `gen_ai.invoke_agent`, `gen_ai.chat`, `agent.step.prepare` |
| Slow or wrong action review          | `guardian.action_review.*`, span `guardian.action_review`, `app.guardian.*` on `gen_ai.execute_tool`         |
| Tool, MCP, or sandbox failure        | `agent.tool_call.failed`, `mcp.*`, `sandbox.*`, spans `gen_ai.execute_tool`, `sandbox.*`, `bash`             |
| Code Mode script slow or failed      | `app.codemode.*` on span `gen_ai.execute_tool` (`codemode`), nested `gen_ai.execute_tool` spans              |
| Automation did not run or post       | `scheduled_automation.*`, `scheduled_automations.heartbeat.*`, `automation.blocked_notice.failed`            |
| Review item change not delivered     | `review_item.*`, span `review_item.deliver`                                                                  |
| Auth parked or resume failed         | `sandbox.egress.credential.*`, `oauth.callback.resume.*`, `agent.continue.*`, `mcp.oauth_callback.failed`    |
| Skill or plugin missing              | `startup.discovery.completed`, `plugin.*`, `skill.*`, span `plugin.hook`                                     |
| Memory recall slow, empty, or noisy  | `app.memory.recall.*` on span `plugin.hook` (`userPrompt`), span `gen_ai.rerank`, `plugin.log.warn`          |
| Attachment or web search failure     | `attachment.*`, `image.attachment.*`, `conversation.image.*`, `web.search.failed`                            |
| Model request slow before gateway    | `app.ai.http.*`, `app.ai.event_loop.utilization` on span `gen_ai.chat`                                       |
| Slow or failed context compaction    | span `agent.context_compaction`, `app.compaction.*`, `app.turn.compaction_wait_ms` on `chat.turn`            |
| Slow or failing SQL                  | automatic `db` spans; group by `db.query.text` or `db.query.summary`                                         |

## Code Mode

A `codemode` tool call runs one script in a QuickJS VM. The script calls other
tools. `codeModeSpanAttributes` in `chat/codemode/telemetry.ts` maps the
attributes below.

- The `codemode` call has one `gen_ai.execute_tool` span, with
  `gen_ai.tool.name:codemode`.
- Each nested call has its own `gen_ai.execute_tool` span, which is a child of
  the `codemode` span. It has the real `gen_ai.tool.name`, so the tool queries
  above also find calls from scripts.
- A nested span sets `gen_ai.tool.dispatcher.name:codemode`, as `executeTool`
  does for catalog tools. Its `gen_ai.tool.call.id` is
  `<codemode call id>/c<n>`, where `n` is the VM number for the call.
- A nested span keeps its own `app.guardian.*` decision. A nested failure logs
  `agent.tool_call.failed` with the nested call id.
- `withSpan` makes a child of the active span. pi-codemode reports calls in a
  worker callback, which can lose the async context. Run each nested call with
  the `codemode` span active (`Sentry.withActiveSpan`, as in
  `chat/pi/traced-stream.ts`).

Attributes on the `codemode` span:

| Attribute                                      | Type    | Meaning                                                |
| ---------------------------------------------- | ------- | ------------------------------------------------------ |
| `app.codemode.script.bytes`                    | int     | script size in UTF-8 bytes                             |
| `app.codemode.call.count`                      | int     | nested calls made, including rejected calls            |
| `app.codemode.call.peak_concurrency`           | int     | most nested calls that ran at the same time            |
| `app.codemode.call.rejected_count`             | int     | nested calls not allowed by action review              |
| `app.codemode.call.batch_limit_rejected_count` | int     | nested calls refused by the per-drain batch limit      |
| `app.codemode.vm.start_ms`                     | int     | time until the VM was ready                            |
| `app.codemode.run_ms`                          | int     | time from VM ready until the result settled            |
| `app.codemode.output.bytes`                    | int     | script output in UTF-8 bytes, before truncation        |
| `app.codemode.output.truncated`                | boolean | output was cut to the output limit                     |
| `app.codemode.error.kind`                      | string  | `script`, `timeout`, `memory`, `aborted`, or `sandbox` |

- `app.codemode.vm.start_ms` and `app.codemode.run_ms` are absent when the VM
  did not start. `app.codemode.error.kind` is absent when the script returned
  a result. `memory` is a `script` failure from the VM heap limit.
- `gen_ai.tool.call.result.size` is the size of the result the model gets,
  after truncation.

## Model Requests

A `gen_ai.chat` span covers one model call through AI Gateway. Its child
`http.client` span starts when undici creates the request.
`chat/pi/gateway-request-timing.ts` reads undici diagnostics channels and
writes the HTTP phases of the call onto the `gen_ai.chat` span.

| Attribute                       | Type    | Meaning                                                |
| ------------------------------- | ------- | ------------------------------------------------------ |
| `app.ai.http.attempt_count`     | int     | HTTP attempts, including Pi retries                    |
| `app.ai.http.queue_ms`          | int     | request created until headers written to the socket    |
| `app.ai.http.connection_reused` | boolean | the socket sent an earlier request                     |
| `app.ai.http.connect_ms`        | int     | DNS, TCP, and TLS time of a new socket                 |
| `app.ai.http.body_send_ms`      | int     | headers written until the body was sent                |
| `app.ai.http.response_wait_ms`  | int     | body sent until response headers arrived               |
| `http.request.body.size`        | int     | request body bytes                                     |
| `app.ai.event_loop.utilization` | double  | event loop utilization, span start to response headers |
| `app.ai.gateway.vercel_id`      | string  | `x-vercel-id` response header: Vercel edge POPs and id |
| `gen_ai.response.id`            | string  | AI Gateway generation id (`gen_...`)                   |

- The `app.ai.http.*` phases are from the last attempt only.
- `app.ai.http.connect_ms` is absent when the socket was reused. It is best
  effort: overlapping connects to the same host usually record none.
- With a new socket, `app.ai.http.queue_ms` includes the connect time.
- The gateway sends response headers with the first token. So
  `app.ai.http.response_wait_ms` includes the gateway time to first token.

To find where time went before the gateway saw a request, get the gateway
latency for `gen_ai.response.id` from the AI Gateway generation API. Then
compare the phases:

- High `queue_ms` on a reused socket, or high event loop utilization: Junior's
  process was busy or the connection pool was full.
- High `connect_ms`: DNS, TCP, or TLS was slow.
- High `body_send_ms`: the upload was slow.
- `response_wait_ms` much larger than the gateway time to first token, with
  small Junior phases: the delay was after Junior's socket, in the network or
  at the Vercel edge. Use `app.ai.gateway.vercel_id` with Vercel.
- The same `service.instance.id` on more than one slow call: they shared one
  process.

## Context Compaction

A compaction replaces the history when its estimate is above the threshold.
`chat/services/context-compaction-telemetry.ts` owns the span.

- Each compaction has one `agent.context_compaction` span. Its child
  `gen_ai.chat` span, with `gen_ai.prompt.name:junior.context_compaction`, is
  the summary call. It has the `gen_ai.usage.*` attributes.
- The span and all its children have `app.compaction.mode`. Group the summary
  `gen_ai.chat` spans by mode to compare duration and cache reads.
- `app.turn.compaction_wait_ms` on `chat.turn` is the time that the Turn
  waited on compaction in this execution slice. It is absent when no
  compaction ran.
- Sentry data scrubbing removes the values of attribute keys that contain
  `token`. So these keys do not contain it, but the estimates count tokens.

Attributes on the `agent.context_compaction` span:

| Attribute                             | Type   | Meaning                                       |
| ------------------------------------- | ------ | --------------------------------------------- |
| `app.compaction.mode`                 | string | `blocking`, `active`, or `handoff`            |
| `app.compaction.outcome`              | string | `compacted` or `summary_failed`               |
| `app.compaction.input.estimate`       | int    | estimated history tokens before compaction    |
| `app.compaction.replacement.estimate` | int    | estimated history tokens after compaction     |
| `app.compaction.threshold`            | int    | estimated tokens that start a compaction      |
| `app.compaction.input_limit`          | int    | most estimated input tokens that a model gets |
| `app.compaction.input_messages`       | int    | history messages before compaction            |
| `app.compaction.retained_messages`    | int    | messages kept before the summary              |
| `app.compaction.summary_chars`        | int    | summary length in characters                  |

- `blocking` runs at Turn start. `active` runs between model calls in a Turn.
  `handoff` runs for a model handoff.
- A `handoff` span has only `app.compaction.mode`. A failed handoff or an
  input above the limit sets `error.type`.

Summary call latency and cache reads by mode. In queries, a numeric `app.*`
attribute needs the `tags[<key>,number]` form.

```text
dataset=spans query='span.op:gen_ai.chat gen_ai.prompt.name:junior.context_compaction'
fields=app.compaction.mode,count(),p50(span.duration),p95(span.duration),sum(gen_ai.usage.input_tokens),sum(gen_ai.usage.cache_read.input_tokens)
```

Turn wait on compaction.

```text
dataset=spans query='span.op:chat.turn has:tags[app.turn.compaction_wait_ms,number]'
fields=count(),p50(tags[app.turn.compaction_wait_ms,number]),p95(tags[app.turn.compaction_wait_ms,number]),p50(span.duration)
```

## Invariants

- `slack.message.ingress` records sender, team, and `app.slack.membership`
  (`verified`, `unverified`, `not_checked`) before membership checks. Identity
  fields record `missing` or `invalid`, never message text, names, or emails.
  These attributes are only on ingress spans.
- On `queue.*` spans, `messaging.*` describes the Vercel Queue, not Slack.
  They follow the Sentry queue span conventions. `queue.process` starts a new
  trace.
- `chat.turn` continues the trace of the oldest input `slack.message.ingress`
  span and links to the other inputs and to `queue.process`. A resumed slice
  continues the trace of the first slice.
- `app.turn.delivery_lag_ms`, `app.turn.wait_ms`, and the `chat.turn` duration
  are contiguous. The timing attributes are absent when the value is negative
  (clock skew) and on resumed slices.
- `app.ai.time_to_first_byte_ms` counts to any stream event.
  `gen_ai.response.time_to_first_chunk` (seconds) counts to the first content
  block event.
- To find the sandbox cost of a turn, add only the top-level `sandbox.*` spans
  under its `chat.turn`.
- A `guardian.action_review` span covers the review of one batch of tool
  actions. `app.guardian.batch.size` counts each action in the batch, also
  actions that need no review. Its `gen_ai.chat` children are the reviews.
- `db.query.text` keeps placeholders. It never has parameter values or SQL
  comments.
- A mention turn calls `reactions.add` two times and gets `already_reacted`.
  #2318 tracks it.

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
