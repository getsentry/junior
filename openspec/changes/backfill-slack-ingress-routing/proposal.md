## Why

Slack ingress routing is the boundary that turns Slack/Chat SDK webhook payloads into canonical Junior runtime calls. It needs a baseline OpenSpec contract so message normalization, queue handoff, lifecycle events, edited-message mentions, direct-message routing, and attachment rehydration stay separate from agent turn behavior.

## What Changes

- Add a baseline OpenSpec capability for `slack-ingress-routing`.
- Convert Slack ingress and Chat SDK routing behavior into OpenSpec requirements and scenarios.
- Add a worksheet documenting source inventory, Slack/Chat SDK prior art, implemented behavior, undefined behavior, and migration notes.
- Add a verification map that separates pure routing/normalization unit tests from Slack runtime integration tests.
- Do not implement runtime, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `slack-ingress-routing`: Slack event normalization, message-kind classification, queue/runtime handoff, assistant lifecycle routing, edited-message mention extraction, external-user filtering, attachment fetcher rehydration, and webhook background task handling.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/chat-architecture.md`, `specs/agent-turn-handling.md`, `specs/slack-agent-delivery.md`, `specs/slack-outbound-contract.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/ingress/*`, `packages/junior/src/chat/queue/thread-message-dispatcher.ts`, `packages/junior/src/chat/app/production.ts`, and `packages/junior/src/chat/runtime/slack-runtime.ts`.
- Affected verification inventory only: ingress/router unit tests, thread-message dispatcher tests, Slack runtime unit tests, assistant lifecycle integration tests, message-changed integration tests, and subscribed/mention behavior tests.
