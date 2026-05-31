## 1. Source Inventory

- [x] 1.1 Review adjacent specs for state ownership: `chat-architecture`, `agent-session-resumability`, `context-compaction`, `agent-prompt`, `agent-turn-handling`, and `testing`.
- [x] 1.2 Inspect `state/conversation.ts`, `services/conversation-memory.ts`, `runtime/turn-preparation.ts`, reply delivery state patches, pending-auth helpers, and image/vision context integration.
- [x] 1.3 Inventory unit/integration coverage for conversation coercion/rendering, title source selection, message preparation, queued/skipped messages, image summaries, compaction, active/last session pointers, and resume state.
- [x] 1.4 Review prior art from local chat state architecture: visible Slack transcript state is separate from durable Pi/session history.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-conversation-state`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `conversation-state`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Compare OpenSpec requirements with `specs/chat-architecture.md`, `specs/context-compaction.md`, and `specs/agent-session-resumability.md`.
- [ ] 3.2 Decide whether legacy `conversation.piMessages` should remain in visible conversation state or be removed after session-log migration.
- [ ] 3.3 Decide the exact retention/TTL policy for visible conversation state.
- [ ] 3.4 Decide whether visible conversation compaction details stay here or move entirely to `context-compaction`.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map existing Slack image/attachment context tests to `conversation-state` versus `attachment-and-vision-context`.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-conversation-state`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
