# Conversation Storage

This module owns Junior's durable conversation record, search, and retention.

## Storage Model

`junior_conversation_events` is the only transcript/history table. Every row
has a stable `(conversation_id, seq)` identity, an event type, a versioned JSON
payload, and a timestamp.

Two primary event types intentionally describe different facts:

- `message` records exact source or destination chat content. It is the
  authority for transcript display, delivery handling, privacy, and search.
- `agent_step` records one replayable Pi history entry. It is the authority for
  the next agent request and may contain transformed input, assistant tool
  calls, or tool results that were never chat messages.

`message_updated` records later delivery or hydration state for an existing
message. It updates that message's projection without pretending the same chat
message arrived twice. `message_handled` remains the compact lifecycle fact
used to prevent redelivery.

A chat message and an agent step can correspond to the same turn, but they are
not interchangeable. For example, delivered fallback text is a `message` even
when it is not part of Pi history, while a tool result is an `agent_step` even
though it is never delivered as a chat message. Keeping both facts in the same
ordered event stream avoids a second transcript authority without conflating
product history with agent history.

Search queries `message` payloads directly through the partial GIN index on the
event table. There is no message projection table.

## Agent History Replacement

Normal execution appends `agent_step` events. `compaction` and `handoff` are
the only live events that replace active agent history. Each stores the exact
replacement history; later `agent_step` events append to it. The internal
`history_version` column makes loading that active history efficient. There is
no initial-history event.

`rollback` is not a live operation. The reader recognizes the legacy event
only so conversations written by older deployed code remain recoverable during
the migration window.

Volatile `<runtime-turn-context>` bootstrap is kept only in an unfinished turn's
session record. It is removed before SQL history is written and restored for an
auth or timeout resume, so agent replay does not need an automatic rollback.

Message summarization is separate from agent-history compaction. A
`messages_summarized` event stores the latest bounded summaries used to render
older source-thread context; it does not replace Pi history.

## Write Rules

- Persist inbound `message` events before agent execution.
- Persist assistant `message` events only after destination acceptance.
- Append stable `agent_step` events in sequence order.
- Reject attempts to mutate an already committed agent-history prefix.
- Replace agent history only through explicit compaction or handoff.
- Restore transcripts and agent history directly from conversation events.
- Keep imports and migrations idempotent and preserve conversation IDs.

Reporting APIs project an authorized, redacted contract from the event stream.
Raw event payloads are internal and must not become dashboard or external API
payloads.

## Stored Event Compatibility

Live writers accept only the canonical event types and current schema version.
Readers preserve an unsupported type or schema version as an opaque `unknown`
event so one old row cannot make the conversation log unreadable. Reporting,
search, and other observational projections ignore those events.

Active agent-history replay is stricter: it rejects an `unknown` event rather
than risk silently changing model context. Upgrade scripts normalize historical
formats as they become known. A malformed event whose type and schema version
are already supported is treated as corrupt data and rejected, not downgraded
to `unknown`.

## Visibility And Retention

Destination visibility is the privacy authority. Messages, agent steps, child
conversations, and plugin projections inherit it. Retention distinguishes
expired content from redacted content and purges the complete child tree.

Follow `../../../../../policies/data-redaction.md` and
`../../../../../policies/runtime-boundary-schemas.md`.

## Deployment Safety

- Stop old workers before the event-table hard cutover.
- Run `junior upgrade` before serving retained pre-cutover conversations.
- Drain running or resumable turns before resequencing migrated events.
- Legacy Redis and pre-cutover SQL records are migration inputs only; live
  workers restore history exclusively from conversation events.
- Purge and migration jobs operate in bounded, retry-safe batches.

Representative coverage lives in the conversation storage component tests and
`packages/junior/tests/integration/conversation-sql.test.ts`.
