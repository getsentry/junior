# Agent Session Resumability Spec

## Metadata

- Created: 2026-03-05
- Last Edited: 2026-07-08

## Purpose

Define the durable agent step history and how one turn (one response-producing
agent run) is split into resumable execution slices so serverless time limits do
not cause message loss, duplicate side effects, or unrecoverable partial state.
The durable authority for that history is the `junior_agent_steps` SQL table
(`./conversation-storage.md`); this spec owns how it is projected into Pi state
and resumed across slices. Canonical vocabulary (turn, slice, step, context
epoch) is defined in `./terminology.md`.

## Scope

- Session/slice lifecycle for one agent run.
- Durable agent session history and its projection into Pi/runtime state.
- Minimal session-log event schema at safe resume boundaries.
- Pi replay/continue contract (`agent.state.messages = ...` + `continue`) across slices.
- Continuation contract for queue-driven conversation workers.
- Separation between canonical session logs, derived projections, and durable thread state.
- Failure recovery and observability requirements.

## Non-Goals

- Mid-tool-call persistence or resume.
- Backward compatibility with legacy `inflight_partial` state.
- Replacing existing tool implementations or Slack transport UX.
- Multi-run planning policies (this spec covers one agent run/session at a time).
- Conversation mailbox, queue wake-up, lease, and heartbeat mechanics owned by
  `./task-execution.md`.
- Reconciling or rewriting partially visible Slack assistant output after timeout.

## Contracts

### Spec Boundary

This spec owns how agent session state is persisted and resumed across execution slices. The durable mailbox, queue wake-up, lease, and heartbeat recovery flow belongs to `./task-execution.md`. The full Slack-event-to-agent-to-Slack data flow belongs to `./chat-architecture.md`; user-visible Slack progress and final delivery belong to `./slack-agent-delivery.md`.

### Identity Model

- `conversation_id`: Stable, predictable thread identity (for example, one Slack thread). This is the durable history key.
- `context_epoch`: Conversation-local integer generation of the model-visible
  context for the reduced projection. It starts at 0, advances when a
  `context_epoch_started` marker begins a replacement context (compaction or
  rollback), and is not the durable history key. Historical name: this marker was
  `session_id`, starting at `session_0` and advanced by a `projection_reset`
  entry.
- `agent_run_id`: Optional internal identity for one response-producing agent
  run inside the conversation. Queue-driven continuation does not need this
  value to decide where to resume; the reduced conversation session log is the
  resume source.
- `slice_id`: Diagnostic integer for one execution chunk in the same
  conversation. The mailbox worker must not enforce a slice cap; timeout
  retry-limit guards live in the agent-run read model.
- `event_id`: Stable identity for one durable session-log event.
- `pause_event_id`: Event id carried by timeout/auth resume callbacks so stale callbacks can be dropped.

A conversation has one ordered session log keyed by `conversation_id`. The
first agent run creates that log. Later runs with the same conversation id load
and reduce the same log, restore Pi from the projected messages, and append new
events. Each pause event identifies one safe resume boundary inside that log.

### Runtime State Partition

- Task execution state is the ingress coordination layer. It owns durable
  conversation mailboxes, queue wake-up nudges, conversation leases, and
  heartbeat repair as specified in `./task-execution.md`.
- Junior agent step history is separate application state. It owns the
  append-only model execution history and the minimal runtime transition facts
  needed to resume that history.
- The durable authority is the `junior_agent_steps` SQL table
  (`./conversation-storage.md`), one row per step ordered by `(conversation_id,
seq)`. It replaces the former Redis list
  `junior:agent-session-log:<conversation_id>`. This spec refers to that table's
  step rows as the session log. It stores an append-only model-execution history
  with one deterministic projection into Pi messages. `pi_message` steps carry a
  `context_epoch`; the reducer uses the highest epoch and ignores steps in older
  epochs.
- Session status, latest slice id, pause state, resume validity, and Pi message
  projection are derived by reducing the session log. Durable cursor/status
  records are transitional read models, not canonical state.
