## 1. Source Inventory

- [x] 1.1 Review `specs/slack-agent-delivery.md` and adjacent canonical specs for ownership boundaries.
- [x] 1.2 Inspect Slack delivery implementation paths: runtime reply execution, resume delivery, reply planning, Slack output, assistant status, lifecycle, processing reaction, outbound file delivery, and image context.
- [x] 1.3 Inventory Slack behavior/contract tests and identify coverage by scenario rather than by current filename.
- [x] 1.4 Review relevant official Slack docs for assistant events, assistant status, thread replies, message fallback text, and file upload constraints.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-slack-agent-delivery`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `slack-agent-delivery`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Compare the OpenSpec requirements against `specs/slack-agent-delivery.md` and mark any canonical prose that should be narrowed, clarified, or cross-linked after review.
- [ ] 3.2 Decide whether deprecated `files.upload` wording in canonical docs should be replaced with delivery semantics plus a `slack-outbound-contract` link.
- [ ] 3.3 Decide whether exact assistant-status debounce/refresh timings belong in the normative spec or remain implementation policy.
- [ ] 3.4 Decide whether OAuth resume `connectedText` banners should remain allowed or be migrated to the canonical no-public-connected-banner rule.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert the verification-map actions into follow-up test/eval rename/split/add tasks after the spec is accepted.
- [ ] 4.2 Identify evals that currently assert Slack reply quality or routing behavior and map them to `agent-turn-handling`, `agent-prompt`, or `slack-agent-delivery`.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-slack-agent-delivery`.
- [x] 5.2 Record validation results and any intentionally deferred runtime/test verification.
