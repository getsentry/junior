## 1. Source Inventory

- [x] 1.1 Review `agent-turn-handling`, `harness-agent`, `slack-agent-delivery`, `slack-outbound-contract`, and `testing` ownership boundaries.
- [x] 1.2 Inspect `turn-result.ts`, `reply-delivery-plan.ts`, `slack/reply.ts`, and `slack/footer.ts`.
- [x] 1.3 Inventory finalized reply, side-effect suppression, file-only reply, chunking, provider-error, footer, and turn-result tests.
- [x] 1.4 Review relevant prior art: finalized Chat SDK/Pi turn state is the source for final replies; Slack messages use top-level fallback text plus Block Kit blocks for formatted presentation.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-reply-planning`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `reply-planning`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Decide whether file-follow-up mode should stay in this capability or be narrowed to outbound delivery only.
- [ ] 3.2 Decide whether provider-error partial text should be mandatory for every provider error or only when useful partial text exists.
- [ ] 3.3 Decide whether canvas reply shortening belongs entirely here or partly in a canvas/tool capability.
- [ ] 3.4 Decide whether footer metadata should be canonical product behavior or diagnostic presentation detail.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map broad finalized-reply integration tests to named `reply-planning` scenarios.
- [ ] 4.3 Add or relocate focused unit coverage for footer placement, follow-up file planning, and post-stage planning if gaps remain after review.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-reply-planning`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
