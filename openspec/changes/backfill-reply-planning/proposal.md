# Backfill `reply-planning`

## Why

Junior has several layers that turn agent output into visible Slack replies: final assistant output resolution, side-effect suppression, file delivery planning, Slack post chunk planning, and footer metadata. The behavior is implemented and partially tested, but it is currently distributed across runtime service modules, Slack delivery modules, and broad Slack integration tests.

Backfilling `reply-planning` gives this behavior one capability contract without moving Slack API ownership away from `slack-outbound-contract` or turn participation ownership away from `agent-turn-handling`.

## What Changes

- Add an OpenSpec capability for `reply-planning`.
- Specify how Junior resolves terminal assistant output after tool calls.
- Specify reaction-only, channel-only, side-effect-only, file-only, canvas, provider-error, and execution-escape reply outcomes.
- Specify Slack post planning before outbound API calls, including continuation chunks, file attachment placement, and footer block placement.
- Record current tests/evals, ambiguous combinations, and follow-up verification gaps.

## Impact

- Affected specs:
  - `agent-turn-handling`
  - `harness-agent`
  - `slack-agent-delivery`
  - `slack-outbound-contract`
  - `testing`
- Affected code evidence:
  - `packages/junior/src/chat/services/turn-result.ts`
  - `packages/junior/src/chat/services/reply-delivery-plan.ts`
  - `packages/junior/src/chat/slack/reply.ts`
  - `packages/junior/src/chat/slack/footer.ts`
- Affected verification:
  - Unit tests for deterministic output resolution, delivery-plan helpers, post planning, and footer formatting.
  - Slack integration tests for finalized reply delivery, chunking, side-effect suppression, and file visibility.
  - Evals only for model-facing intent and natural-language reply quality owned by adjacent capabilities.
