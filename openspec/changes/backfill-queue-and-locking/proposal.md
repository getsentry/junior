## Why

Junior relies on the Chat SDK queue and state-adapter locks to serialize Slack thread handling, preserve skipped messages, and avoid concurrent live turns. This needs a baseline OpenSpec contract so queue/lock behavior stays separate from durable agent session resumability and does not become an implicit workflow engine.

## What Changes

- Add a baseline OpenSpec capability for `queue-and-locking`.
- Convert queue, lock, heartbeat, skipped-message, and resume-lock behavior into OpenSpec requirements and scenarios.
- Add a worksheet documenting source inventory, implemented behavior, intended behavior, undefined behavior, and migration notes.
- Add a verification map that separates state-adapter unit tests from Slack runtime and resume integration tests.
- Do not implement runtime, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `queue-and-locking`: Chat SDK queue configuration, per-thread lock semantics, active lock heartbeat, state key prefixing, queued/skipped message preservation, resume callback lock behavior, and queue/session responsibility boundaries.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/chat-architecture.md`, `specs/agent-session-resumability.md`, `specs/slack-ingress-routing.md`, `specs/agent-turn-handling.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/app/production.ts`, `packages/junior/src/chat/state/adapter.ts`, `packages/junior/src/chat/queue/thread-message-dispatcher.ts`, `packages/junior/src/chat/runtime/slack-resume.ts`, timeout-resume handlers/services, and Slack runtime queue consumption.
- Affected verification inventory only: state-adapter lock tests, thread-message dispatcher tests, Slack runtime skipped-message tests, timeout-resume tests, turn-resume callback tests, and turn-resume Slack integration tests.
