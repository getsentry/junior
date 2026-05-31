## 1. Source Inventory

- [x] 1.1 Review `slack-agent-delivery`, `slack-outbound-contract`, `conversation-state`, `queue-and-locking`, `agent-turn-handling`, `reply-planning`, and `testing` boundaries.
- [x] 1.2 Inspect `vision-context.ts`, `turn-preparation.ts`, `turn-user-message.ts`, `reply-executor.ts`, `thread-message-dispatcher.ts`, `message-changed.ts`, and `legacy-attachments.ts`.
- [x] 1.3 Inventory coverage for Slack image/file ingress, DM file-share attachments, skipped passive screenshots, mixed media, image hydration caching, legacy attachment rendering, and attachment-claim truth.
- [x] 1.4 Review Slack prior art for file-bearing message events, private file URLs, incomplete Slack Connect file metadata, and image block accessibility constraints.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-attachment-and-vision-context`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `attachment-and-vision-context`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Decide whether Slack Connect `check_file_info` is current behavior or explicit future gap.
- [ ] 3.2 Decide whether image/file count and byte limits are normative exact values or tunable implementation bounds.
- [ ] 3.3 Decide whether current-image vision failure should always abort the agent turn or depend on request intent.
- [ ] 3.4 Decide whether legacy Slack attachment text rendering belongs here or in `slack-ingress-routing`.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map broad Slack attachment integration tests to named `attachment-and-vision-context` scenarios.
- [ ] 4.3 Add or relocate focused unit coverage for resumed attachment-context reconstruction if absent.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-attachment-and-vision-context`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
