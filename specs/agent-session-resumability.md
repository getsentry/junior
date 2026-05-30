# Agent Session Resumability Spec

## Metadata

- Created: 2026-03-05
- Last Edited: 2026-05-30

## Purpose

Define the durable agent session log and how a single assistant turn is split into resumable execution slices so serverless time limits do not cause message loss, duplicate side effects, or unrecoverable partial state.

## Scope

- Session/slice lifecycle for one assistant turn.
- Durable agent session history and its projection into Pi/runtime state.
- Minimal session-log event schema at safe resume boundaries.
- Pi replay/continue contract (`agent.state.messages = ...` + `continue`) across slices.
- Signed internal callback contract for timeout continuation.
- Separation between canonical session logs, derived projections, and durable thread state.
- Failure recovery and observability requirements.

## Non-Goals

- Mid-tool-call persistence or resume.
- Backward compatibility with legacy `inflight_partial` state.
- Replacing existing tool implementations or Slack transport UX.
- Multi-turn planning policies (this spec covers one assistant turn/session at a time).
- A generic queue/lease/fencing workflow runtime.
- Reconciling or rewriting partially visible Slack assistant output after timeout.

## Contracts

### Spec Boundary

This spec owns how one assistant turn is persisted and resumed across execution slices. The full Slack-event-to-agent-to-Slack data flow belongs to `./chat-architecture.md`; user-visible Slack acknowledgements and final delivery belong to `./slack-agent-delivery.md`.

### Identity Model

- `conversation_id`: Stable, predictable thread identity (for example, one Slack thread). This is the durable history key.
- `session_id`: Conversation-local session marker for the reduced session-log
  projection. It starts at `session_0`, advances when `projection_reset`
  creates a replacement projection, and is not the durable history key.
- `turn_id`: Internal identity for one resumable execution attempt inside the
  conversation. This is only needed for pause/resume correlation and diagnostics.
- `slice_id`: Monotonic integer starting at `1` for each resumed execution chunk in the same turn.
- `event_id`: Stable identity for one durable session-log event.
- `pause_event_id`: Event id carried by timeout/auth resume callbacks so stale callbacks can be dropped.

A conversation has one ordered session log keyed by `conversation_id`. The
first turn creates that log. Later turns with the same conversation id load and
reduce the same log, restore Pi from the projected messages, and append new
events. Each pause event identifies one safe resume boundary inside that log.

### Runtime State Partition

- Chat SDK state is the ingress coordination layer. It owns webhook message
  dedupe/cache, `concurrency: "queue"` storage, per-thread locks, thread
  subscriptions, and `thread.setState()`/`channel.setState()` payloads.
- Junior agent session state is separate application state. It owns the
  append-only model execution history and the minimal runtime transition facts
  needed to resume that history.
- Junior may reuse the same Redis connection as the Chat SDK adapter, but the
  session log keyspace must be Junior-owned, not Chat SDK thread-state/cache
  keys.
- The durable session log key is `junior:agent-session-log:<conversation_id>`
  (prefixed by `JUNIOR_STATE_KEY_PREFIX` when configured). It stores an
  append-only chronological model-execution log with one deterministic
  projection into Pi messages. Projection events carry the current `session_id`;
  after a reset, reducers use the newest session and ignore events that belong
  to older sessions.
- Session status, latest slice id, pause state, resume validity, and Pi message
  projection are derived by reducing the session log. Durable cursor/status
  records are transitional read models, not canonical state.
- Dynamic agent state that is visible to Pi, including loaded skills and MCP
  provider connections used so far, is recovered from the session log. Do not
  persist a parallel list of loaded skills, active providers, or tool/session
  state in side metadata.
- Durable thread state is the canonical home for mutable turn-local runtime state that can change mid-slice:
  - artifact state (for example active canvas/list context)
  - sandbox identity and dependency-profile hash
  - conversation/thread state and user/assistant message history
- Durable thread state may point at an active paused session for callback
  routing. It must not point fresh turns at a separate "last session" history;
  the predictable `conversation_id` already identifies the model history.
- Channel configuration is reloaded from the canonical state/configuration services on resume, not copied into the session log.
- Sandbox and artifact state must be persisted eagerly as they change so the next slice can rebuild the same environment without depending on successful turn completion.
- Thread state, channel state, turn-session checkpoints, and Pi session messages share Junior's one-week Redis retention window.

### Ingress Queue Contract

