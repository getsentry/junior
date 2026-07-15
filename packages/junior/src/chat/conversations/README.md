# Conversation Storage

This module owns the durable product record for conversations, visible messages,
conversation events, compaction boundaries, search, and retention.

## Records

- Conversation rows own canonical source, destination, participant, visibility,
  lineage, and retention metadata. Their execution cursor, status, duration,
  and usage columns are materialized reporting/control aggregates, not
  transcript or event-history authority.
- Visible-message events are the destination-facing user and assistant history.
  `junior_conversation_messages` is their rebuildable search read model, never
  a hydration source or second history authority.
- Conversation events are the versioned, append-only execution history used to
  restore Pi state. Pi messages and context are projections of this log, not a
  second authority.
- Redis turn-session records retain bounded resumability metadata and event
  sequence cursors. Their summary indexes and the SQL execution/usage columns
  are operational projections; Pi state is materialized from conversation
  events rather than stored in either aggregate.
- Context epochs identify replacement boundaries created by compaction or model
  handoff.
- Child rows carry immutable parent/root, parent-turn, and exact parent-event
  correlation. Shared children additionally retain that parent sequence as
  their context fork; isolated children retain no fork.
- The Pi adapter recursively composes a shared child's pinned ancestor prefix
  with only the child's current local epoch. Initial and inheriting rollback
  markers preserve that relationship; compaction, handoff, and isolated epochs
  are self-contained. Child sequence cursors count only child-local events, and
  commits reject any mutation of the inherited prefix.
- Provider payloads and old state-store mirrors are inputs only to the explicit
  operator migration under `cli/upgrade`; they are not runtime dependencies or
  canonical product records.

The schemas and migrations under `sql/` are authoritative.

`junior_conversation_events` is the single physical event table. Every row
persists its schema version, sequence, context epoch, type, payload, and
timestamp. The `(conversation_id, seq)` key is both stable event identity and
the lease-fencing tripwire.

The Junior-owned `message` event retains an opaque model-continuity payload and
canonical provenance. The Pi adapter is the only runtime module that
interprets that payload as a Pi message. The legacy Redis `pi_message` shape
exists only in the explicit operator backfill and is absent from the live
conversation module graph.

Reporting APIs must project events into an authorized, redacted product
contract. Raw `ConversationEventData` is an internal persistence boundary and
must not become a dashboard or external API payload.

The reporting API owns a strict ordered event projection with only safe product
fields. Conversation detail exposes that projection as its sole history, and
the dashboard derives its view directly from canonical sequence order. Display
text comes only from visible-message events; model messages become content-free
activity, while provider receipts, delivery commands, failure codes,
authorization identifiers, arbitrary metadata, and persistence-envelope fields
remain internal.

## Write Rules

- Persist user input before agent execution.
- Persist assistant text only after successful destination delivery.
- Append each visible-message fact and update its SQL read model in one
  transaction under the conversation event lock.
- Append conversation events in monotonic sequence order.
- Correlate each turn with one `turn_started` event after its input messages and
  one first-writer-wins `turn_completed` or `turn_failed` terminal event.
- Persist only allowlisted failure classifications and opaque Sentry event IDs;
  raw exceptions, provider payloads, and URLs are not lifecycle data.
- Restore state directly from durable SQL events rather than a duplicate
  transcript cache or lazy legacy import.
- Compaction replaces prior model context without rewriting visible history.
- Imports and migrations are idempotent and preserve stable conversation IDs.
- Establish child lineage and its parent `subagent_started` reference through
  the SQL-backed lineage service in one transaction. Retries must match the
  original parent, root, turn, event, and history mode exactly.
- Never copy inherited Pi messages into the child log. Resolve every restore
  path through the lineage-aware Pi projection and bound each ancestor at its
  immutable fork before reading the next descendant.
- Shared projection has an explicit maximum lineage depth. Parent event reads
  currently load the parent's full retained history before selecting the fork;
  a bounded store read remains a future optimization rather than a second
  projection contract.

## Visibility And Retention

Destination visibility is the privacy authority. Messages, conversation events, child
conversations, and plugin projections inherit it. Retention is enforced by the
conversation purge paths and must distinguish expired content from redacted
content.

Follow `../../../../../policies/data-redaction.md` and
`../../../../../policies/runtime-boundary-schemas.md`.

## Deployment Safety

- Schema changes are expand-first and compatible with the currently deployed
  reader and writer during normal rollouts. Explicit hard cutovers document
  their worker-stop gate here.
- Data rewrites use explicit migrations or resumable import code.
- Live workers never read Redis session logs, advisor blobs, or legacy
  thread-state to restore history. Operators must run `junior upgrade` before
  serving retained pre-cutover conversations.
- The Redis decoder and backfill writer remain under `cli/upgrade` only for the
  bounded operator-migration horizon; they can be deleted independently once
  every supported deployment has completed that upgrade.
- Stop every pre-event-log worker before running the event-table schema cut.
  The migration renames `junior_agent_steps` directly and intentionally
  provides no rolling compatibility view.
- Run the final rerunnable visible-message backfill while workers remain
  stopped. Its fail-closed zero-gap verification is the cutover gate; start new
  workers only after it passes.
- Purge and migration jobs operate in bounded batches and are safe to retry.
- The lineage backfill fills historical roots only. Missing historical turn,
  event, and fork correlation remains null and therefore isolated.

Representative coverage lives in
`packages/junior/tests/integration/conversation-sql.test.ts` and the
conversation storage component tests.

The local runtime writes lifecycle events, and detail reporting reduces
`turn_failed` to one privacy-safe error marker. Slack delivery, dispatch, and
continuation recovery remain follow-up work.

The structural failure marker never exposes failure code or event ID. An
independently delivered fallback remains ordinary visible content, so a public
conversation preserves its approved `event_id` reference while private detail
redaction removes the fallback text and retains only structural metadata.

Lifecycle appends have stable idempotency keys so explicitly retried calls are
safe, but they are not an outbox transaction with an external destination. A
process death after destination acceptance and before the
visible/session/terminal writes can still leave a started turn without a
terminal event. The next delivery slice must add durable intent/receipt
reconciliation for Slack before claiming crash-safe terminality.

Subagent executions own separate child event streams. The parent records only
idempotent start/end references, and child events are never copied into the
parent. New child creation requires an existing parent turn and complete
lineage; only a metadata-bare row created by an earlier child event append may
be upgraded. Reparenting an existing conversation is rejected.
