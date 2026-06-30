# Terminology Spec

## Metadata

- Created: 2026-06-12
- Last Edited: 2026-06-12

## Purpose

Define Junior's canonical runtime terminology so specs, code comments, tests,
and storage names use the same words for the same execution concepts.

Agent frameworks use `turn` inconsistently. Some use it for one model
invocation, some for one agent's speaking slot, and some avoid it in favor of
run/thread concepts. Junior uses explicit execution nouns instead.

## Scope

- Runtime execution names used in specs and new code.
- Conversation, source, destination, message, run, slice, and step boundaries.
- Historical names that remain in existing APIs, storage keys, and telemetry.

## Non-Goals

- Renaming every existing `turn` identifier in one migration.
- Defining product copy for user-facing Slack or local CLI messages.
- Defining provider-specific terminology for OpenAI, LangGraph, AutoGen, Pi, or
  other agent frameworks.

## Contracts

### Canonical Terms

- **Conversation**: the thread-level or session-level container identified by
  `conversationId`. Slack conversations usually map to one normalized thread.
  Local CLI conversations map to one process-scoped local session.
- **Source**: where an inbound event came from, such as Slack, local CLI,
  scheduler, or plugin dispatch.
- **Destination**: where Junior should send output or side effects.
- **Inbound message**: one normalized source event that should be made
  available to the agent.
- **Agent input**: the batch of inbound message content, context, and runtime
  metadata selected for an agent run.
- **Agent run**: one response-producing execution for a conversation. A run may
  consume multiple inbound messages at safe boundaries, call many tools, and
  span multiple serverless invocations before final delivery.
- **Execution slice**: one serverless invocation segment of an agent run.
- **Agent step**: one model, tool, handoff, action, or other internal event
  represented inside durable execution history.
- **Session record**: the persisted read model for one resumable agent run.
  Existing code may still call this a `turn session` for historical reasons.
- **Conversation execution**: the mutable operational state for one
  conversation, including mailbox state, worker lease, checkpoint timestamps,
  and whether the conversation is idle or active.

### `turn`

Do not use `turn` for new agent-run concepts in specs, comments, test fixture
ids, storage keys, or public interfaces.

Allowed uses:

- User-message response policy that is already named around turns, such as
  `agent-turn-handling.md`, until that spec is intentionally renamed.
- Historical identifiers such as `activeTurnId`, `turn-session`, turn-session
  storage keys, and existing telemetry names.
- External framework terminology when quoting or directly describing that
  framework's API.

When touching historical `turn` names, do not rename them opportunistically.
Prefer comments that clarify the current meaning:

> historical turn-session name; represents an agent-run session record

### Naming Rules

- Use `run` for response-producing execution.
- Use `slice` for one resumable serverless invocation segment.
- Use `step` for model/tool/action events inside a run.
- Use `message` for source events and transcript entries.
- Use `conversation` for the durable container that owns visible history and
  execution state.
- Use `sessionId` only where it already names the persisted agent-run session
  key. New APIs should prefer `runId` or `sessionRecordId` when no historical
  compatibility constraint exists.

## Failure Model

Ambiguous terminology is a design failure, not a runtime failure. Reviewers
should block new specs or public interfaces that introduce `turn` for agent-run
concepts unless the change is intentionally preserving a historical name.

## Observability

Existing telemetry names that include `turn` may remain for compatibility.
New telemetry should prefer:

- `app.ai.run_id`
- `app.ai.execution_slice_id`
- `app.ai.step_id`

Use existing OpenTelemetry semantic keys where they apply before adding
`app.*` keys.

## Verification

- New or edited specs must link to this spec when defining execution terms.
- New tests should use fixture ids such as `run_1` instead of `turn_1` unless
  the test targets a historical turn-named API.
- Broad renames from historical `turn` names require targeted migration tests
  for storage keys, telemetry, and callback routing.

## Related Specs

- `./task-execution.md`
- `./agent-session-resumability.md`
- `./agent-turn-handling.md`
- `./identity.md`
