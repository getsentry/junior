# Data Redaction

## Intent

Conversation privacy follows the stored destination visibility. Redaction
protects raw payloads and telemetry. It does not change the product data a
conversation may keep. Code: `packages/junior/src/chat/conversations/`.

## Policy

### Visibility

- Public destinations may use approved public excerpts in diagnostics.
- Private channels, DMs, local conversations, and unknown destinations are
  private. Missing visibility never widens access.
- Child conversations, events, artifacts, and plugin records inherit the
  visibility and actor edges of their owning conversation.

### Storage

- Store only content needed for continuity, delivery, reporting, or an
  installed plugin feature.
- Store normalized fields, not full webhook or SDK payloads. Legacy raw fields
  are migration inputs only.
- Retention expiry deletes data. Redaction keeps the record without sensitive
  content.
- Plugin tables carry enough conversation, actor, and visibility context to
  enforce their own reads and cleanup.

### Logs and traces

- Do not record message bodies, prompts, model responses, memory contents,
  attachments, OAuth codes, tokens, cookies, auth headers, API keys, signed
  callback payloads, credential-context tokens, raw webhooks, SQL content
  parameters, or sandbox output that may hold secrets.
- Record ids, counts, sizes, classifications, operation names, visibility
  tiers, and bounded error summaries. Allowlist third-party error fields.

### Model and tools

- Include only content authorized for the active actor and destination.
- Tool results must not expose hidden provider payloads or credentials.
- Memory recall and search filter by actor, source, and visibility before
  content enters model context.
- Admin output needs explicit selectors and safe defaults.

### Tests

- Test fixed visibility, retention, and serialization edges. Do not put raw
  private content in snapshots or telemetry tests.

## Exceptions

- None.
