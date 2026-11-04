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
- Who may read, find, or act on a Conversation follows
  `./conversation-access.md`.

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

- Include only content that `./conversation-access.md` allows for the active
  actor and Conversation.
- Tool results must not expose hidden provider payloads or credentials.
- Memory recall and search filter by actor, source, and visibility before
  content enters model context.
- Admin output needs explicit selectors and safe defaults.

### Tests

- Test fixed visibility, retention, and serialization edges. Do not put raw
  private content in snapshots or telemetry tests.

## Exceptions

- None.
