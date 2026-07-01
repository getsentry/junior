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

- Slack channels whose id starts with `C` are public.
- Slack direct messages whose id starts with `D` are private.
- Slack private channels and group DMs whose id starts with `G` are private.
- Unknown or unparsable conversation ids are private.

Privacy checks must fail closed. A missing channel id, unknown conversation
shape, or unsupported platform must not expose raw payloads.

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
- requester identity used for audit/correlation
- message role and timestamp
- message count and tool-call count
- payload byte/character size
- part type
- tool name
- bounded top-level tool argument key names
- token usage, duration, outcome, trace id, and Sentry links

Safe metadata must stay low-cardinality and bounded. Do not include arbitrary
payload previews or nested values.

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

Enclosing workflow/agent spans should include `app.conversation.privacy` when
the runtime can derive it. Child GenAI spans may inherit that trace context and
must still apply the same capture policy even when they do not repeat the
attribute.

## Verification

- Private dashboard conversation APIs return no raw message text, thinking text,
  tool arguments, or tool results.
- Public dashboard conversation APIs may return raw transcript content while the
  session-log entry is still present.
- Private GenAI capture tests prove raw message content is not exposed.
- Tool execution tests prove private tool arguments, results, and MCP error
  payloads are not exposed through reporting or telemetry capture paths.
- Unknown conversation ids are treated as private.

## Related Specs

- `./dashboard.md`
- `./security-policy.md`
- `./tracing.md`
- `./otel-semantics.md`
