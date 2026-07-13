# Conversation Storage

This module owns the durable product record for conversations, visible messages,
agent steps, compaction boundaries, search, retention, and legacy import.

## Records

- Conversation rows identify the source, destination, participants, visibility,
  and lifecycle metadata.
- Conversation rows carry typed execution columns for the provider-neutral
  behavior shared by every execution slice.
- Visible messages are the destination-facing user and assistant history.
- Agent steps are append-only execution history used to restore Pi state.
- Context epochs identify replacement boundaries created by compaction or model
  handoff.
- Provider payloads and old state-store mirrors are migration inputs, not
  canonical product records.

The schemas and migrations under `sql/` are authoritative.

## Execution Profiles

- `ConversationExecutionProfileStore` atomically materializes or loads one
  immutable profile for a conversation.
- The first call persists current host defaults when the profile is absent;
  later calls return the stored value rather than replacing it.
- `execution_model_profile` marks a materialized profile.
  `execution_reasoning_level` is null for adaptive reasoning,
  `execution_allowed_tool_names` is null for the host tool set, and
  `execution_instructions` stores the durable instruction list.
- Model profile roles remain stable durable values while exact provider model
  IDs continue to resolve through the current host model catalog.
- Initial context epochs use the stored baseline model role. Handoff,
  compaction, and rollback epochs retain their own durable model binding.

## Write Rules

- Persist user input before agent execution.
- Persist assistant text only after successful destination delivery.
- Append agent steps in monotonic sequence order.
- Restore state from durable steps rather than a duplicate transcript cache.
- Compaction replaces prior model context without rewriting visible history.
- Imports and migrations are idempotent and preserve stable conversation IDs.

## Visibility And Retention

Destination visibility is the privacy authority. Messages, steps, child
conversations, and plugin projections inherit it. Retention is enforced by the
conversation purge paths and must distinguish expired content from redacted
content.

Follow `../../../../../policies/data-redaction.md` and
`../../../../../policies/runtime-boundary-schemas.md`.

## Deployment Safety

- Schema changes are expand-first and compatible with the currently deployed
  reader and writer during rollout.
- Data rewrites use explicit migrations or resumable import code.
- Legacy fields remain readable only for the migration window and are removed
  after the new authority is verified.
- Purge and migration jobs operate in bounded batches and are safe to retry.

Representative coverage lives in
`packages/junior/tests/integration/conversation-sql.test.ts` and the
conversation storage component tests.
