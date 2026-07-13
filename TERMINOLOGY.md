# Terminology

## Purpose

Define Junior's canonical runtime terminology so documentation, code comments,
tests, and storage names use the same words for the same execution concepts.

Agent frameworks use `turn` inconsistently. Some use it for one model
invocation, some for one agent's speaking slot. Junior uses `turn` for exactly
one concept — one response-producing cycle — and pins the smaller execution
units with explicit nouns (`slice`, `step`) so that ambiguity cannot return.

## Scope

- Runtime execution names used in repository documentation and new code.
- Conversation, source, destination, message, turn, slice, and step boundaries.
- Durable conversation storage nouns shared with
  `packages/junior/src/chat/conversations/README.md`.
- Historical names that remain in existing APIs, storage keys, and telemetry.

## Non-Goals

- Renaming every existing `run`-named identifier in one migration.
- Defining product copy for user-facing Slack or local CLI messages.
- Defining provider-specific terminology for OpenAI, LangGraph, AutoGen, Pi, or
  other agent frameworks.

## Contracts

### Canonical Terms

- **Conversation**: the thread-level or session-level container identified by
  `conversationId`. Slack conversations usually map to one normalized thread.
  Local CLI conversations map to one process-scoped local session.
  `conversationId` is globally unique across sources. A conversation may have a
  parent conversation when it records a subagent's execution history.
- **Source**: where an inbound event came from, such as Slack, local CLI,
  scheduler, or plugin dispatch.
- **Destination**: where Junior should send output or side effects.
- **Inbound message**: one normalized source event that should be made
  available to the agent.
- **Agent input**: the batch of inbound message content, context, and runtime
  metadata selected for a turn.
- **Steering message**: an inbound user message that interrupts the active turn
  at the next safe boundary. Steering ends the active turn prematurely — that
  turn gets no final response — and starts a new turn; steering messages that
  arrive together may batch into one new turn. Matches Pi's `steer` input
  path.
- **Follow-up message**: an inbound user message that does not interrupt; it
  queues until the previous turn is done and then starts the next turn.
  Messages that arrive while the conversation is idle start the next turn the
  same way. Matches Pi's `followUp` input path.
- **Turn**: one request-to-final-response cycle. A turn begins when a request
  is handed off to the agent (one accepted inbound message, or the batch
  pending when execution starts) and ends when the agent returns the final
  response for that request or fails terminally. Steering and follow-up are
  the two ways new user messages enter: steering interrupts the active turn
  when safe and starts a new one; a follow-up queues until the previous turn
  is done. Turn boundaries are attribution boundaries, not execution
  boundaries. A turn may span multiple execution runs and slices. It is not one
  model invocation.
- **Run**: one bounded attempt to advance a turn. A run ends when the turn
  completes, pauses, cooperatively yields, or fails. A later run may resume the
  same durable turn without repeating committed side effects.
- **Execution slice**: one serverless invocation segment of a run.
- **Agent step**: one durable event inside execution history — one Pi message
  or one host runtime fact. Tool call requests are not standalone steps: they
  are content parts of the assistant-message step that emitted them, and one
  assistant step may request several tool calls. Each tool result is its own
  step. A call and its result are therefore never one step: the assistant step
  is recorded when the model emits it, result steps when execution finishes,
  and recovery may find the call without its results. Safe resume boundaries
  require the result steps to be durably recorded.
- **Context epoch**: one generation of the model-visible context for a
  conversation. An explicit `initial` marker opens epoch 0; compaction,
  handoff, or rollback opens the next epoch when it rebuilds context. Steps in
  older epochs remain audit history and no longer contribute to model context.
- **Model profile**: a stable host-owned name bound to a context epoch.
  `standard` owns initial conversations, `handoff` is the default upgrade
  target, and hosts may configure additional names. Runtime resolves the name
  through current configuration; models never select raw provider ids.
- **Epoch model id**: the exact resolved model recorded when a context epoch
  opens. It is audit evidence for configuration drift, not runtime authority or
  a model pin.
- **Message**: one stored visible conversation message (user, assistant, or
  system) in the conversation record, or one normalized inbound source event.
- **Transcript**: the reporting read model rendered from stored conversation
  messages and agent steps, subject to redaction. Storage tables and runtime
  interfaces must not use `transcript` to name stored data.
- **Session record**: the persisted read model for one resumable turn. Existing
  code may still call this a `turn session` for historical reasons.