- Dynamic agent state that is visible to Pi, including loaded skills and MCP
  provider connections used so far, is recovered from the session log. Do not
  persist a parallel list of loaded skills, active providers, or tool/session
  state in side metadata.
- Durable thread state is the canonical home for mutable run-local runtime state
  that can change mid-slice, and is now runtime scratch only:
  - artifact state (for example active canvas/list context)
  - sandbox identity and dependency-profile hash
  - processing state
    Thread state no longer mirrors transcripts: the visible-message and Pi-message
    copies move to SQL (`junior_conversation_messages` and `junior_agent_steps`)
    per `./conversation-storage.md`.
- Durable thread state may point at an active paused session for callback
  routing. It must not point fresh runs at a separate "last session" history;
  the predictable `conversation_id` already identifies the model history.
- Channel configuration is reloaded from the canonical state/configuration services on resume, not copied into the session log.
- Sandbox and artifact state must be persisted eagerly as they change so the next slice can rebuild the same environment without depending on successful run completion.
- File-like tool outputs that can be reused across model steps must be represented by explicit handles, such as sandbox paths, before the tool reports success. Process memory may cache file bytes during one slice, but it is not the source of truth across tool, delivery, resume, or later-turn boundaries.
- Thread-state runtime scratch and channel state share Junior's one-week Redis
  retention window. Durable step and message content lives in SQL, where its
  retention follows conversation visibility (`./conversation-storage.md`), not a
  Redis TTL.

### Ingress Queue Contract

Production ingress appends normalized inbound messages to the durable
conversation mailbox and sends a queue wake-up nudge containing only the
`conversation_id`. Ingress does not decide whether a message starts a new agent
run or steers an active one.

The queue worker owns the conversation lease. Before each Pi `continue()`, and
again at each safe boundary before another model call, the worker drains pending
mailbox messages into the session log. Drained messages become part of the same
active conversation rather than a competing run.

Session-log writes for drained inbound messages must happen before those
messages are marked injected in the mailbox. Queue delivery acknowledgement must
happen only after the worker has durably committed final completion, safe
cooperative yield, or a no-work result.

Marking a mailbox message injected without a corresponding durable session-log
append (or a persisted skip decision) is a contract violation. This applies
equally while a conversation is `awaiting_resume`: a message that arrives while
a run is parked either steers the resumed run at its next safe boundary or is
appended to the session log before the resumed `continue()`. Rescheduling a
continuation does not consume the message.

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
5. Storage writes are append-only. If recovery must roll the active Pi projection back to a prior safe boundary, the writer opens a new context epoch — it appends a `context_epoch_started` marker step plus the replacement `pi_message` rows in one transaction — instead of trimming or rewriting stored rows.

Step-history writers are serialized by conversation ownership at their call
sites: conversation-record writes are fenced in the store (an expired lease
surfaces as `ConversationMutationFencedError` via `extendLock`), and
read-compute-append sequences run under the conversation lease or the thread
resume lock (including the parked-input append, which takes the resume lock).
`seq` is assigned transactionally under the lease, and the
`(conversation_id, seq)` primary key is the fencing tripwire: a writer that no
longer holds its lease fails loudly on a PK violation rather than appending
steps or opening a new epoch.

The schema must be a strongly typed discriminated union with runtime validation
at the storage boundary. The TypeScript type and the runtime parser must come
from the same Zod schema (or the repo-standard equivalent if that changes).
Invalid stored entries are corrupt state and should fail loudly; the reducer
should not paper over unknown event shapes with guessed behavior.

Each step row has this envelope:

- `schemaVersion`: schema version of the row payload (per row; a `pi_message`
  payload also carries its own Pi message schema version).
- `conversationId`: the conversation id that owns the history; part of the
  `junior_agent_steps` primary key `(conversation_id, seq)`.
- `seq`: per-conversation append order.
- `context_epoch`: the integer context generation this step belongs to. This
  bounds replay after compaction/rollback and is not the conversation key.
