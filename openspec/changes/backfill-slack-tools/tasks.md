## 1. Source Inventory

- [x] 1.1 Review `tool-execution`, `harness-tool-context`, `slack-outbound-contract`, `reply-planning`, `conversation-state`, and `testing` boundaries.
- [x] 1.2 Inspect Slack tool implementations, tool registration/capability gating, artifact state usage, and Slack outbound helpers.
- [x] 1.3 Inventory coverage for reaction, channel post/history, thread read, canvas, list, context routing, idempotency, and failure recovery.
- [x] 1.4 Review Slack prior art for reactions, Canvases, Lists, and context-bound channel/message operations.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-slack-tools`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `slack-tools`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Audit Slack tool `{ ok: false }` results against `ToolInputError` policy.
- [ ] 3.2 Decide exact channel/DM availability for channel-history tools.
- [ ] 3.3 Decide whether canvas create in DM contexts is intended permanent behavior.
- [ ] 3.4 Decide whether Slack list/canvas side effects need durable idempotency.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map broad Slack tool integration files to named `slack-tools` scenarios.
- [ ] 4.3 Add focused coverage for sentinel-failure alignment once policy is decided.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-slack-tools`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
