# Data Redaction Policy

## Purpose

Define when Junior may expose raw conversation, model, and tool payloads across
dashboard reporting, logs, traces, and operational metadata.

## Scope

- Conversation visibility classification.
- Dashboard transcript redaction.
- GenAI tracing payload redaction.
- Safe metadata that may remain visible for private conversations.

## Non-Goals

- Slack message delivery formatting.
- Provider OAuth token redaction, which is owned by `./security-policy.md`.
- Long-term product analytics or metrics storage.

## Conversation Privacy

Junior classifies conversations as `public` or `private`.

- Visibility comes from source-provided signals, not identifier shape. For
  Slack, the accepted signals are the Events API `channel_type` (`channel` is
  public; `group`, `im`, and `mpim` are private) and `conversations.info`
  `is_private`.
- Channel-id prefixes must not be used to prove a conversation public. Modern
  Slack private channels also use `C`-prefixed ids. A prefix may only narrow
  classification toward private (`D`, `G`).
- Visibility is persisted on the destination record
  (`./conversation-storage.md`). Persisted `public` is the only public case for
  reads outside the originating event context: transcript tools, dashboard
  reporting, and telemetry capture.
- Unknown, unparsable, missing, or historical visibility is private.

Privacy checks must fail closed. A missing channel id, missing visibility
signal, unknown conversation shape, or unsupported platform must not expose
raw payloads.

## Raw Payloads

Raw payloads include:

- user message text
- assistant message text and thinking output
- model system instructions
- tool call arguments
- tool result payloads
- raw Pi messages or session-log payloads
- generated conversation titles for private conversations
- private Slack channel names or DM participant-derived titles

Private conversations must not expose raw payloads through authenticated product APIs,
logs, traces, or span attributes.

## Safe Metadata

Private conversations may expose bounded metadata when it is needed for
debuggability and does not reveal raw content:

- conversation id and turn/session id
- actor identity used for audit/correlation
- message role and timestamp
- message count and tool-call count
- payload byte/character size
- part type
- tool name
- bounded top-level tool argument key names
- token usage, duration, outcome, trace id, and Sentry links

Safe metadata must stay low-cardinality and bounded. Do not include arbitrary
payload previews or nested values.

## Model-Facing Transcript Access

Transcript query tools expose stored conversation content to the model, so they
are an exposure surface governed by the same visibility classification.

- A conversation's transcript is always readable from that conversation's own
  context.
- Cross-conversation search is available only from a source-confirmed public
  Slack context. It may read conversations with persisted `public` visibility
  in the same provider tenant (Slack workspace), including other public
  channels in that workspace.
- Private channels, group DMs, and DMs cannot read other conversations,
  including earlier threads in the same destination. Their current
  conversation remains readable from its own context.
- Conversations with missing destinations, missing/unknown visibility, or
  non-public visibility are not readable across contexts.
- Local and Slack contexts must not read each other's transcripts.

## Dashboard Reporting

Dashboard reporting may return raw transcript content only for public
conversations.

For private conversations:

- `transcript` must be empty.
- `transcriptRedacted` must be true.
- `transcriptRedactionReason` must explain that the conversation is not public.
- `transcriptMetadata` may include safe metadata only.
- Conversation titles must use generic labels:
  - `Direct Message`
  - `Group DM`
  - `Private Channel`
- Public Slack channel titles may use `#channel`.

The dashboard UI must render private transcript metadata as redacted content,
not as approximated raw content.

## GenAI Tracing

For private conversations, GenAI spans must not set raw
`gen_ai.input.messages`, `gen_ai.output.messages`, or
`gen_ai.system_instructions` values. They may set metadata equivalents that
contain roles, part types, sizes, and counts.

Tool execution spans in private conversations must not set raw
`gen_ai.tool.call.arguments` or raw `gen_ai.tool.call.result`. They may set
bounded `app.ai.tool.*` metadata such as type, size, and top-level keys.

Tools may explicitly project a result that is safe to retain in private traces.
The projection must contain only static, public, or otherwise non-conversation
data selected by the tool owner. The runtime marks projected results before the
final Sentry payload filter preserves them. Tool arguments, user-authored search
queries and provider selectors, provider execution responses, credentials, and
unprojected result fields remain subject to normal private-conversation
redaction. Static MCP provider and tool catalog metadata may be projected.

Enclosing workflow/agent spans should include `app.conversation.privacy` when
the runtime can derive it. Child GenAI spans may inherit that trace context and
must still apply the same capture policy even when they do not repeat the
attribute.

## Retention Interaction

Redaction hides content that still exists; retention deletes content that has
aged out. They are distinct and must present distinctly.

- Content retention is visibility-tiered and owned by `./conversation-storage.md`:
  conversation content is retained 90 days for persisted-`public` conversations
  and 14 days otherwise (fail-closed), measured from `last_activity_at`.
- When content is purged, reporting must present it as expired under retention,
  not as redacted for privacy. Purged is a different reason than the
  non-public redaction reason.
- Purge scrubs the private raw-payload metadata that redaction otherwise only
  masks at read time: for non-public conversations it nulls the generated
  `title`, the private `channel_name`, and legacy actor JSON, leaving only safe
  metadata on the surviving conversation row.

## Verification

- Private dashboard conversation APIs return no raw message text, thinking text,
  tool arguments, or tool results.
- Public dashboard conversation APIs may return raw transcript content while the
  session-log entry is still present.
- Private GenAI capture tests prove raw message content is not exposed.
- Tool execution tests prove private tool arguments, raw or unprojected results,
  and MCP error payloads are not exposed through reporting or telemetry capture
  paths, while only explicitly projected result fields survive the final
  payload filter.
- Unknown conversation ids are treated as private.
- Conversations Slack reports as private (`channel_type: group` or
  `is_private: true`) are classified private regardless of a `C` id prefix.
- Cross-context transcript reads are denied unless both the requesting source
  and stored destination are public and belong to the same provider tenant.

## Related Specs

- `./conversation-storage.md`
- `./dashboard.md`
- `./security-policy.md`
- `./tracing.md`
- `./otel-semantics.md`