- `createdAt`: creation time; preserved from message-internal timestamps on
  replay so Pi history is byte-stable.
- `type`: discriminant.

Future turn-scoped read models may expose a stable `turnId`; the step-history
storage boundary orders by `seq`, tracks generations by `context_epoch`, and
turn status stays in the turn-session read model.

### Session Log Events

The session log should stay minimal. Add an event only when the event records a
runtime transition or external handle that is not already represented by a Pi
message.

Canonical event families use past-tense names for facts that actually
happened:

- `user_input_received`: records the user input that starts one agent run when
  the first Pi user message does not already carry enough identity.
- `slice_started`: records that a serverless execution chunk started when that
  fact is needed for timeout accounting or diagnostics.
- `pi_message`: records user, assistant, tool-call, tool-result, and
  host-authored Pi messages.
- `context_epoch_started`: opens the next context epoch, carrying `reason`
  (`compaction` | `rollback`). It does not embed a transcript array; the
  replacement context is written as ordinary `pi_message` rows in the new epoch
  in the same transaction. (Historical name: `projection_reset`, which embedded
  the replacement `messages`.)
- `mcp_provider_connected`: records that a configured MCP provider was
  successfully connected and its tool catalog listed for this session.
- `authorization_requested`: records that the runtime sent or reused a private
  authorization link for provider work that blocked the current session.
- `authorization_completed`: records that the actor completed the
  authorization callback for the blocked provider work.
- `tool_execution_started`: records that the parent run started a tool call so
  operator-facing activity views can show in-flight work before Pi emits the
  final tool result.
- `subagent_started`: records that a child agent execution became visible from
  the parent run. It carries `childConversationId`; the child's history is its
  own conversation (`parent_conversation_id` set) with its own steps
  (`./conversation-storage.md`, `./advisor-tool.md`). The polymorphic
  `transcriptRef {type, key}` and the `advisor_session` Redis key are removed.
- `subagent_ended`: records the terminal child agent outcome for a previously
  recorded `subagent_started` event.
- `timeout_paused`: records a safe timeout or cooperative-yield boundary when a
  durable pause fact is needed beyond the Pi messages already in the log.
- `auth_paused`: records a safe auth boundary and points at auth-owned callback
  state.
- `pause_resumed`: records that a specific pause event was consumed when that
  fact is needed to explain execution continuity. Omit it when a following
  `slice_started` event with `reason=queue_resume|auth_resume` is enough.
- `assistant_reply_delivered`: records that the final assistant reply for this
  session was accepted by Slack. Current implementation carries this fact as
  the acceptance-gated `completed` transition on the turn-session read model
  instead of a session-log event; add the event only when a log consumer
  needs it.
- `session_abandoned`: records that this session must not resume because a
  specific newer user input started a replacement session.
- `session_error_recorded`: records a terminal user-visible or operator-visible
  failure only when that failure changes future resume behavior.

Pi-projected events:

- `pi_message` contributes its `message` directly to the Pi projection when it
  belongs to the highest `context_epoch`.
- `context_epoch_started` opens a new epoch; the reducer projects the
  `pi_message` rows of the highest epoch in `seq` order and ignores rows from
  older epochs. The marker itself carries no messages.

Junior-only events are filtered out before assigning `agent.state.messages` and
are reduced only for runtime state:

- `user_input_received`
- `slice_started`
- `mcp_provider_connected`
- `authorization_requested`
- `tool_execution_started`
- `subagent_started`
- `subagent_ended`
- `timeout_paused`
- `auth_paused`
- `pause_resumed`
- `assistant_reply_delivered`
- `session_abandoned`
- `session_error_recorded`

Host-only activity events (`tool_execution_started`, `subagent_started`, and
`subagent_ended`) must not contribute to Pi replay or resume history. They are
durable reporting facts for activity timelines and diagnostics; the Pi
projection reducer must ignore them when constructing `agent.state.messages`.