Production Slack ingress uses Chat SDK `concurrency: "queue"` for each
normalized thread key. The SDK holds the per-thread lock while the active
handler runs. Messages that arrive during that handler are queued; after the
handler finishes, the SDK drains the queue, dispatches the latest queued
message, and passes earlier queued messages as `MessageContext.skipped`.

Junior must consume `MessageContext.skipped` as user-authored input for the
next dispatched turn. Ignoring it loses user messages even though the SDK queue
worked correctly.

Session-log writes for a live Slack turn must happen before the SDK handler
returns and releases the thread lock. Timeout and OAuth resume handlers must
acquire the same logical thread/conversation lock before reading or writing the
session log.

### Agent Session Log Contract

The durable agent session log is the canonical state log for model execution. It is the source used to reconstruct `agent.state.messages`, derive model-visible runtime handles, and resume an interrupted session.

Persist facts that happened and external handles that cannot be recomputed. Derive everything else by reducing the log.

The session log models Pi's conversation capabilities first. Any entry that Pi
can already represent should be stored as a Pi message, not as a Junior-specific
state record. Junior-specific events exist only for facts Pi cannot represent or
facts Pi should not see.

The session log has one clear projection into Pi messages:

1. Most entries should already be valid Pi messages.
2. Host-authored entries are allowed only when they have an explicit, deterministic projection into valid Pi messages or are explicitly filtered before assigning `agent.state.messages`.
3. Projection must preserve chronological order and safe continuation boundaries.
4. Projection must not invent loaded skills, provider activation, tool results, or assistant/user messages that were not represented in the durable log.
5. Storage writes are append-only. If recovery must roll the active Pi projection back to a prior safe boundary, the writer appends an explicit projection-reset event instead of trimming or rewriting the stored list.

The schema must be a strongly typed discriminated union with runtime validation
at the storage boundary. The TypeScript type and the runtime parser must come
from the same Zod schema (or the repo-standard equivalent if that changes).
Invalid stored entries are corrupt state and should fail loudly; the reducer
should not paper over unknown event shapes with guessed behavior.

Each event has this envelope:

- `schemaVersion`: current session-log schema version.
- `eventId`: stable id for this append.
- `conversationId`: the predictable conversation id that owns the log.
- `sessionId`: the current conversation-local session marker for events that
  participate in the reduced Pi/runtime projection. This bounds replay after
  compaction and must not be used as the conversation key.
- `turnId`: the active resumable execution id when the event belongs to a
  specific paused/resumed run; omit only for events that are intentionally
  conversation-scoped.
- `createdAtMs`: wall-clock creation time.
- `type`: discriminant.

### Session Log Events

The session log should stay minimal. Add an event only when the event records a
runtime transition or external handle that is not already represented by a Pi
message.

Canonical event families use past-tense names for facts that actually
happened:

- `user_input_received`: records the user input that starts one assistant turn
  session when the first Pi user message does not already carry enough identity.
- `slice_started`: records that a serverless execution slice started when slice identity is
  needed for timeout accounting, diagnostics, or callback validation.
- `pi_message`: records user, assistant, tool-call, tool-result, and
  host-authored Pi messages.
- `projection_reset`: advances the current Pi projection to an earlier safe
  boundary without rewriting the append-only log.
- `mcp_provider_connected`: records that a configured MCP provider was
  successfully connected and its tool catalog listed for this session.
- `authorization_requested`: records that the runtime sent or reused a private
  authorization link for provider work that blocked the current session.
- `authorization_completed`: records that the requester completed the
  authorization callback for the blocked provider work.
- `timeout_paused`: records a safe timeout boundary and carries the
  `pause_event_id` used by the signed continuation callback.
- `auth_paused`: records a safe auth boundary and points at auth-owned callback
  state.
- `pause_resumed`: records that a specific pause event was consumed when that
  fact is needed to reject stale callbacks or explain slice continuity. Omit it
  when a following `slice_started` event with
  `reason=timeout_resume|auth_resume` is enough.
- `assistant_reply_delivered`: records that the final assistant reply for this
  session was accepted by Slack.
- `session_abandoned`: records that this session must not resume because a
  specific newer user input started a replacement session.
- `session_error_recorded`: records a terminal user-visible or operator-visible
  failure only when that failure changes future resume behavior.

Pi-projected events:

- `pi_message` contributes its `message` directly to the Pi projection when it
  belongs to the current `sessionId`.
