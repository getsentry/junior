## Why

Slack delivery is one of Junior's highest-risk user-visible surfaces: it combines inbound Slack events, assistant status, thread replies, continuation notices, files, image context, and resumed turns. The repository already has a strong canonical markdown spec, but the baseline OpenSpec catalog needs an equivalent capability spec backed by current code, official Slack behavior, and the existing test taxonomy.

## What Changes

- Add a baseline OpenSpec capability for Slack agent delivery.
- Convert the current `specs/slack-agent-delivery.md` contract into OpenSpec requirements and scenarios without changing runtime behavior.
- Add a backfill worksheet documenting source inventory, Slack prior art, implemented behavior, undefined behavior, and migration notes.
- Add a verification map that classifies current coverage and identifies which tests should be kept, renamed, split, or added later.
- Do not implement runtime, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `slack-agent-delivery`: User-visible Slack delivery behavior for agent turns, including entry surfaces, assistant-thread lifecycle, progress status, processing reactions, finalized replies, continuation posts, files, image ingress, and resume delivery.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/slack-agent-delivery.md`, `specs/slack-outbound-contract.md`, `specs/agent-turn-handling.md`, `specs/agent-session-resumability.md`, `specs/chat-architecture.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/runtime/*`, `packages/junior/src/chat/slack/*`, `packages/junior/src/chat/services/reply-delivery-plan.ts`, and `packages/junior/src/chat/services/vision-context.ts`.
- Affected verification inventory only: Slack behavior/contract integration tests, Slack unit tests for output/status/footer/reaction helpers, OAuth/resume Slack tests, and agent-turn evals that assert Slack-visible behavior.
