## Why

Junior has strong specs for Slack delivery, runtime architecture, and resumability, but the model-facing turn contract is spread across prompt text, subscribed-thread routing, Pi session handling, and Slack tool rules. A canonical turn-handling spec will make it explicit how the agent should interpret user messages, decide whether to act, use tools, ask clarifying questions, and finish a Slack turn.

## What Changes

- Add a new canonical spec for agent turn handling that defines user-message response policy across direct mentions, DMs, subscribed Slack threads, queued follow-ups, resumed turns, and Slack side-effect requests.
- Capture prior-art constraints from the current implementation: passive subscribed-thread routing, prompt execution contract, finalized Slack replies, progress reporting, tool/source selection, auth/timeout continuation, and duplicate-reply suppression after successful Slack side effects.
- Define scenario-level requirements for common Slackbot interactions: explicit asks, implicit follow-ups, acknowledgements, side conversations, opt-outs, attachment/image turns, channel-post requests, reaction requests, blocked/auth-paused work, and long-running tasks.
- Clarify spec ownership boundaries with `chat-architecture.md`, `slack-agent-delivery.md`, `agent-session-resumability.md`, `agent-prompt.md`, and `harness-agent.md`.

## Capabilities

### New Capabilities

- `agent-turn-handling`: Defines how Junior responds to user-authored messages at the agent-policy level, including when to answer, when to stay silent, when to use tools, when to ask, and what counts as completing a user turn.

### Modified Capabilities

- None.

## Impact

- Adds canonical spec coverage under `specs/` and OpenSpec change artifacts under `openspec/changes/spec-agent-turn-handling/`.
- Informs future updates to `packages/junior/src/chat/prompt.ts`, `packages/junior/src/chat/services/subscribed-decision.ts`, `packages/junior/src/chat/respond.ts`, and Slack runtime tests/evals.
- No runtime API or dependency changes are proposed in this change.