Host-only activity events are best-effort reporting writes. A failed append is
logged and swallowed; it must not abort the model turn, end the run, or be
classified as a provider failure.

`authorization_completed` is a host-authored event that projects to one concise
Pi-compatible observation in chronological order:

> Authorization completed for provider "<provider>". Continue the blocked
> request and retry the provider operation if needed.

The projection must not include authorization URLs, OAuth codes, token values,
or provider secrets. The projected Pi message timestamp must come from the
durable event timestamp, not projection time, so replaying the same log produces
byte-stable Pi history. This event replaces prompt-side resume markers such as
`turn-state=resumed` or `authorization_completed_provider`; authorization
completion is session history, not run prompt context.

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

Slack conversation type/name supplied in the first runtime-context block is
bootstrap prompt material already recorded in the Pi user message. Timeout and
OAuth resumes must not persist a second copy or re-send the original prompt
context; existing runtime-context blocks in projected Pi history must be left
unchanged before calling `continue()`. If a pause is captured before `prompt()`
has sent bootstrap context, the runtime may attach that missing block once to
the stored user boundary; that is first-prompt construction, not replacement of
an existing block.

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

- The step history stays append-only.
- Compaction opens a new context epoch: in one transaction it appends a
  `context_epoch_started {reason: "compaction"}` marker and writes the new
  context as ordinary `pi_message` rows in that epoch. It does not embed a
  replacement `messages` array in the marker.
- The new epoch is the current context. Future steps are written in the new
  epoch, so steps in earlier epochs are filtered out of both Pi history and
  derived provider/auth state.
- The replacement context should contain retained real user messages and one
  synthetic user-role handoff summary.
- The reducer ignores `pi_message` rows in older epochs for the active Pi
  projection, while still allowing older epochs to be inspected for audit and
  debugging.
- Compaction must not persist parallel `loadedSkillNames`, active-provider
  lists, prompt caches, or summary logs. If a compacted projection omits old
  tool results or provider connection events, those capabilities must be
  rediscovered normally on a future run.

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
- `delivered` is derived from the acceptance-gated delivered fact
  (`assistant_reply_delivered`, currently the turn-session record's
  `completed` transition, which is written only after destination
  acceptance).
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

The implementation should not persist a separate `running` lease state in the
session log. Conversation execution leases are mailbox-worker state owned by
`./task-execution.md`.

Generation completing is not delivery. A session must not be recorded in a
terminal completed/delivered state before the destination accepts the final
reply; until acceptance it remains resumable or is terminally failed with the
standard visible fallback. Resume and redelivery paths must check the
delivered marker before posting so duplicate deliveries of the same finalized
reply are suppressed. An assistant reply that was never delivered must not be
presented to later turns as delivered conversation history.

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
- `context_epoch`
- `slice_id`
- `latest_seq`
- `latest_pause_event_id` when awaiting resume
- `pi_messages`: Canonical message list to replay into Pi, materialized from the highest-epoch `pi_message` step rows.
- `lifecycle`: one of `running|awaiting_resume|delivered|abandoned|error`.
- `updated_at_ms`

Optional projection fields:

- `agent_run_id` when the projection is tied to a resumable run.
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

Primary writes append step rows. Normal writes append new `pi_message` steps in
the current epoch. Rollback to an earlier safe boundary opens a new context
epoch (a `context_epoch_started` marker plus the trimmed `pi_message` rows in one
transaction); steps in prior epochs remain available for audit/debugging but are
no longer part of the current Pi projection.

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

### Cooperative Continuation Contract

- Session continuation is the agent recovery model: Junior must be able to
  rebuild runtime state from durable thread state plus the reduced session log
  and call Pi `continue()`.
- The task execution spec owns when a serverless worker should yield, enqueue
  another conversation wake-up, release the lease, and exit.
- This spec owns only the session-log requirement: every safe boundary that may
  be resumed must already be durably represented in the session log before the
  worker yields or before the next model call begins.