- **Conversation execution**: the mutable operational state for one
  conversation, including mailbox state, worker lease, checkpoint timestamps,
  and whether the conversation is idle or active.
- **Reasoning level**: the configured or adaptively selected amount of model
  reasoning for a turn (`none`, `low`, `medium`, `high`, or `xhigh`). Junior
  uses `reasoning` in domain names, documentation, configuration, storage,
  diagnostics, and telemetry. `thinkingLevel` and `ThinkingLevel` are allowed
  only at Pi SDK boundaries where they are upstream API names; translate at
  that boundary.

### `turn`

`turn` is the canonical term for response-producing execution. A turn may need
multiple bounded runs to finish, but retries and resumptions do not create a new
turn unless new user input starts one.

Rules:

- Use `turn` only with the canonical definition. One model invocation is not a
  turn; it is part of a turn. A steering message does not extend the active
  turn; it ends that turn prematurely and starts a new one. Steering messages
  that arrive together may batch into a single new turn.
- New interfaces and read models use `turnId` where they need a stable
  identifier for one turn.
- Historical documentation may still say `agent run` where it means a turn.
  Interpret the surrounding contract before renaming it; current runtime
  documentation uses `run` for a bounded attempt to advance a turn.

### `run`

`run` is the canonical term for one bounded attempt to advance a turn.

Allowed uses:

- Existing identifiers such as `executeAgentRun`, `runId`, the deployed
  `junior_conversations.run_id` column, and `run.actor` / `run.actors`.
- External framework terminology (for example OpenAI runs) when quoting or
  directly describing that framework's API.

When touching a historical `run` name that actually represents a turn, do not
rename it opportunistically. Prefer comments that clarify the current meaning:

> historical agent-run name; represents a turn

### `reply`

Use `reply` only for destination-visible messages owned by delivery and
reply-policy layers.

Allowed uses:

- Delivery and policy identifiers that already describe destination-visible
  messages, such as `SubscribedReplyPolicy`, `ReplyDeliveryPlan`, and
  `slack/reply.ts`.
- Historical identifiers in existing delivery-facing APIs, storage fields, and
  tests when the value is a destination-visible message.
- User-facing product copy that describes a visible response in Slack, local
  CLI, or another destination.

Agent execution layers use turn/run/slice vocabulary instead. New
executor-boundary identifiers must not use `reply` or `respond`; use `turn`,
`run`, `result`, `outcome`, or `delivery` terms according to ownership.

When touching historical `reply` names, do not rename them opportunistically.
Prefer comments that clarify the current meaning:

> historical delivery reply name; represents a destination-visible message

### Naming Rules

- Use `turn` for response-producing execution.
- Use `run` for one bounded attempt to advance a turn.
- Use `slice` for one resumable serverless invocation segment of a run.
- Use `step` for model/tool/action events inside a turn.
- Use `context epoch` for one generation of the model-visible context. It is
  stored as an integer opened by an explicit marker, starts at 0, and advances
  on each context rebuild.
- Use `reply` only for destination-visible messages owned by delivery or
  reply-policy layers.
- Use `message` for source events and stored visible conversation messages.
- Use `conversation` for the durable container that owns visible history and
  execution state.
- Use `transcript` only for reporting read models rendered from stored
  messages and steps.
- Use `sessionId` only where it already names the persisted agent-run session
  key. New APIs should prefer `turnId` when no historical compatibility
  constraint exists.

## Failure Model

Ambiguous terminology is a design failure, not a runtime failure. Reviewers
should block new documentation or public interfaces that use `turn` for a
single model invocation, or that use `run` for both a turn and a bounded attempt
without explicitly preserving a historical name.

## Observability

Existing telemetry names that include `run` may remain for compatibility.
New telemetry should prefer:

- `app.ai.turn_id`
- `app.ai.execution_slice_id`
- `app.ai.step_id`

Use existing OpenTelemetry semantic keys where they apply before adding
`app.*` keys.

## Verification

- New or edited documentation must link to this file when defining execution
  terms.
- New tests should use fixture ids such as `turn_1`. Existing run-named
  fixtures remain until their owning APIs are renamed.
- Broad renames from historical `run` names require targeted migration tests
  for storage keys, telemetry, and callback routing.

## Related Documentation

- `packages/junior/src/chat/README.md`
- `packages/junior/src/chat/runtime/README.md`
- `packages/junior/src/chat/task-execution/README.md`
- `packages/junior/src/chat/conversations/README.md`
