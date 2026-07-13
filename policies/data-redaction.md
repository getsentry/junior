# Data Redaction

Conversation privacy follows the persisted destination visibility. Redaction
protects raw payloads and telemetry; it does not change the product data that a
conversation is authorized to retain.

## Visibility

- Public destinations may use approved public excerpts in diagnostics.
- Private channels, direct messages, local conversations, and unknown
  destinations are private by default.
- Missing visibility metadata never widens access.
- Child conversations, agent steps, generated artifacts, and plugin records
  inherit the visibility and actor boundaries of their owning conversation.

## Storage

- Store only the content required for conversation continuity, delivery,
  reporting, or an explicitly installed plugin feature.
- Persist normalized product fields instead of complete provider webhook or SDK
  payloads.
- Legacy raw payload fields are migration inputs, not preferred read models.
- Retention expiry and privacy redaction are distinct: expired data is deleted;
  redacted data remains represented without sensitive content.
- Plugin-owned tables must carry enough conversation, actor, and visibility
  context to enforce their own reads and cleanup.

The conversation implementation lives in
`packages/junior/src/chat/conversations/`.

## Logs And Traces

Do not record:

- raw message bodies, prompts, model responses, memory contents, or attachments;
- OAuth codes, access tokens, cookies, authorization headers, API keys, signed
  callback payloads, or credential-context tokens;
- raw provider webhook payloads, SQL parameters containing content, or sandbox
  command output that may contain secrets.

Prefer stable identifiers, counts, sizes, classifications, operation names,
visibility tiers, and bounded error summaries. Apply allowlists when serializing
third-party errors or metadata.

## Model And Tool Boundaries

- Include only conversation content authorized for the active actor and
  destination.
- Tool results must not expose hidden provider payloads or credentials merely
  because the host received them.
- Memory recall and search must filter by actor, source, and visibility before
  content enters model context.
- Administrative output requires explicit selectors and safe terminal defaults.

## Verification

Test deterministic visibility, retention, and serialization boundaries. Do not
assert on raw private content in snapshots or telemetry tests.
