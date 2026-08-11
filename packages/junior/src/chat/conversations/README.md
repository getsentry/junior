# Conversation Storage

This module owns Junior's durable conversation record, search, and retention.

## Location Read Model

`Conversation.location` is the provider-location read model for new code. A
location keeps Junior's id plus the provider's tenant and location identifiers.
Conversation privacy remains in `Conversation.visibility`. Provider-specific
event attribution, such as Slack `threadTs` and `messageTs`, remains in
`sessionSource`.

During the destination cutover, the linked destination row remains the durable
location authority. Local conversations have no provider location.

## Storage Model

`junior_conversation_events` is the only transcript/history table. Every row
has a stable `(conversation_id, seq)` identity, an event type, a versioned JSON
payload, and a timestamp.

Platform transcript and agent-history events intentionally describe different
facts:

- `message` records exact source or destination chat content. It is the
  authority for transcript display, delivery handling, privacy, and search.
- `user_message`, `assistant_message`, and `tool_result` record native,
  replayable agent-history items. They are the authority for the next model
  request and may contain transformed input, assistant tool calls, or tool
  results that were never platform chat messages.

`user_message` provenance distinguishes user instructions from ambient context.
Tool calls remain ordered content inside the `assistant_message` that produced
them; the corresponding results are separate `tool_result` events.

`message_updated` records later delivery or hydration state for an existing
message. It updates that message's projection without pretending the same chat
message arrived twice. `message_handled` remains the compact lifecycle fact
used to prevent redelivery.

A platform message and an agent-history item can correspond to the same turn,
but they are not interchangeable. For example, delivered fallback text is a
`message` even when it is not part of Pi history, while a `tool_result` is never
delivered as a platform message. Keeping both facts in the same ordered event
stream avoids a second transcript authority without conflating product history
with agent history.

Search queries `message` payloads directly through the partial GIN index on the
event table. There is no message projection table. Cross-thread search stays
inside one Slack workspace and only public destinations. An optional filter may
narrow by destination channel id.

## Agent History Replacement

Normal execution appends native agent-history events. `compaction` and
`handoff` are the only live events that replace active agent history. Each
stores the exact replacement history in the same native shapes; later native
events append to it. The internal `history_version` column makes loading that
active history efficient. There is no initial-history event. Database migrations
normalize older history shapes before the runtime reads them.

## Conversation Fork

`fork.ts` owns the internal fork path. A fork creates a **new root** conversation
(not a subagent child via `parent_conversation_id`) and seeds it with the source
conversation's active agent history through a cutoff seq or platform message id.
It records a `junior/conversation_forked` structured event as the backlink. The
fork inherits the source destination visibility and never widens private or
unknown sources to public. It does not clone execution state, mailbox, schedules,
watches, approvals, or live tool side effects.

Volatile `<runtime-turn-context>` bootstrap is kept only in an unfinished turn's
session record. It is removed before SQL history is written and restored for an
auth or timeout resume, so agent replay does not need an automatic rollback.

Message summarization is separate from agent-history compaction. A
`messages_summarized` event stores the latest bounded summaries used to render
older source-thread context; it does not replace Pi history.

## Write Rules

- Persist inbound `message` events before agent execution.
- Persist assistant `message` events only after destination acceptance.
- Append stable native agent-history events in sequence order.
- Reject attempts to mutate an already committed agent-history prefix.
- Replace agent history only through explicit compaction or handoff.
- Restore transcripts and agent history directly from conversation events.
- Keep imports and migrations idempotent and preserve conversation IDs.

Reporting APIs project an authorized, redacted contract from the event stream.
Raw event payloads are internal and must not become dashboard or external API
payloads. Reporting keeps destination-visible `message` events separate from
assistant reasoning. Mixed reasoning and tool history extends the existing
`tool_calls` event with ordering metadata; reasoning-only history uses
`assistant_message`. Tool payloads and lifecycle remain owned by `tool_calls`.
Host-owned `native_event` rows under the reserved `junior` namespace carry
transcript metadata such as account link and unlink changes. They are visible
in reporting but never enter model history. Plugin-owned `plugin_event` rows
use the same presentation contract under a plugin namespace. The deferred
`searchConversationEvents` tool searches that same log. It defaults to the
current conversation and can target another retained public conversation in the
same Slack workspace. Oversized
event data is represented by identifying fields and its original JSON byte
size. The complete event array also has a fixed byte budget and reports omitted
events through its pagination contract.

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

Destination visibility is the privacy authority. Messages, agent-history
items, child conversations, agent invocations, and plugin projections inherit
it. Retention
distinguishes expired content from redacted content and purges the complete
child tree, including delegated input and terminal results.

Every conversation row carries its owning `root_conversation_id`. Roots
self-reference; descendants copy the root from their immediate parent when
they are created. `parent_conversation_id` remains the tree-navigation edge,
while REST authorization joins directly through the indexed root relation.
Missing or structurally invalid root metadata fails closed.

REST endpoints resolve access for their bounded conversation IDs and pass the
result through one shared summary projection. The same conversation therefore
has the same participant, visibility, title, and channel fields whether it
appears in the feed, detail, People, or Location response.

Top-level REST summaries and details roll persisted usage across every row with
the same root, including descendants absent from the current event projection.
Feed aggregation is limited to the already selected root IDs, and detail
aggregation selects one root through `root_conversation_id`; both use the root
index. Per-model detail usage joins those same tree rows to their indexed
events. System and Location aggregates count roots while summing metrics across
their persisted tree rows. A child resource still reports its own usage when
fetched directly.

Follow `../../../../../policies/data-redaction.md` and
`../../../../../policies/runtime-boundary-schemas.md`.

## Deployment Safety

- Existing pre-Drizzle deployments must drain work, stop old workers, and
  complete the `0.107.1` bridge upgrade before installing a later release.
- Keep old workers stopped between the bridge upgrade and the later deployment
  so they cannot write legacy state after it has been imported.
- Upgrades from releases that write `agent_step` events must also block ingress,
  drain active and resumable work, and stop old workers before running the
  native agent-history migration. Deploy the new runtime before restarting
  workers so legacy rows cannot be appended after the one-time rewrite.
- Current `junior upgrade` runs only core and enabled-plugin Drizzle SQL
  migrations. Live workers restore history exclusively from conversation
  events.

Representative coverage lives in the conversation storage component tests and
`packages/junior/tests/integration/conversation-sql.test.ts`.
