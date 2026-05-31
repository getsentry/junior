## Why

The harness agent contract is the boundary between Pi execution and higher-level Slack/runtime delivery. It needs an OpenSpec baseline so final output resolution, streaming, timeout handling, provider retry, and diagnostics are specified without mixing in Slack transport behavior.

## What Changes

- Add a baseline OpenSpec capability for `harness-agent`.
- Convert the canonical harness runtime contract into OpenSpec requirements and scenarios.
- Add a worksheet and verification map covering `generateAssistantReply(...)`, `buildTurnResult(...)`, thinking-level routing, streaming callbacks, timeout/resume handoff, provider retry, and diagnostics.
- Do not implement runtime, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `harness-agent`: Pi-backed assistant turn execution, final output resolution, streaming event handling, timeout/provider failure behavior, and turn diagnostics.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/harness-agent.md`, `specs/agent-session-resumability.md`, `specs/agent-execution.md`, `specs/harness-tool-context.md`, `specs/slack-agent-delivery.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/respond.ts`, `packages/junior/src/chat/services/turn-result.ts`, `packages/junior/src/chat/services/turn-thinking-level.ts`, `packages/junior/src/chat/services/turn-failure-response.ts`, and Pi/tracing helpers.
- Affected verification inventory only: turn-result unit tests, respond runtime tests, provider retry tests, timeout resume tests, final reply integration tests, and evals that observe reply quality.
