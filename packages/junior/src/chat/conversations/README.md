# Conversation Storage

This module owns Junior's durable conversation record, search, and retention.

## Location Read Model

`Conversation.location` is the single Location field for new code. No Location
means the Conversation stays in Junior's API and UI. A Location names the place
outside Junior where a provider can deliver the Conversation. For Slack, a
complete Location identifies the workspace, channel, and thread. Conversation
privacy remains in `Conversation.visibility`.

A Run carries the Conversation Location when the agent or tools need it.
Source describes the input and does not contain Location. Delivery is created
for the Location and does not repeat it.

The Conversation row stores the complete Location in `location_json`. Local
Conversations have no Location.

TODO(dcramer): Remove `sessionSource` after resume reads the saved Turn Source
and every Conversation place reader uses Location.

TODO(dcramer): Remove the `destination_id` and `source_json` Location read
fallback after no deployed writer can omit `location_json` and a backfill has
populated rows that those writers created during deployment.

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

Version-two agent history items store message fields as JSON strings in
`payload.message`. User provenance stays outside the string. Handoff and
compaction store each replacement `item` as a JSON string. Encoding happens
before SQL sanitization to preserve nested key order and NUL characters.
Replay decodes all message fields; it does not rebuild them from a field list.

SQL reports still read `model`, `provider`, `usage`, and `toolCallId` from the
payload. Replay ignores these copies. No second history store is added.

Version-one rows remain readable, but cannot recover data already lost. Stop
old workers before deploying version-two writers. Old releases cannot replay
version-two events. Rollback requires a compatible reader. No database schema
migration is required.

The agent history integration test checks stored messages and Pi's serialized
request prefix through real Postgres. Only model HTTP responses are faked.
The comparison excludes cache markers, not message fields or key order.
Stable request prefixes do not guarantee provider cache hits.

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

`<runtime-turn-context>` is part of the exact model history. Normal execution
stores and replays it unchanged. Reporting projections can omit it from the UI.
Compaction and handoff can replace it with the current context.

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

## SQL Write Lock

All metadata and event writes for one conversation use the
`junior_conversation:<conversationId>` advisory lock. They cannot lock shared SQL
rows in opposite order because their transactions do not overlap.

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

## Object annotations and Message cards

An object annotation holds the latest saved facts for an object in one
Conversation. The provider owns its key, type, title, status, and optional fields.
It is not the authoritative object store.

Successful plugin tools return `objectAnnotations`. Core assigns the plugin
owner, saves the annotations, and includes their snapshots in the tool result's
`objectCards`. Hosted MCP hooks can return the same annotations. Raw MCP responses
cannot set cards. Automation tools use the same saved object contract.

`annotations.upsert` is storage-only. Webhook updates do not queue a card or
start a Turn. A producer can use this path for a silent update. Returned
`objectAnnotations` are a deliberate selection for the next visible reply.

Pending cards come from committed successful tool results, not a scan of changed
annotation rows. The latest selection per owner/key wins. Failed or timed-out
results do not replace earlier cards. Removal results suppress earlier selections.
A visible Message consumes its cards. A new Turn does not inherit cards from a
silent Turn. Store each delivered snapshot in the Message so background updates
do not rewrite stored history. The web transcript shows this snapshot. Slack can
refresh its preview from newer detail responses; it does not change the stored
Message. Existing Automation cards remain readable.

Plugins must return only facts appropriate to disclose in the current
Conversation. This contract does not expand provider permissions or make a
private object public. Detail views of saved annotations use Conversation access,
not the original actor's provider credentials. Live provider details and actions
are not part of this contract.

### Object facts

Plugins select facts from the successful provider response, before core saves
an annotation. `object-facts.ts` in the plugin API defines the shared vocabulary
and field order. It contains no provider fields or Slack layout. Both Slack and
the web card use these facts. The Slack detail panel reads the latest saved
annotation, not a new provider response. The web transcript shows the Message
snapshot and labels it as saved.

- Code changes show review and check summaries when known, then author,
  requested reviewers, conflicts, branches, and change size. GitHub REST PR
  responses do not include review decisions or check totals. The producer must
  not invent these from requested reviewers, mergeability, or lifecycle state.
- Tasks show assignees and priority, then project, cycle, due date, and labels.
  An empty assignee list means unassigned. An absent list means unknown.
- Deployments use the `deployment` object type. Vercel selects project, target, revision, and
  branch from its existing deployment response. It never copies environment
  values. A missing target stays unknown.
- Automations use the existing card and detail page. Cards show state, trigger,
  and warning. The existing Automation record owns full details and actions.
- Other Items remain useful with just a title and source link.

The `facts` object has a 4 KiB serialized UTF-8 limit. Text and lists also have
schema bounds. Producers select at most five entries per list and shorten
optional display text. They do not shorten object keys or source URLs. This
limit applies to new facts, not to the entire annotation, which also contains
identity and existing bounded fields. No new table or cache is needed.

Core replaces `objectAnnotations` with owned `objectCards` in successful tool
results. This avoids two copies in the same tool result. Delivery still saves
an independent Message snapshot. Background annotation updates stay silent and
must not change that snapshot, start Watches, or send new Messages.

`sourceUpdatedAt` is the provider's update time, not the database write time.
A silent status-only update does not claim to refresh every other fact. New
full responses replace the facts; missing values do not retain old values.

All added facts must be safe for the Conversation audience, just like Message
text. Slack detail access still checks the workspace and Conversation. This
change adds no provider fetches or write actions. Source links let the provider
check access to larger details.

#### Release safety

Old annotations remain valid because the new fields are optional. The previous
strict reader does not accept enriched annotations or Message snapshots. Drain
workers and deploy the API, plugins, and dashboard together before writing new
facts. Reload old dashboard tabs. Do not roll back to a reader that rejects
these fields after enriched cards have been written. A rollback needs a reader
that accepts the new fields, even if it does not display them.

### Object visual language

`object-presentation.ts` in the plugin API owns native type labels, lifecycle
icons, and semantic tones. Tickets keep the stored type `task`. Code changes,
Automations, Deployments, and Items each have a distinct icon. Warnings change
the tone, not the object identity. Provider plugins supply types; core and the
web do not parse provider URLs to guess a type. The GitHub sidebar hook handles
old untyped links. Stored deployment Items remain readable as Deployments.

`ObjectIcon` renders the shared Octicons paths in the web. Cards, conversation
links, sidebar badges, and typed event rows use this component. A plugin's
sidebar hook can choose compact labels. Other typed annotations use the default
projection, including core Automations. Unknown event types keep the event icon.

Slack uses the same paths as fixed PNG assets through `product_icon`. The
versioned dashboard route is public and serves only this fixed icon set. It
contains no object facts. Local or headless installs omit image URLs. Type
labels remain in Work Objects and fallback text. Slack owns the card layout;
a successful post does not prove that its client rendered a Work Object.

Run `node scripts/generate-object-icons.mjs` to rebuild SVG paths and PNGs from
the pinned Octicons package. It needs the Playwright Chromium browser. Format
the generated TypeScript files after generation. Keep the Octicons license with
the paths. Change the asset path version if an existing image changes. Review
`/dev/transcripts` at desktop and mobile widths after icon changes.