- `projection_reset` replaces the current Pi projection with the supplied
  `messages` array and starts the next `sessionId`.

Junior-only events are filtered out before assigning `agent.state.messages` and
are reduced only for runtime state:

- `user_input_received`
- `slice_started`
- `mcp_provider_connected`
- `authorization_requested`
- `timeout_paused`
- `auth_paused`
- `pause_resumed`
- `assistant_reply_delivered`
- `session_abandoned`
- `session_error_recorded`

`authorization_completed` is a host-authored event that projects to one concise
Pi-compatible observation in chronological order:

> Authorization completed for provider "<provider>". Continue the blocked
> request and retry the provider operation if needed.

The projection must not include authorization URLs, OAuth codes, token values,
or provider secrets. The projected Pi message timestamp must come from the
durable event timestamp, not projection time, so replaying the same log produces
byte-stable Pi history. This event replaces prompt-side resume markers such as
`turn-state=resumed` or `authorization_completed_provider`; authorization
completion is session history, not turn prompt context.

Avoid filler events that duplicate facts already present in Pi messages or
external stores:

- Do not write `skill_loaded` if the successful `loadSkill` tool result already
  captures the loaded skill.
- Do not write `cursor_updated`, `record_version_incremented`, or periodic
  `state_snapshot` events.
- Do not write `mcp_provider_connected` before `activateProvider` has actually
  connected and listed tools.
- Do not repeatedly write `mcp_provider_connected` for a provider that is
  already active in the current reduced session state.
- Do not write prompt-only auth completion facts. If provider authorization
  changes what the model should do next, append `authorization_completed` and
  let the session-log projection carry that observation.

The session log may represent:

- real user messages supplied to Pi
- assistant messages produced by Pi
- tool call and tool result records
- synthetic user-role handoff summaries created by context compaction
- runtime transition facts listed above

The session log must not become a dumping ground for unrelated runtime state. These belong in their own durable stores and are reloaded by runtime services:

- Slack-visible message delivery state
- artifact state
- sandbox identity and dependency-profile hash
- pending auth callback state
- channel configuration values
- side-effect idempotency records
- telemetry, spans, logs, or status/progress events

Reconstructable state must be inferred from the session log rather than copied into side metadata or prompt side channels. Current derived state includes:

- loaded skills from successful `loadSkill` tool results
- active MCP providers from `mcp_provider_connected` events and, during the
  transition, successful `searchMcpTools`/`callMcpTool` history
- MCP provider identity from canonical tool names such as `mcp__<provider>__<tool>`

MCP provider connection should not be inferred from `loadSkill` in the target
design. Skills may teach the model how to use provider tools, but MCP
connection is a runtime transition caused by `searchMcpTools({ provider })`,
`callMcpTool`, resume restoration, or another explicit provider-access path.

If a future runtime feature needs state at resume time, first ask whether it can
be recomputed by reducing the session log plus loading external resources by
pointer. If yes, do not persist it. If not, represent it as a minimal session-log
event or define the projection/filtering rule.

### Compaction Projection

Pi coding-agent and Codex both keep an ordered session/run log and treat
compaction as a projection change, not as a separate state store.

Pi coding-agent stores ordinary messages and internal session entries in one
entry list. Its `compaction` entry carries a summary plus
`firstKeptEntryId`; rebuilding context emits the latest compaction summary first,
then kept messages, then messages after compaction. Internal entries such as
custom metadata are ignored by the LLM context projection.

Codex stores local sessions as JSONL event logs under `~/.codex/sessions/...`.
Its compaction flow builds replacement history from selected recent user
messages plus a summary item, then replaces the active model history while the
raw session log still records the surrounding events. The summary is encoded as
model-visible history, not as a second durable transcript.

Junior follows the same rule:

- The canonical log stays append-only.
- Compaction appends one `projection_reset` event whose `messages` are the new
  Pi projection.
- That reset advances the conversation-local session. Future log entries are
  written with the new session, so stale entries from earlier sessions are
  filtered out of both Pi history and derived provider/auth state.
- The replacement projection should contain retained real user messages and one
  synthetic user-role handoff summary.
- The reducer ignores older Pi messages before the latest reset for the active
  Pi projection, while still allowing the raw log to be inspected for audit and
  debugging.
- Compaction must not persist parallel `loadedSkillNames`, active-provider
  lists, prompt caches, or summary logs. If a compacted projection omits old
  tool results or provider connection events, those capabilities must be
  rediscovered normally on a future turn.

