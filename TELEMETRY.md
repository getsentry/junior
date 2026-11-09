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
- `mcp.tool_call.completed` is an audit event for each successful call to a
  tool in a plugin's `mcp.audit-tools`. `app.credential.account` is
  `service_account` or `actor`.

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

MCP audit tool calls, with the account that made them.

```text
dataset=logs query='app.log.audit:true event.name:mcp.tool_call.completed'
fields=timestamp,user.id,app.actor.type,app.task.id,gen_ai.conversation.id,app.plugin.name,gen_ai.tool.name,app.credential.account
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
| Vercel firewall challenged egress    | `sandbox.egress.challenged`, span `bash`                                                                     |
| Tool calls ran one at a time         | `agent.tool_batch.started`, `app.sandbox.bash.wait_ms` on span `bash`                                        |
| Auth signal missed by a command      | `sandbox.egress.auth_signal.missing`, span `bash`                                                            |
| Skill or plugin missing              | `startup.discovery.completed`, `plugin.*`, `skill.*`, span `plugin.hook`                                     |
| Memory recall slow, empty, or noisy  | `app.memory.recall.*` on span `plugin.hook` (`userPrompt`), span `gen_ai.rerank`, `plugin.log.warn`          |
| Attachment or web search failure     | `attachment.*`, `image.attachment.*`, `conversation.image.*`, `web.search.failed`                            |
| Model request slow before gateway    | `app.ai.http.*`, `app.ai.event_loop.utilization` on span `gen_ai.chat`                                       |
| Prompt cache reset between calls     | `app.ai.request.*` hashes, `gen_ai.usage.cache_*` on span `gen_ai.chat`                                      |
| Slow or failed context compaction    | span `agent.context_compaction`, `app.compaction.*`, `app.turn.compaction_wait_ms` on `chat.turn`            |
| Slow or failing SQL                  | automatic `db` spans; group by `db.query.text` or `db.query.summary`; `app.db.transport`                     |
| Push notification missing or late    | `notification.*`, spans `plugin.task` (`notifyReply`), `notification.push.send`                              |

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

| Attribute                                      | Type   | Meaning                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------ |
| `app.codemode.script.bytes`                    | int    | script size in UTF-8 bytes                             |
| `app.codemode.call.count`                      | int    | nested calls made, including rejected calls            |
| `app.codemode.call.peak_concurrency`           | int    | most nested calls that ran at the same time            |
| `app.codemode.call.rejected_count`             | int    | nested calls not allowed by action review              |
| `app.codemode.call.batch_limit_rejected_count` | int    | nested calls refused by the per-drain batch limit      |
| `app.codemode.vm.start_ms`                     | int    | time until the VM was ready                            |
| `app.codemode.run_ms`                          | int    | time from VM ready until the result settled            |
| `app.codemode.output.bytes`                    | int    | script output and return value in UTF-8 bytes          |
| `app.codemode.error.kind`                      | string | `script`, `timeout`, `memory`, `aborted`, or `sandbox` |

- `app.codemode.vm.start_ms` and `app.codemode.run_ms` are absent when the VM
  did not start. `app.codemode.error.kind` is absent when the script returned
  a result. `memory` is a `script` failure from the VM heap limit.
- `gen_ai.tool.call.result.size` is the size of the result the model gets,
  after truncation.

## Tool Batches

`agent.tool_batch.started` logs each assistant message with two or more tool
calls. Pi runs the calls in parallel, unless one of the tools is
`sequential`. Then it runs all of them one at a time.

| Attribute                              | Type     | Meaning                                    |
| -------------------------------------- | -------- | ------------------------------------------ |
| `app.tool_batch.size`                  | int      | tool calls in the message                  |
| `app.tool_batch.execution`             | string   | `parallel` or `sequential`                 |
| `app.tool_batch.tool_names`            | string[] | tool names, in call order                  |
| `app.tool_batch.sequential_tool_names` | string[] | tools that made the batch run sequentially |

- `app.sandbox.bash.wait_ms` on span `bash` is the time the command waited for
  earlier bash commands of the same Run.
- `sandbox.egress.auth_signal.missing` means that the command output has the
  `junior-auth-required` marker, but the command read no auth signal.

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

### Cache Prefix

The provider caches a request prefix in the order tools, system prompt,
messages. A change to the tool list or the system prompt between two calls
writes the full history to the cache again. Per Anthropic's docs, a change to
the thinking settings or the effort also drops the cached prefix.
`chat/pi/request-prefix-attributes.ts` hashes the provider request body that
Pi builds, through Pi's `onPayload` hook. The values are hashes, never the
text.

| Attribute                                        | Type   | Meaning                                    |
| ------------------------------------------------ | ------ | ------------------------------------------ |
| `app.ai.request.system_instructions.hash`        | string | hash of the `system` blocks                |
| `app.ai.request.tools.hash`                      | string | hash of the `tools` list, in order         |
| `app.ai.request.tools.count`                     | int    | tools in the request                       |
| `app.ai.request.messages.hash`                   | string | hash of all `messages`                     |
| `app.ai.request.messages.before_last_reply.hash` | string | hash of the messages before the last reply |
| `app.ai.request.messages.count`                  | int    | messages in the request                    |
| `app.ai.request.prefix.hash`                     | string | hash of model, settings, and all parts     |
| `app.ai.request.prefix.before_last_reply.hash`   | string | the same, with messages before last reply  |
| `app.ai.request.thinking.type`                   | string | `thinking.type`, such as `adaptive`        |
| `app.ai.request.effort`                          | string | `output_config.effort`, such as `high`     |
| `app.ai.request.images.count`                    | int    | image blocks in the request                |
| `app.ai.request.images.estimate`                 | int    | sum of the context estimate of each image  |
| `app.ai.request.images.unsized`                  | int    | images that used the flat per-image value  |

- Each hash is the first 16 hex chars of a SHA-256. The hashes leave out
  `cache_control`, because Pi moves the last breakpoint on each request. In
  messages, string `content` hashes as one text block, because Pi changes the
  last user message to that form.
- The hashes cover the body that Junior sends to AI Gateway, not the request
  that the gateway sends to the upstream provider.
- `prefix.hash` hashes, in this order: `model`, a hash of the `thinking` and
  `output_config` settings, and the tools, system, and messages hashes.
  `prefix.before_last_reply.hash` uses `messages.before_last_reply.hash` for
  the messages, and is absent when that hash is absent.
- `thinking.type` and `effort` are absent when the body does not set them.
- The `images.*` attributes are absent when the request has no image. They
  count image blocks in message content and in `tool_result` content. The
  estimate uses the rule of `estimateMessagesTokens` in
  `chat/services/token-estimate.ts`. Anthropic usage has no per-image split,
  so the estimate is the only per-image number. To check it, compare it with
  the change in `gen_ai.usage.input_tokens` from the previous call in the
  same `gen_ai.conversation.id`.
- `messages.before_last_reply.hash` stops before the last `assistant`
  message. It is absent when the request has no `assistant` message. When the
  history was only appended, it is equal to `messages.hash` of the previous
  call.
- The `codemode` tool description lists the script tools, so a script tool
  change also changes the tool hash.
- `completeText` calls have the same attributes. `completeObject` uses the AI
  SDK, which has no payload hook, so it has none.
- On calls through the Pi stream wrapper, `app.ai.usage.cache_write_1h` is the
  part of `gen_ai.usage.cache_creation.input_tokens` written with 1h
  retention. The rest used 5m retention.

To classify a cache miss, compare a call with the previous call in the same
`gen_ai.conversation.id`:

1. Compare `prefix.before_last_reply.hash` with the previous `prefix.hash`.
   When they are not equal, find the part that changed:
   - System or tools hash changed: Junior changed the prefix.
   - `thinking.type` or `effort` changed: the settings changed the prefix.
     When all part hashes match, the model or another thinking setting, such
     as a budget, changed.
   - `messages.before_last_reply.hash` is not equal to the previous
     `messages.hash`: Junior rewrote the history. This is expected when the
     call has `gen_ai.conversation.compacted`.
2. When they are equal and the gap is 5 minutes or more: the cache expired.
3. When they are equal and the gap is less than 5 minutes: the provider or the
   gateway did not use the cache.

Prefix hashes of each model call in a Conversation. Compare consecutive rows.

```text
dataset=spans query='span.op:gen_ai.chat gen_ai.conversation.id:"<conversation_id>"'
fields=timestamp,trace,gen_ai.request.model,app.ai.request.prefix.hash,app.ai.request.prefix.before_last_reply.hash,app.ai.request.system_instructions.hash,app.ai.request.tools.hash,app.ai.request.messages.hash,app.ai.request.messages.before_last_reply.hash,app.ai.request.thinking.type,app.ai.request.effort,gen_ai.conversation.compacted,gen_ai.usage.cache_read.input_tokens,gen_ai.usage.cache_creation.input_tokens
sort=timestamp
```

## Context Compaction

A compaction replaces the history when its estimate is above the threshold.
`chat/services/context-compaction-telemetry.ts` owns the span.

- Each compaction has one `agent.context_compaction` span. Its child
  `gen_ai.chat` span, with `gen_ai.prompt.name:junior.context_compaction`, is
  the summary call. It has the `gen_ai.usage.*` attributes.
- The span and all its children have `app.compaction.mode`. Group the summary
  `gen_ai.chat` spans by mode to compare duration and cache reads.
- `app.turn.compaction_wait_ms` on `chat.turn` is the time that the Turn
  waited on summary compactions in this execution slice. It is absent when no
  summary compaction ran.
- `app.turn.compaction_swap_wait_ms` on `chat.turn` is the time that the Turn
  waited on prepared-summary swaps, also when the swap was `not_ready` or
  `discarded`. It includes the wait for a running summary at the input
  limit. It is absent when no swap span ran.
- After each replacement, the next model request logs
  `context_compaction.next_request.completed` with
  `app.compaction.next_input.size` (provider-reported input, cache included),
  `app.compaction.threshold`, `app.compaction.mode`, and
  `app.compaction.next_input.over_threshold`. When it is `true`, the
  replacement did not get the history below the threshold.
- Sentry data scrubbing removes the values of attribute keys that contain
  `token`. So these keys do not contain it, but the estimates count tokens.

Attributes on the `agent.context_compaction` span:

| Attribute                             | Type   | Meaning                                       |
| ------------------------------------- | ------ | --------------------------------------------- |
| `app.compaction.mode`                 | string | `blocking`, `active`, `background`            |
| `app.compaction.outcome`              | string | `compacted`, `skipped`, or `summary_failed`   |
| `app.compaction.skip_reason`          | string | why no summary was made above the threshold   |
| `app.compaction.input.estimate`       | int    | estimated history tokens before compaction    |
| `app.compaction.replacement.estimate` | int    | estimated request tokens after compaction     |
| `app.compaction.threshold`            | int    | estimated tokens that start a compaction      |
| `app.compaction.input_limit`          | int    | most estimated input tokens that a model gets |
| `app.compaction.input_messages`       | int    | history messages before compaction            |
| `app.compaction.retained_messages`    | int    | history messages kept with the summary        |
| `app.compaction.summary_chars`        | int    | summary length in characters                  |

- `app.compaction.replacement.estimate` counts the system prompt, tool
  definitions, and the characters of each message. It ignores provider usage
  on kept messages, because that usage counts the history before compaction.
- `blocking` runs in the agent before the first model request of a Turn.
  `active` runs between model calls in a Turn.
- `app.compaction.skip_reason`: `over_target` (the context that a
  replacement keeps is above the target without a summary),
  `last_over_threshold` (the first model call after the latest full
  compaction was above the threshold), or `over_input_limit` (the context
  that a replacement keeps is at the input limit, so no summary can fit). A
  compaction skipped for one of the first two reasons runs at the input limit.

A swap of a prepared background summary has its own
`agent.context_compaction` span and makes no model call.
`chat/services/context-compaction-swap.ts` owns it. The mode tells the swap
point: `blocking` at Turn start, `active` between model calls. The span exists
only when the history is above the threshold and the current History version
has a background compaction request or result.

A request younger than 45 seconds is a running summary. Below the input
limit, the swap is `deferred` and no blocking summary runs. At the input
limit, the swap polls until the summary has a result or the 45 seconds end.

| Attribute                         | Type   | Meaning                                          |
| --------------------------------- | ------ | ------------------------------------------------ |
| `app.compaction.outcome`          | string | `applied`, `deferred`, `not_ready`, `discarded`  |
| `app.compaction.discard_reason`   | string | why a ready summary was not used                 |
| `app.compaction.prepared.age_ms`  | int    | time from the prepared summary to the swap       |
| `app.compaction.request.age_ms`   | int    | time from the pending request to the swap        |
| `app.compaction.wait.timed_out`   | bool   | the wait at the input limit ended with no result |
| `app.compaction.carried_messages` | int    | messages after the mark, kept after the summary  |
| `app.compaction.carried.estimate` | int    | estimated tokens of the carried messages         |
| `app.compaction.trimmed_results`  | int    | carried tool results cleared to a pointer        |
| `app.compaction.trimmed_chars`    | int    | characters that trimming removed                 |

- `deferred`: a running summary exists, and the next model call fits below
  the input limit. A later check swaps the summary in.
- `not_ready`: the request is older than 45 seconds, the job failed, or the
  wait ended. A blocking compaction can still follow at the threshold.
- `app.compaction.discard_reason`: `history_version_changed`,
  `over_target`, `conflict` (another replacement committed first), or
  `split_tool_call` (the mark falls between a tool call and its result).
- A swap also sets `app.compaction.input.estimate`,
  `app.compaction.replacement.estimate`, and `app.compaction.threshold`.

### Background Compaction

After each model request with a provider-reported input at or above the
mark, also in the middle of a Turn, the Turn writes `compaction_requested`
and logs `context_compaction.background.requested`. The mark is 70% of the
compaction threshold. A queue job then writes `compaction_prepared`. The job
has its own `agent.context_compaction` span with
`app.compaction.mode:background`. It runs in a new trace and adds no
`app.turn.compaction_wait_ms`.

| Attribute                        | Type   | Meaning                                          |
| -------------------------------- | ------ | ------------------------------------------------ |
| `app.compaction.outcome`         | string | `ready`, `failed`, `stale`, or `duplicate`       |
| `app.compaction.mark_seq`        | int    | last event seq that the summary covers           |
| `app.compaction.history_version` | int    | History version of the request                   |
| `app.compaction.input.size`      | int    | provider-reported input of the marked request    |
| `app.compaction.queue_wait_ms`   | int    | time from queue send to job start                |
| `app.compaction.ready_ms`        | int    | time from request to ready summary               |
| `app.compaction.summary_chars`   | int    | summary length in characters                     |
| `error.type`                     | string | failure label, also stored on the `failed` event |

- `stale`: the History was replaced before the job ran. `duplicate`: the
  request already has a result. Both write nothing.
- Failure labels: `timeout`, `snapshot_missing`, `provider_<kind>`,
  `summary_error`, and the summary failures `empty`, `max_tokens`,
  `missing_summary`, `tool_call`.

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

## Thread Context

Each Turn prompt gets one `<thread-context>` block.
`chat/conversations/thread-context.ts` sets these attributes when it builds
the block: on `chat.reply` in a Slack Turn, on `chat.turn` in a web or Event
Turn. The block holds only the Messages since the
previous Turn when agent history exists.

| Attribute                             | Type   | Meaning                                                   |
| ------------------------------------- | ------ | --------------------------------------------------------- |
| `app.thread_context.chars`            | int    | characters of the block, 0 when there is none             |
| `app.thread_context.shown_messages`   | int    | Messages in the block                                     |
| `app.thread_context.omitted_messages` | int    | Messages left out by the 60,000-character cap             |
| `app.thread_context.cursor`           | string | `found`, `missing` (Turn before cursors), or `no_history` |
| `app.thread_messages.trimmed`         | int    | oldest Messages dropped from the loaded window            |

- `app.thread_messages.trimmed` is set in Turn preparation, only when the
  loaded Messages pass the trim threshold. Trimming makes no model call.

## Invariants

- `slack.message.ingress` records sender, team, and `app.slack.membership`
  (`verified`, `unverified`, `not_checked`) before membership checks. Identity
  fields record `missing` or `invalid`, never message text, names, or emails.
  These attributes are only on ingress spans.
- On `queue.*` spans, `messaging.*` describes the Vercel Queue, not Slack.
  They follow the Sentry queue span conventions. `queue.process` starts a new
  trace.
- `chat.turn` continues the trace of the oldest input: the
  `slack.message.ingress` span, or the dashboard `http.server` request that
  sent the Message. It links to the other inputs and to `queue.process`. A
  resumed slice continues the trace of the first slice. An Event Turn has no
  input trace, so its `chat.turn` is a child of `queue.process`.
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
- When no idle Neon pool client is free, a query outside a transaction runs
  over Neon's HTTP endpoint. Its `db` span has `app.db.transport: http`. A
  `db` span without the attribute ran on a WebSocket client.
- Server spans and errors keep no URL query strings, fragments, request
  bodies, or credential headers. Sandbox egress paths show `<token>`.
- A mention turn calls `reactions.add` two times and gets `already_reacted`.
  #2318 tracks it.

## Plugin Tasks and Notifications

- A `plugin.task` span runs each plugin task. `app.plugin.name`,
  `app.plugin.task`, and `app.ai.turn.session_id` name the task and the
  Turn. A web or Event Turn runs its tasks in its `chat.turn`, before the
  queue message is acknowledged. A Slack Turn queues its tasks, so each task
  is in its own trace. Find its Turn by `gen_ai.conversation.id`.
- On `plugin.task` `notifyReply`, `app.notification.outcome` is `sent` or
  `skipped`. `app.notification.skip_reason` says why it skipped, such as
  `outside_hours`, `slack_paused`, or `has_location`. When Junior cannot read
  a Slack notification schedule, `slack.action.failed` logs the Slack error
  with `app.slack.action` `dnd.info`. A sent task has device counts and
  `app.notification.reply_lag_ms`: the time from the completed Turn to the
  end of the pushes.
- A `notification.push.send` span sends to one browser. `server.address` is
  the push service host. `app.notification.push.outcome` is `delivered`,
  `gone` (the subscription is deleted), or `failed`. Spans, logs, and errors
  keep no endpoint path, because the path identifies the device.
- `notification.push.sent` logs the counts for one notification.
  `app.notification.kind` is `reply` or `test`.

Reply notification outcomes and lag.

```text
dataset=spans query='span.op:plugin.task app.plugin.task:notifyReply'
fields=app.notification.outcome,app.notification.skip_reason,count(),p50(app.notification.reply_lag_ms),p95(app.notification.reply_lag_ms),p95(span.duration)
```

Push service latency and failures by host.

```text
dataset=spans query='span.op:notification.push.send'
fields=server.address,app.notification.push.outcome,count(),p50(span.duration),p95(span.duration)
```

## Dashboard

- When `SENTRY_DSN` is set, dashboard pages send browser spans to the same
  project. The `pageload` span continues the trace of the page request, and
  dashboard API calls continue the browser trace.
- The browser sends only spans and Reply ratings. It sends no errors,
  breadcrumbs, or replays.
- A Reply rating is Sentry user feedback with `source`
  `dashboard_reply_rating`. Tags: `app.reply.rating` (`good` or `bad`),
  `gen_ai.conversation.id`, and `messaging.message.id`. It has the reader's
  name and email, and the message is `Good reply` or `Bad reply`, plus the
  reader's optional comment on a bad rating. It has no Reply text. Each Reply
  sends at most one rating each time the reader opens its Conversation. The
  dashboard hides the thumbs when it has no DSN.
- Browser spans keep no URL query strings or fragments, and no element
  `aria-label`, `title`, `alt`, `name`, or `type` values.
- `pageload` and `navigation` spans have the dashboard route pattern as their
  name, such as `/conversations/:conversationId`.
- A `ui.render` span named `Conversation transcript shown` goes from the start
  of the `pageload` or `navigation` span to the first render of the
  Conversation transcript. `app.dashboard.load` is `pageload` or `navigation`.
  Use it for the open time of a Conversation: the `pageload` or `navigation`
  span ends only when all requests on the page stop, side panels included.
- `app.dashboard.navigation.pre_fetch_ms` on a `pageload` span is the time
  before the browser fetched the page. Sign-in redirects add to it.
- A browser `http.client` span ends when the response headers arrive. A
  `deserialize` span named `Read API response` goes from there to the
  validated value: body download, `JSON.parse`, and the schema check.
  `app.dashboard.response.json_parse_ms` and
  `app.dashboard.response.schema_parse_ms` time the last two, and
  `app.dashboard.response.chars` is the body length. `url.path` is the API
  path. The span is sent only while a `pageload` or `navigation` is open, so
  polls after it add no spans.
- Sign-in redirects are their own traces. On `GET /auth/login`,
  `app.sign_in.session_cookie` is `present` when the browser sent a session
  cookie that the server did not accept, and `missing` when it sent none. On
  the Google callback, `app.sign_in.previous_age_s` is the time since this
  identity last signed in. A value below the session lifetime (8 hours by
  default) means the browser lost its session before it expired.
- A browser `http.client` span minus its child `http.server` span is the time
  outside the function: network round trip and Vercel routing. Compare it by
  `user.geo.country_code` on the `pageload` span.
- In dashboard `http.server` spans, `function` spans time work on the
  request thread between queries. The detail route has these:
  - `Decode conversation events`
  - `Project conversation events`
  - `Attach conversation mentions`
  - `Project conversation detail`
  - `Validate conversation detail`
- A `serialize` span named `Write API response` validates and serializes
  each JSON response. `app.api.response.schema_parse_ms`,
  `app.api.response.json_stringify_ms`, and `app.api.response.chars` split
  it.
- Request time that no span covers is other request-thread work, or the
  event loop running other requests on the same `service.instance.id`.
- A browser request after the `pageload` or `navigation` span ends, such as
  a poll, is its own `http.client` segment. Add `!span.op:http.client` to
  segment queries to leave them out.
- A versions poll that moves a change token adds a `function` span named
  `Refresh changed reads`. `app.dashboard.versions.moved` lists the tokens
  that moved, such as `conversations,reviewItems`. A poll that moves none
  adds no span, so compare the count with the `/api/versions` polls.
- When `conversations` moves, `app.dashboard.versions.feed_moved` lists the
  feed-row inputs that moved it: `order`, `pin`, `title`, `status`,
  `activity` (the minute of last activity), `messages` (the newest Message
  of each role), `unread`, `threads`, and `annotations`. A Conversation that
  joins or leaves the first page moves `order` and the inputs of its row.
- `http.server` spans have the route pattern of the app that served the
  request, also when the core app passes the request to the dashboard or a
  plugin app. Plugin API routes are `/api/plugins/<plugin>/*`. Sandbox egress
  is `/api/internal/sandbox-egress/<token>`.

Conversation open time, by the transcript render.

```text
dataset=spans query='span.op:ui.render span.name:"Conversation transcript shown"'
fields=app.dashboard.load,count(),p50(span.duration),p95(span.duration)
```

Dashboard API response read time by path.

```text
dataset=spans query='span.op:deserialize span.name:"Read API response"'
fields=url.path,count(),p50(span.duration),p95(span.duration)
sort=-count()
```

Versions polls that refresh a read, by the tokens that moved.

```text
dataset=spans query='span.name:"Refresh changed reads"'
fields=app.dashboard.versions.moved,count()
sort=-count()
```

Feed-row inputs that moved the feed token.

```text
dataset=spans query='span.name:"Refresh changed reads" has:app.dashboard.versions.feed_moved'
fields=app.dashboard.versions.feed_moved,count()
sort=-count()
```

Dashboard page load and navigation time by route.

```text
dataset=spans query='span.op:[pageload,navigation] is_transaction:true'
fields=span.op,span.name,count(),p50(span.duration),p95(span.duration)
sort=-count()
```

Server response serialization by route.

```text
dataset=spans query='span.op:serialize span.name:"Write API response"'
fields=transaction,count(),p50(span.duration),p95(span.duration),p95(app.api.response.chars)
sort=-count()
```

Why people sign in again.

```text
dataset=spans query='span.op:http.server transaction:"GET /auth/login" has:app.sign_in.session_cookie'
fields=app.sign_in.session_cookie,count()
```

Dashboard API latency by route.

```text
dataset=spans query='span.op:http.server is_transaction:true span.name:"GET /api/*"'
fields=span.name,count(),p50(span.duration),p95(span.duration)
sort=-count()
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
