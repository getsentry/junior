## 1. Source Inventory

- [x] 1.1 Review `specs/harness-agent.md` and adjacent session, execution, Slack delivery, and testing specs.
- [x] 1.2 Inspect `respond.ts`, `turn-result.ts`, thinking routing, failure response, and provider retry code.
- [x] 1.3 Inventory harness/output/timeout/provider retry tests and relevant Slack final delivery integration tests.
- [x] 1.4 Review local Pi prior art relied on by implementation: `Agent`, `prompt()`, `continue()`, `state.messages`, and stream events.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-harness-agent`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `harness-agent`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Compare OpenSpec requirements with `specs/harness-agent.md`.
- [ ] 3.2 Decide whether side-effect-only delivery planning belongs in harness output resolution or reply planning.
- [ ] 3.3 Decide which diagnostics fields are stable contract versus presentation details.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map gaps into follow-up tasks after review.
- [ ] 4.2 Map harness-related evals to reply quality versus harness mechanics.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-harness-agent`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