### Derived Session State

Every agent load consumes the session log and reduces it before starting Pi.
Scanning the log is the normal boot path, not an exceptional slow path.

The reducer owns:

- current lifecycle projection
- latest slice id
- latest pause event and pause reason
- timeout/OAuth resume validity
- current Pi message projection
- loaded skills
- connected MCP providers
- cumulative duration/usage when these are still product-relevant

These values must not be persisted as a second durable run-state log. A
temporary read model may exist during migration, but it must be treated as a
cache/index that can be rebuilt from the session log.

### Lifecycle Projection

- The reduced lifecycle is a projection, not a durable event vocabulary.
- `awaiting_resume` is derived from the latest unconsumed `timeout_paused` or
  `auth_paused`.
- `delivered` is derived from `assistant_reply_delivered`.
- `abandoned` is derived from `session_abandoned`.
- Terminal user-visible failure is currently reflected in conversation/thread
  state. Add `session_error_recorded` only when that durable fact is needed to
  prevent or explain future resume behavior.

Valid lifecycle transitions:

1. `awaiting_resume -> delivered`
2. `awaiting_resume -> awaiting_resume` (another timeout/auth boundary after a resumed slice)
3. `awaiting_resume -> abandoned`
4. `delivered` is terminal
5. `abandoned` is terminal

The implementation should not persist a separate `running` lease state between
slices. Per-thread execution locks are owned by the Chat SDK state adapter.

### Safe Resume Boundary Contract

A pause boundary is resumable only when all conditions are true:

1. No tool call is currently in flight.
2. All tool results prior to the boundary are durably recorded.
3. Pi session message state is durably recorded up to the same logical point,
   and the latest pause/projection event identifies that boundary.
4. Side-effect markers/idempotency entries for finished actions are committed.

Forbidden boundary:

- Any point between tool request emission and corresponding tool result persistence.

### Session Projection Contract

Each reduced session projection must include:

- `conversation_id`
- `session_id`
- `slice_id`
- `latest_event_id`
- `latest_pause_event_id` when awaiting resume
- `pi_messages`: Canonical message list to replay into Pi, materialized from the agent session log.
- `lifecycle`: one of `running|awaiting_resume|delivered|abandoned|error`.
- `updated_at_ms`

Optional projection fields:

- `turn_id` when the projection is tied to a resumable turn.
- `resume_reason`: `timeout|auth` (when `awaiting_resume`).
- `resumed_from_slice_id`
- `error_message`

Durable session metadata must not store:

- artifact state
- sandbox identity
- channel configuration values
- a second durable tool-call log
- a separate visible transcript log
- loaded skill names or active MCP provider names
- prompt-side capability/history caches
- per-slice deadline metadata
- message cursors or record versions that can be derived from log order

Primary writes append to the session log. Normal writes append new Pi-message
entries. Rollback to an earlier safe boundary appends a projection-reset entry;
prior log entries remain available for audit/debugging but are no longer part of
the current Pi projection.

`inflight_partial` is not part of the session log schema.

### Pi Resume Contract

For slice `n+1`, runtime must:

1. Load the session log for `conversation_id`.
2. Instantiate Pi agent.
3. Reduce the session log and materialize its Pi-message projection.
4. Infer wrapper runtime state from the reduced log, including loaded skills
   from successful `loadSkill` tool results and connected MCP providers from
   `mcp_provider_connected` events.
5. Restore those inferred runtime handles before prompt construction or
   `continue()`.
6. Assign `agent.state.messages = projected_messages`.
7. Resume generation by calling `continue()` to resume generation/tool loop.

For auth-driven pauses and timeout boundaries, the pause/projection event must
trim any trailing uncommitted assistant-only messages so the restored Pi history
is resumable with `continue()`.

If the previous slice timed out after producing uncommitted partial assistant text, that text may be regenerated in the next slice. User-visible output must only include committed transcript content.

### Slice Deadline And Timeout Pause Contract

- Slice execution is bounded by:
  - `AGENT_TURN_TIMEOUT_MS` inside `generateAssistantReply(...)`
  - the platform/function max duration outside the agent loop
