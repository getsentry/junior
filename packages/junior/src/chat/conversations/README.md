# Conversation Storage

This module owns the durable product record for conversations, visible messages,
conversation events, compaction boundaries, search, retention, and legacy import.

## Records

- Conversation rows identify the source, destination, participants, visibility,
  and lifecycle metadata.
- Visible messages are the destination-facing user and assistant history.
- Conversation events are the versioned, append-only execution history used to
  restore Pi state. Pi messages and context are projections of this log, not a
  second authority.
- Context epochs identify replacement boundaries created by compaction or model
  handoff.
- Provider payloads and old state-store mirrors are migration inputs, not
  canonical product records.

The schemas and migrations under `sql/` are authoritative.

`junior_conversation_events` is the single physical event table. Every row
persists its schema version, sequence, context epoch, type, payload, and
timestamp. The `(conversation_id, seq)` key is both stable event identity and
the lease-fencing tripwire.

The Junior-owned `message` event retains an opaque model-continuity payload and
canonical provenance. The Pi adapter is the only module that interprets that
payload as a Pi message; the legacy Redis `pi_message` shape exists only as a
bounded import input.

Reporting APIs must project events into an authorized, redacted product
contract. Raw `ConversationEventData` is an internal persistence boundary and
must not become a dashboard or external API payload.

## Write Rules

- Persist user input before agent execution.
- Persist assistant text only after successful destination delivery.
- Append conversation events in monotonic sequence order.
- Restore state from durable events rather than a duplicate transcript cache.
- Compaction replaces prior model context without rewriting visible history.
- Imports and migrations are idempotent and preserve stable conversation IDs.

## Visibility And Retention

Destination visibility is the privacy authority. Messages, conversation events, child
conversations, and plugin projections inherit it. Retention is enforced by the
conversation purge paths and must distinguish expired content from redacted
content.

Follow `../../../../../policies/data-redaction.md` and
`../../../../../policies/runtime-boundary-schemas.md`.

## Deployment Safety

- Schema changes are expand-first and compatible with the currently deployed
  reader and writer during rollout.
- Data rewrites use explicit migrations or resumable import code.
- Legacy fields remain readable only for the migration window and are removed
  after the new authority is verified.
- The database-only `junior_agent_steps` compatibility view supports old workers
  during the 0.103.x rollout and is removed in 0.104.0; it stores no duplicate
  rows and is never an application read or write path.
- Purge and migration jobs operate in bounded batches and are safe to retry.

Representative coverage lives in
`packages/junior/tests/integration/conversation-sql.test.ts` and the
conversation storage component tests.