- Routine cooperative continuation must happen only at safe Pi boundaries. The
  runtime must not create synthetic checkpoints midway through a model stream or
  tool call.
- If a function dies during a model or tool call, recovery uses the last
  previously persisted safe boundary. It does not need an emergency abort to
  create a new boundary.
- Once visible assistant output has started posting, the runtime must not
  auto-resume that run or attempt to rewrite/reconcile the partial output.
- In the current Slack delivery contract, assistant text is not posted until the
  reply is finalized, so ordinary generation and tool-loop continuation remains
  eligible until final delivery starts.
- If a later user message arrives while the conversation is active, the mailbox
  worker treats it as pending input for the same conversation and injects it at
  the next safe boundary. It must not start a competing agent run for the same
  conversation.

### In-Process Provider Retry Contract

- Transient provider failures reported as terminal assistant messages with `stopReason=error` may be retried inside the same running slice before final Slack delivery.
- Provider retry must not replay the original user prompt. It must remove only the trailing assistant error message(s), verify the remaining Pi history ends at a continuable boundary (`user` or `toolResult`), write a rollback epoch for that safe boundary (a `context_epoch_started {reason: "rollback"}` marker plus the trimmed `pi_message` rows in one transaction), then call `continue()`.
- Provider retry is bounded and uses short exponential backoff. If the retry limit is reached, if the error is not classified as transient, or if no safe boundary remains after trimming, the normal provider-failure reply path owns user-visible recovery.
- Provider retry does not create an awaiting pause. If a retried slice reaches a
  cooperative yield boundary later, the conversation mailbox worker owns
  re-enqueueing the conversation.
- Provider retry is only allowed before final Slack reply delivery. The runtime must not retry by rewriting or reconciling text already posted to Slack.

### Queue-Driven Resume Contract

A queue-driven resume payload contains only `conversation_id`. It must not carry
a checkpoint, slice id, or prompt text.

The worker must:

1. Acquire the conversation lease defined in `./task-execution.md`.
2. Load durable thread/configuration state:
   - conversation context
   - pending mailbox messages
   - artifact state
   - sandbox identity
   - channel configuration
3. Drain pending mailbox messages into the session log idempotently.
4. Restore Pi messages with `agent.state.messages = ...`.
5. Resume with `continue()`.

Recovery must cover every non-terminal session, not only `awaiting_resume`.
When the mailbox is empty and the newest session is `running` under an expired
lease (hard worker death), the worker resumes it from the latest durable safe
boundary; if no resumable boundary exists, it terminally fails the session and
delivers the standard failure fallback. A lease-expired `running` session must
never be silently dropped.

### Slice Lifecycle

1. User message resolves a predictable `conversation_id`.
2. If the reduced conversation projection has no session bootstrap context,
   runtime adds bootstrap prompt/context material before the user Pi message.
3. If the reduced conversation projection already contains session bootstrap
   context, runtime loads and reduces it, restores Pi from the projected
   messages, and appends the new user input without duplicating bootstrap
   context. This dedupe applies to every replay shape, including redelivery of
   the same inbound message after a lost input commit against a `running`
   record: the same user prompt must not appear twice in Pi history.
4. The queue worker runs and eagerly persists sandbox/artifact state as those values change.
5. If Slack accepts the final assistant reply, record the delivered fact
   (`assistant_reply_delivered` semantics; currently the acceptance-gated
   `completed` record commit). Final assistant messages are committed to the
   durable log only after acceptance.
6. If MCP auth pauses at a safe boundary, append `auth_paused`; the OAuth callback later consults auth-owned state before resuming.
7. If the worker reaches a cooperative yield boundary, it ensures the latest safe boundary is durably represented in the session log, enqueues the conversation id, releases the lease, and exits.
8. The next queue worker rebuilds durable runtime state, restores Pi messages, drains newly pending mailbox input, and calls `continue()`.
9. If the worker disappears before a cooperative yield, heartbeat recovery requeues the conversation after the lease expires. The next worker resumes from the latest durable session-log boundary.
10. If timeout happens after visible assistant output begins, keep the last durable state but do not auto-reconcile partial visible output.