- On timeout:
  1. Abort the Pi agent and wait for the in-flight prompt/continue call to settle before snapshotting Pi messages.
  2. If session context exists and a safe boundary can be materialized, append a `timeout_paused` event with:
     - `pause_event_id`
     - current `slice_id`
     - `resumed_from_slice_id=<previous slice>`
     - projected safe Pi boundary, directly or by deterministic projection rule
  3. Throw a retryable timeout error carrying `conversation_id`, `turn_id`, `slice_id`, and `pause_event_id`.
  4. If timeout pause persistence fails, fall back to normal non-resumable turn failure behavior.

### Automatic Continuation Contract

- Session continuation is the agent recovery model: Junior must be able to rebuild the runtime from durable thread state plus the latest safe session-log pause event and continue the same turn session.
- This spec covers session-log and resume mechanics. Transport retry/locking is defined in the chat architecture spec, and Slack-visible delivery behavior is defined in the Slack delivery spec.
- Automatic timeout continuation is the current proactive producer of session-continuation work for serverless/Vercel time limits. It is best-effort and currently uses a signed internal HTTP callback, not a generic queue/lease system.
- A timeout pause may be auto-scheduled only when no assistant text has been made visible to the user for the current turn.
- Once visible assistant output has started posting, the runtime must not auto-resume that turn or attempt to rewrite/reconcile the partial output.
- In the current Slack delivery contract, assistant text is not posted until the reply is finalized, so ordinary agent-generation timeouts still occur before visible output begins.
- If a later user message arrives while `activeTurnId` points at a session whose reduced state is awaiting automatic continuation, the live runtime must treat that message as a retry signal for the existing session: reschedule the pause callback, keep `activeTurnId` on the original session, and do not start a new agent turn.
- In that case, the last safe pause event may still exist for inspection or operator-driven recovery, but the user-visible turn is allowed to fail only after automatic continuation is impossible or exhausted.

### In-Process Provider Retry Contract

- Transient provider failures reported as terminal assistant messages with `stopReason=error` may be retried inside the same running slice before final Slack delivery.
- Provider retry must not replay the original user prompt. It must remove only the trailing assistant error message(s), verify the remaining Pi history ends at a continuable boundary (`user` or `toolResult`), append a `projection_reset` event for that safe boundary, then call `continue()`.
- Provider retry is bounded and uses short exponential backoff. If the retry limit is reached, if the error is not classified as transient, or if no safe boundary remains after trimming, the normal provider-failure reply path owns user-visible recovery.
- Provider retry does not create an awaiting pause and does not schedule a signed resume callback. If a retried slice later times out, the timeout continuation contract above applies.
- Provider retry is only allowed before final Slack reply delivery. The runtime must not retry by rewriting or reconciling text already posted to Slack.

### Internal Timeout-Resume Callback Contract

The timeout-resume callback payload is:

- `conversation_id`
- `turn_id`
- `pause_event_id`

The callback must:

1. Be authenticated with an HMAC signature over the request body plus timestamp.
2. Be rejected when the signature is invalid or too old.
3. Load and reduce the session log for `conversation_id`.
4. Exit without work when:
   - no session log exists
   - `state !== awaiting_resume`
   - `resume_reason !== timeout`
   - `latest_pause_event_id !== pause_event_id`
5. Acquire the same per-thread state-adapter lock used by live turn execution. Because callbacks are often scheduled before the scheduling live handler has released the lock, a busy lock must be retried for a short bounded window before the callback reschedules itself.
6. Rebuild turn runtime state from durable thread/configuration state:
   - user message
   - conversation context
   - artifact state
   - sandbox identity
   - channel configuration
7. Restore Pi messages with `agent.state.messages = ...` and resume with `continue()`.
8. If the resumed slice times out again before visible output, schedule a new callback carrying the new `pause_event_id`.

### Slice Lifecycle

1. User message resolves a predictable `conversation_id`.
2. If the reduced conversation projection has no session bootstrap context,
   runtime adds first-turn-only prompt/context material before the user Pi
   message.
3. If the reduced conversation projection already contains session bootstrap
   context, runtime loads and reduces it, restores Pi from the projected
   messages, and appends the new user input without duplicating bootstrap
   context.
