# Backfill `slack-tools`

## Why

Junior exposes Slack tools for model-callable side effects and Slack context reads: reactions, channel posts, channel history, thread reads, canvases, and lists. These tools sit between the generic tool wrapper and the raw Slack outbound API boundary. Their contracts need to specify context-bound targeting, artifact state, idempotency, safe read projection, and current gaps around sentinel failures.

## What Changes

- Add an OpenSpec capability for `slack-tools`.
- Specify Slack tool availability by channel capability.
- Specify context-bound targets for reactions, channel posts, canvases, and lists.
- Specify thread/channel read safety and private-channel constraints.
- Specify canvas create/read/edit/write behavior and Slack list create/add/read/update behavior.
- Record current Slack API prior art and verification gaps.

## Impact

- Affected specs:
  - `tool-execution`
  - `harness-tool-context`
  - `slack-outbound-contract`
  - `reply-planning`
  - `conversation-state`
  - `testing`
- Affected code evidence:
  - `packages/junior/src/chat/tools/slack/*`
  - `packages/junior/src/chat/tools/index.ts`
  - `packages/junior/src/chat/tools/channel-capabilities.ts`
  - `packages/junior/src/chat/state/artifacts.ts`
- Affected verification:
  - Unit tests for tool registration, Slack URL/canvas ID parsing, reaction normalization, and canvas markdown normalization.
  - Integration tests for Slack channel tools, thread read, canvases, lists, assistant-context canvas routing, idempotency, and failure recovery.