## Failure Model

1. Timeout or crash before a stable session-log append: no new boundary exists; the system can rely on the previous reduced state plus whatever thread state had already been eagerly persisted.
2. Queue nudge is never delivered after a safe boundary append: heartbeat finds pending mailbox or expired lease state and enqueues the conversation id.
3. Duplicate queue nudges for the same conversation are serialized by the conversation lease.
4. Timeout after visible assistant output begins: automatic continuation is skipped to avoid duplicate/corrupt user-visible output.
5. Repeated cooperative yields before visible output may produce further execution chunks, but timeout continuation must stop at the configured high-water slice cap and mark the session failed instead of scheduling another queue nudge.
6. A later user message after an ungraceful crash may build its prompt history from the active session's latest reduced Pi projection. If the prior session produced assistant text that was not committed to visible thread state, that trailing assistant text must be trimmed from the fresh-run history view.
7. Hard worker death mid-slice leaves a `running` session with an expired lease: queue redelivery or heartbeat requeues the conversation, and the next worker resumes it from the latest durable boundary or terminally fails it with a visible fallback. The interrupted request must not die silently.
8. Delivery fails after generation completed: the session is not delivered. It must remain resumable for redelivery or be terminally failed with a visible fallback, and the undelivered assistant reply must not surface as prior conversation history for later turns.

## Observability

Required log events/diagnostics:

- `conversation_work_cooperative_yield`
- `conversation_work_lease_expired_requeued`
- `agent_turn_session_log_append_failed`
- `agent_continue_schedule_failed`
- `agent_turn_provider_retry`

Required attributes when available:

- `gen_ai.provider.name`
- `gen_ai.operation.name`
- `gen_ai.request.model`
- `app.ai.turn_timeout_ms`
- `app.ai.conversation_id`
- `app.ai.context_epoch` (existing `app.ai.session_id` telemetry may remain for
  compatibility)
- `app.conversation.id`
- `messaging.message.id`

## Verification

1. Unit: resumable boundaries trim trailing assistant-only messages when needed.
2. Component/integration: queue-driven resume restores `agent.state.messages` and calls `continue()`.
3. Integration: a cooperative yield resumes in a later worker and reaches a successful terminal reply.
4. Integration: a user follow-up during active execution is appended to the mailbox and injected into the same conversation at the next safe boundary.
5. Component/integration: auth-driven resume restores the same active skill/MCP tool universe before `continue()`.
6. Component/integration: eager sandbox/artifact persistence preserves resumed tool context across execution chunks.
7. Component/integration: fresh follow-up runs can recover Pi history from the active/last agent session log without depending on conversation-state Pi transcript mirroring.
8. Manual/eval: once assistant text is already visible, recovery does not auto-reconcile partial thread output.
9. Component/integration: transient provider failures retry with `continue()` from a safe boundary and do not duplicate prior tool execution.
10. Component/integration: successful provider activation appends one `mcp_provider_connected` event, and resume restores providers from those events. Legacy Pi-message inference is allowed only while pre-event session logs still exist.
11. Component/integration: a user message arriving while a session is `awaiting_resume` reaches Pi history (steered or appended) and receives an answer; it is never marked injected without a session-log append.
12. Component/integration: a lease-expired `running` session is resumed or terminally failed with a visible fallback; it never no-ops.
13. Unit: redelivery after a lost input commit does not duplicate the user prompt or bootstrap context in Pi history.
14. Unit: a failed host-only activity append is swallowed and the model turn continues.

## Related Specs

- [Conversation Storage Spec](./conversation-storage.md)
- [Terminology Spec](./terminology.md)
- [Harness Agent Spec](./harness-agent.md)
- [Task Execution Spec](./task-execution.md)
- [Agent Execution Spec](./agent-execution.md)
- [Instrumentation Spec](./instrumentation.md)
