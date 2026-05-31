## Why

Junior needs a baseline OpenSpec contract for context compaction because long Slack threads and reusable Pi histories can exceed model context limits. Existing prose and tests cover much of the desired behavior, but the OpenSpec baseline needs to separate reusable Pi-history compaction from visible Slack conversation-state compaction and record target/current gaps.

## What Changes

- Add a baseline OpenSpec capability for `context-compaction`.
- Convert the canonical compaction contract into OpenSpec requirements and scenarios.
- Add a worksheet documenting source inventory, prior art, implemented behavior, intended behavior, undefined behavior, and migration notes.
- Add a verification map that separates pure retained-message/replacement mechanics from Slack runtime wiring and model-continuity evals.
- Do not implement runtime, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `context-compaction`: Reusable Pi-history compaction, handoff summary construction, retained user-message selection, pre-turn compaction timing, visible conversation-state compaction bounds, token budget triggers, and failure behavior.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/context-compaction.md`, `specs/agent-session-resumability.md`, `specs/agent-prompt.md`, `specs/slack-agent-delivery.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/services/context-compaction.ts`, `packages/junior/src/chat/services/context-budget.ts`, `packages/junior/src/chat/respond-helpers.ts`, turn preparation/reply runtime wiring, and session-log/session-record state modules.
- Affected verification inventory only: context-compaction unit tests, message-content integration tests, session-log projection tests, long-thread evals if added, and future conversation-state compaction tests.
