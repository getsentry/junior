# Backfill `attachment-and-vision-context`

## Why

Slack attachments and image files affect routing, prompt context, resumed turns, and user-visible fallback behavior. Junior already normalizes Slack file/image inputs, rehydrates private file fetchers, summarizes images through a vision model when configured, and records omitted-image context when vision is unavailable. Those contracts are currently spread across Slack delivery prose, conversation state, runtime preparation, and broad integration tests.

Backfilling `attachment-and-vision-context` makes the inbound attachment and vision-summary behavior explicit without moving outbound file upload rules away from `slack-outbound-contract` or final reply planning away from `reply-planning`.

## What Changes

- Add an OpenSpec capability for inbound attachment and vision context.
- Specify attachment metadata persistence, Slack private-file fetcher rehydration, legacy attachment text rendering, image-summary caching, and omitted-image behavior.
- Specify how resumed turns reconstruct attachment counts and omitted-image notices from persisted user-message metadata.
- Record Slack prior-art constraints around file-bearing message events and incomplete Slack Connect file payloads.
- Map current unit/integration coverage and verification gaps.

## Impact

- Affected specs:
  - `slack-ingress-routing`
  - `conversation-state`
  - `queue-and-locking`
  - `agent-turn-handling`
  - `slack-agent-delivery`
  - `reply-planning`
  - `testing`
- Affected code evidence:
  - `packages/junior/src/chat/services/vision-context.ts`
  - `packages/junior/src/chat/runtime/turn-preparation.ts`
  - `packages/junior/src/chat/runtime/turn-user-message.ts`
  - `packages/junior/src/chat/runtime/reply-executor.ts`
  - `packages/junior/src/chat/queue/thread-message-dispatcher.ts`
  - `packages/junior/src/chat/ingress/message-changed.ts`
  - `packages/junior/src/chat/slack/legacy-attachments.ts`
- Affected verification:
  - Unit tests for pure attachment text rendering, claim truth, and metadata reconstruction.
  - Integration tests for Slack file/image ingress, image hydration, skipped passive screenshots, DM file-share events, and mixed media behavior.
  - Evals only for model-facing answer quality when attachment context is present or absent.
