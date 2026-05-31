## Why

Agent session resumability prevents long Slack turns from losing work when serverless execution pauses for timeout or authorization. The repository has a detailed canonical spec and substantial implementation, but the OpenSpec baseline needs a capability contract that distinguishes current verified behavior from the richer target session-log design that is still transitional.

## What Changes

- Add a baseline OpenSpec capability for `agent-session-resumability`.
- Convert the current canonical session/resume contract into OpenSpec requirements and scenarios.
- Record implementation reality: append-only Pi message session log exists, while lifecycle validity is currently carried by `AgentTurnSessionRecord` versioned read models rather than the full target event vocabulary.
- Add a backfill worksheet and verification map covering session log, safe boundaries, Pi `continue()`, timeout callbacks, auth resume, stale/duplicate handling, provider retry, MCP restoration, and Slack resume integration.
- Do not implement runtime, test, or eval changes as part of this spec-only change.

## Capabilities

### New Capabilities

- `agent-session-resumability`: Durable single-turn session history, safe pause boundaries, Pi replay/continue semantics, timeout/auth resume callbacks, and resume failure behavior.

### Modified Capabilities

- None.

## Impact

- Affected canonical specs: `specs/agent-session-resumability.md`, `specs/slack-agent-delivery.md`, `specs/context-compaction.md`, `specs/harness-agent.md`, `specs/chat-architecture.md`, and `specs/testing.md`.
- Affected implementation inventory only: `packages/junior/src/chat/state/session-log.ts`, `packages/junior/src/chat/state/turn-session.ts`, `packages/junior/src/chat/services/turn-session-record.ts`, `packages/junior/src/chat/services/timeout-resume.ts`, `packages/junior/src/chat/respond.ts`, `packages/junior/src/chat/runtime/slack-resume.ts`, and `packages/junior/src/handlers/turn-resume.ts`.
- Affected verification inventory only: session-log unit tests, turn-session-record tests, timeout-resume signing tests, turn-resume handler tests, Slack timeout/auth resume integration tests, OAuth/MCP callback tests, and resume-related evals.
