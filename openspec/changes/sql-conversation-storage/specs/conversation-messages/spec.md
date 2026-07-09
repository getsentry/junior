# conversation-messages

## ADDED Requirements

### Requirement: Visible messages are stored as SQL rows

The system SHALL store the visible conversation transcript in `junior_conversation_messages` with one row per message, keyed by `(conversation_id, message_id)` where `conversation_id` is the globally unique conversation key and `message_id` is the source-scoped message identity (Slack `ts`-derived, local sequence). Each row SHALL carry `role` (`user` | `assistant` | `system`), `text`, an optional `author_identity_id` FK to `junior_identities`, optional `meta` JSON for bounded source facts, and `created_at`.

#### Scenario: Message recorded and queryable

- **WHEN** an inbound user message is accepted for a conversation
- **THEN** one message row exists for that `(conversation_id, message_id)` and listing the conversation's messages returns it in `created_at` order

#### Scenario: Duplicate recording is idempotent

- **WHEN** the same source message is recorded twice (source retry or redelivery)
- **THEN** exactly one row exists for that `(conversation_id, message_id)`

### Requirement: Source facts are immutable; delivery marks are explicitly updatable

Message rows SHALL treat `role`, `text`, `author_identity_id`, and `created_at` as immutable after insert. Mutable bookkeeping SHALL be limited to the `replied_at` delivery mark and wholesale refresh of the bounded `meta` JSON when the same message is idempotently re-recorded (late vision hydration, routing/skip marks); no other field of a stored message may be updated in place.

#### Scenario: Reply mark set without content mutation

- **WHEN** delivery finalizes an assistant reply that answers a stored user message
- **THEN** the user message's `replied_at` is set and its `text`, `role`, and `created_at` are unchanged

### Requirement: SQL is the single visible-transcript authority

The `conversation.messages` and `conversation.piMessages` mirrors in Redis `thread-state:<conversationId>` SHALL be removed. Reply policy, channel-context assembly, and reporting SHALL read visible messages through the `ConversationMessageStore` port. `thread-state` SHALL retain only runtime scratch (artifacts, sandbox identity, processing state) with a single Junior-owned TTL constant and a single writer.

#### Scenario: Reply policy reads from the store

- **WHEN** the runtime evaluates channel context or reply policy for a conversation
- **THEN** message history is read through `ConversationMessageStore` and no transcript data is read from `thread-state`

### Requirement: Store port boundary

Runtime, services, ingress, and dashboard modules SHALL depend on the `ConversationMessageStore` port. Drizzle client, table, and ORM types SHALL NOT leak outside `chat/conversations/sql/`.

#### Scenario: Consumer imports the port

- **WHEN** a runtime module needs visible message history
- **THEN** it imports the store interface, not Drizzle schema or client types
