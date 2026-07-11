# agent-step-history

## ADDED Requirements

### Requirement: Execution history is stored as one row per agent step

The system SHALL store the durable model execution history in `junior_agent_steps` with one row per step: `conversation_id` (FK to `junior_conversations`), `seq` (per-conversation order), `context_epoch`, `type` (discriminant), optional `role` (denormalized for `pi_message` rows), `payload` JSON, and `created_at`. The primary key SHALL be `(conversation_id, seq)`. The table SHALL replace the Redis list at `junior:agent-session-log:<conversationId>` as the execution-history authority. Rows are append-only; deletion happens only through retention purge or erasure.

#### Scenario: Steps appended at a safe boundary

- **WHEN** a worker commits model and tool activity at a safe boundary
- **THEN** each step is one row and reading the conversation's steps returns them in `seq` order

### Requirement: Sequence assignment is lease-fenced and fails loudly

`seq` SHALL be assigned transactionally per conversation by a writer holding the conversation lease. A conflicting write SHALL fail with a primary-key violation rather than silently interleaving or overwriting.

#### Scenario: Fencing violation surfaces as an error

- **WHEN** a writer that lost its lease attempts to append with a `seq` already used
- **THEN** the insert fails with a constraint error and no stored row is modified

### Requirement: The current context epoch is the model context

The model-visible context for a conversation SHALL be exactly the `pi_message` steps in the conversation's highest `context_epoch`, ordered by `seq`. Epochs start at 0. Steps in older epochs SHALL remain readable as audit history and SHALL NOT contribute to model context. Host-only step types (activity, auth, provider-connection facts) SHALL be excluded from the Pi projection as today.

#### Scenario: Resume restores context from the current epoch

- **WHEN** a queue-driven worker resumes a conversation
- **THEN** it restores `agent.state.messages` from the `pi_message` rows of the highest epoch in `seq` order and calls `continue()`

### Requirement: Compaction and rollback start a new epoch atomically

Context rebuilds SHALL NOT store embedded transcript arrays. Compaction and safe-boundary rollback SHALL, in one transaction: append a `context_epoch_started` marker step carrying `reason` (`compaction` | `rollback`), then append the replacement context as ordinary `pi_message` rows in the new epoch, preserving each message's original timestamp so replay is byte-stable.

#### Scenario: Compaction writes a new epoch

- **WHEN** context compaction runs for a conversation in epoch N
- **THEN** epoch N+1 contains a `context_epoch_started {reason: "compaction"}` marker followed by the retained messages and the synthetic compaction summary as individual rows, and epoch N remains as audit history

#### Scenario: Provider-retry rollback

- **WHEN** a transient provider failure requires trimming trailing failed assistant output
- **THEN** a new epoch is written with `reason: "rollback"` containing the trimmed history, and `continue()` resumes from it

### Requirement: Subagent histories are child conversations

A subagent (advisor) execution SHALL be recorded as its own conversation row with `parent_conversation_id` set, and its steps stored in `junior_agent_steps` under its own `conversation_id`. The `subagent_started` step SHALL reference the child by `childConversationId`. The polymorphic `transcriptRef {type, key}` reference and the ad-hoc `junior:<id>:advisor_session` Redis key SHALL be removed. Reading a subagent transcript SHALL use the same query path as any conversation.

#### Scenario: Advisor invocation creates a child conversation

- **WHEN** the advisor tool runs inside a parent conversation
- **THEN** a child conversation row exists with `parent_conversation_id` pointing at the parent, the parent's `subagent_started` step carries the child's `conversationId`, and the child's transcript renders through the standard conversation read path

#### Scenario: Top-level listings exclude children

- **WHEN** the dashboard lists recent conversations
- **THEN** conversations with a non-null `parent_conversation_id` are excluded

### Requirement: Strict envelope, permissive payload

Row envelope fields (`conversation_id`, `seq`, `context_epoch`, `type`, `created_at`) SHALL be strictly validated with the existing Zod step-type union at the store boundary; an unknown `type` or invalid envelope SHALL fail loudly as corrupt state. `pi_message` payload content SHALL remain permissive (Pi SDK owns the message shape) and SHALL carry its payload `schemaVersion` per row.

#### Scenario: Corrupt row fails loudly

- **WHEN** a read encounters a row whose envelope fails validation
- **THEN** the read fails with an explicit error instead of guessing behavior for the unknown shape

### Requirement: One-time migration from Redis

`junior upgrade` SHALL bulk-import legacy Redis session logs (bounded, newest-first), translating `sessionId` markers to integer epochs, exploding `projection_reset` entries into `context_epoch_started` markers plus per-message rows, converting advisor session keys into child conversations, and normalizing legacy v1 entry shapes. Import SHALL be idempotent per conversation (skip when step rows already exist). For conversations touched by the old deployment during promotion, the first read that finds no SQL rows while a Redis log exists SHALL perform a one-time lazy import under the conversation lease. Backfilled `pi_message` rows SHALL take `created_at` from message-internal timestamps when present, else fall back to the conversation's timestamps; fabricated import-time timestamps SHALL NOT be used. The lazy-import path SHALL be removed after the legacy Redis TTL horizon passes.

#### Scenario: Bulk backfill during upgrade

- **WHEN** `junior upgrade` runs against a database with legacy Redis session logs present
- **THEN** each imported conversation's steps exist in SQL with correct epochs and ordering, and re-running the upgrade imports nothing twice

#### Scenario: Straggler conversation lazily imported

- **WHEN** a worker resumes a conversation that has a Redis session log but no SQL step rows
- **THEN** the worker imports the log once under the conversation lease before continuing execution
