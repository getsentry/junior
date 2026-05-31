## 1. Source Inventory

- [x] 1.1 Review `tool-execution`, `security-policy`, `reply-planning`, `attachment-and-vision-context`, `agent-prompt`, `eval-testing`, and `testing` boundaries.
- [x] 1.2 Inspect `tools/web/*`, web tool tests, research evals, source-use fixtures, and generated image fixtures.
- [x] 1.3 Inventory coverage for search mapping/timeouts/auth failures, fetch SSRF guards, content extraction, image fetch attachment, and image generation parsing.
- [x] 1.4 Review Vercel AI Gateway prior art for Parallel Search and image generation through Chat Completions.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-web-tools`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `web-tools`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Decide whether webSearch/webFetch failure results should become expected tool errors.
- [ ] 3.2 Decide whether image generation with zero returned images should be success or failure.
- [ ] 3.3 Decide whether fetch should support PDF/document extraction.
- [ ] 3.4 Decide whether source/citation requirements belong here or in agent-prompt/eval specs.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map research/source evals to capability requirements.
- [ ] 4.3 Add focused tests for SSRF redirect/DNS edge cases and image fetch attachment if missing.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-web-tools`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
