## 1. Source Inventory

- [x] 1.1 Review `specs/context-compaction.md` and adjacent session, prompt, Slack delivery, and testing specs.
- [x] 1.2 Inspect `context-compaction.ts`, `context-budget.ts`, runtime context stripping, turn-session/session-log projection behavior, and pre-turn runtime wiring.
- [x] 1.3 Inventory unit/integration/eval coverage for retained messages, projection-reset compaction, threshold decisions, long Slack thread wiring, and active/awaiting session behavior.
- [x] 1.4 Review local prior art relied on by implementation: Pi/Codex-style projection replacement, tail-preserving summaries, and runtime-context reinjection.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-context-compaction`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `context-compaction`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Compare OpenSpec requirements with `specs/context-compaction.md`.
- [x] 3.2 Decide whether same-log `projection_reset` replaces the older `compaction_<session>` session-record fork model: current implementation now uses same-log `projection_reset` through `commitMessages(...)`.
- [ ] 3.3 Decide whether deterministic compaction event IDs/idempotency keys are required before archival.
- [ ] 3.4 Decide the exact visible conversation-state compaction contract and whether it belongs in this capability or `conversation-state`.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `replace` entries into follow-up tasks after review.
- [ ] 4.2 Map or add eval coverage for long-thread continuity after compaction.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-context-compaction`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
