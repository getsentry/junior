## Why

Junior's persisted conversation state is the visible Slack-thread memory used for prompt background, routing, title generation, image summaries, and active-turn pointers. It needs an OpenSpec baseline so this state does not drift into a second Pi transcript, session log, or auth lifecycle store.

## What Changes

- Add a baseline OpenSpec capability for `conversation-state`.
- Convert the visible thread-state contract into OpenSpec requirements and scenarios.
- Add a worksheet documenting source inventory, implemented behavior, intended behavior, undefined behavior, and migration notes.
- Add a verification map that separates pure coercion/rendering logic from Slack runtime integration behavior.
- Do not implement runtime, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `conversation-state`: Persisted Slack-visible conversation memory, message upsert/metadata, skipped/replied markers, backfill, visible conversation compaction, image summary references, title source selection, stats, and processing pointers.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/chat-architecture.md`, `specs/agent-turn-handling.md`, `specs/context-compaction.md`, `specs/agent-session-resumability.md`, `specs/agent-prompt.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/state/conversation.ts`, `packages/junior/src/chat/services/conversation-memory.ts`, `packages/junior/src/chat/runtime/turn-preparation.ts`, thread-state persistence helpers, and reply delivery state patches.
- Affected verification inventory only: conversation-memory unit tests, message-content/attachment/image integration tests, OAuth/timeout resume state tests, and future conversation-compaction tests.
