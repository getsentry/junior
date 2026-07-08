# Terminology Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-07-08

## Purpose

Define Junior's canonical runtime terminology so specs, code comments, tests,
and storage names use the same words for the same execution concepts.

Agent frameworks use `turn` inconsistently. Some use it for one model
invocation, some for one agent's speaking slot. Junior uses `turn` for exactly
one concept — one response-producing cycle — and pins the smaller execution
units with explicit nouns (`slice`, `step`) so that ambiguity cannot return.

## Scope

- Runtime execution names used in specs and new code.
- Conversation, source, destination, message, turn, slice, and step boundaries.
- Durable conversation storage nouns shared with `./conversation-storage.md`.
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
- **Turn**: one response-producing cycle for a conversation. A turn begins when
  accepted inbound input starts execution and ends at finalized delivery or
  terminal failure. A turn may absorb additional inbound messages that arrive
  before finalization, and may span multiple execution slices. It is not one
  model invocation.
- **Execution slice**: one serverless invocation segment of a turn.
- **Agent step**: one model, tool, handoff, action, or other internal event
  represented inside durable execution history.
- **Context epoch**: one generation of the model-visible context for a
  conversation. The epoch advances when compaction or rollback rebuilds the
  context. Steps in older epochs remain audit history and no longer contribute
  to model context.
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

### `turn`

`turn` is the canonical term for response-producing execution. Earlier versions
of this spec banned `turn` in favor of `agent run`. That guidance is reversed:
the runtime's storage keys, state fields, and telemetry already use turn
vocabulary, and the canonical definition above removes the ambiguity that
motivated the ban.

Rules:

- Use `turn` only with the canonical definition. One model invocation is not a
  turn; it is part of a turn. One inbound message is not a turn; a turn may
  absorb several.
- New interfaces and read models use `turnId` where they need a stable
  identifier for one turn.
- Specs written before this flip may still say `agent run` in contract prose.
  Read `agent run` and `turn` as the same concept; rename spec prose when the
  owning spec is next edited, not opportunistically.

### `run`

`agent run` is the historical synonym for turn.

Allowed uses:

- Existing identifiers such as `executeAgentRun`, `runId`, the deployed
  `junior_conversations.run_id` column, and `run.actor` / `run.actors` from
  `./multi-actor-runs.md`.
- External framework terminology (for example OpenAI runs) when quoting or
  directly describing that framework's API.

When touching historical `run` names, do not rename them opportunistically.
Prefer comments that clarify the current meaning:

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

Agent execution layers use turn/slice vocabulary instead. New executor-boundary
identifiers must not use `reply` or `respond`; use `turn`, `result`, `outcome`,
or `delivery` terms according to ownership.

When touching historical `reply` names, do not rename them opportunistically.
Prefer comments that clarify the current meaning:

> historical delivery reply name; represents a destination-visible message

### Naming Rules

- Use `turn` for response-producing execution.
- Use `slice` for one resumable serverless invocation segment.
- Use `step` for model/tool/action events inside a turn.
- Use `context epoch` for one generation of the model-visible context. It is
  stored as an integer that starts at 0 and advances on each context rebuild.
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
should block new specs or public interfaces that use `turn` for a single model
invocation, or that introduce new `agent run` names for turn concepts, unless
the change is intentionally preserving a historical name.

## Observability

Existing telemetry names that include `run` may remain for compatibility.
New telemetry should prefer:

- `app.ai.turn_id`
- `app.ai.execution_slice_id`
- `app.ai.step_id`

Use existing OpenTelemetry semantic keys where they apply before adding
`app.*` keys.

## Verification

- New or edited specs must link to this spec when defining execution terms.
- New tests should use fixture ids such as `turn_1`. Existing run-named
  fixtures remain until their owning APIs are renamed.
- Broad renames from historical `run` names require targeted migration tests
  for storage keys, telemetry, and callback routing.

## Related Specs

- `./task-execution.md`
- `./agent-session-resumability.md`
- `./agent-turn-handling.md`
- `./conversation-storage.md`
- `./identity.md`