4. Slice `1` runs and eagerly persists sandbox/artifact state as those values change.
5. If Slack accepts the final assistant reply, append `assistant_reply_delivered`.
6. If MCP auth pauses at a safe boundary, append `auth_paused`; the OAuth callback later consults auth-owned state before resuming.
7. If timeout is reached before any assistant text is visible, append `timeout_paused` and schedule the signed internal timeout-resume callback with that event id.
8. The timeout-resume handler validates `pause_event_id`, rebuilds durable runtime state, restores Pi messages, and calls `continue()`.
9. If the callback loses the per-thread lock because the scheduling live handler is still unwinding, it retries briefly and then reschedules the same pause-event callback without mutating state.
10. If the user pings the thread while the timeout pause is still awaiting resume, the runtime reschedules the existing callback. The ping must not create a second agent run for the same conversation.
11. If timeout happens after visible assistant output begins, keep the timeout pause event but do not auto-schedule continuation.

## Failure Model

1. Timeout or crash before a stable session-log append: no new boundary exists; the system can rely on the previous reduced state plus whatever thread state had already been eagerly persisted.
2. Timeout pause append succeeds but the timeout-resume callback is never sent or delivered: there is no sweeper today; continuation requires another explicit callback, a later user follow-up that reschedules the existing pause, or operator intervention.
3. Stale timeout-resume callbacks for an older `pause_event_id` are dropped without doing work.
4. Duplicate concurrent callbacks for the same thread are serialized by the shared per-thread state-adapter lock. Lock-busy callbacks retry for a short bounded window, then reschedule the same pause-event callback rather than abandoning the awaiting session.
5. Timeout after visible assistant output begins: automatic continuation is skipped to avoid duplicate/corrupt user-visible output.
6. Repeated resumed timeouts before visible output may produce further `timeout_paused` events with incremented slice ids.
7. A later user message after an ungraceful crash may build its prompt history from the active session's latest reduced Pi projection. If the prior session produced assistant text that was not committed to visible thread state, that trailing assistant text must be trimmed from the fresh-turn history view.

## Observability

Required log events/diagnostics:

- `agent_turn_timeout`
- `agent_turn_timeout_resume_log_append_failed`
- `agent_turn_timeout_resume_schedule_failed`
- `agent_turn_continuation_retry_schedule_failed`
- `agent_turn_timeout_resume_skipped_after_visible_output`
- `agent_turn_provider_retry`
- `timeout_resume_failed`
- `timeout_resume_handler_failed`
- `timeout_resume_lock_busy`
- `timeout_resume_lock_busy_retrying`
- `slack_turn_continuation_notice_post_failed`

Required attributes when available:

- `gen_ai.provider.name`
- `gen_ai.operation.name`
- `gen_ai.request.model`
- `app.ai.turn_timeout_ms`
- `app.ai.resume_conversation_id`
- `app.ai.resume_session_id`
- `app.ai.resume_from_slice_id`
- `app.ai.resume_next_slice_id`
- `app.ai.resume_pause_event_id`
- `app.ai.conversation_id`
- `app.ai.session_id`
- `messaging.message.id`

## Verification

1. Unit: timeout pause events trim trailing assistant-only messages and carry a unique `pause_event_id`.
2. Unit: signed timeout-resume callbacks verify successfully and tampered payloads are rejected.
3. Unit/integration: a timed-out turn resumes with restored `agent.state.messages` + `continue` and reaches a successful terminal reply when no assistant text had been made visible.
4. Unit/integration: a resumed timeout slice can time out again and schedule the next callback with the new `pause_event_id`.
5. Unit/integration: a lock-busy timeout callback retries before rescheduling the same pause event.
6. Integration: a user follow-up or duplicate delivery during an awaiting automatic continuation pause reschedules the existing session instead of starting a new turn.
7. Unit/integration: auth-driven resume restores the same active skill/MCP tool universe before `continue()`.
8. Unit/integration: eager sandbox/artifact persistence preserves resumed tool context across slices.
9. Unit/integration: fresh follow-up turns can recover Pi history from the active/last agent session log without depending on conversation-state Pi transcript mirroring.
10. Manual/eval: once assistant text is already visible, timeout does not auto-resume or attempt to reconcile partial thread output.
11. Unit/integration: transient provider failures retry with `continue()` from a safe boundary and do not duplicate prior tool execution.
12. Unit/integration: successful provider activation appends one `mcp_provider_connected` event, and resume restores providers from those events. Legacy Pi-message inference is allowed only while pre-event session logs still exist.

## Related Specs

- [Harness Agent Spec](./harness-agent.md)
- [Durable Slack Thread Workflows Spec](./archive/durable-workflows.md) (archived — unimplemented design)
- [Agent Execution Spec](./agent-execution.md)
- [Instrumentation Spec](./instrumentation.md)
