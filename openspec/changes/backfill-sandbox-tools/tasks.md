## 1. Source Inventory

- [x] 1.1 Review `tool-execution`, `security-policy`, `credential-injection`, `sandbox-snapshots`, `slack-agent-delivery`, `reply-planning`, and `testing` boundaries.
- [x] 1.2 Inspect Vercel Sandbox skill references, installed `@vercel/sandbox` version, sandbox session/executor/workspace code, and sandbox tool implementations.
- [x] 1.3 Inventory coverage for sandbox file helpers, attach-file, bash adapter, lazy sandbox acquisition, sandbox executor, egress proxy, and generated file attachment behavior.
- [x] 1.4 Review Vercel Sandbox prior art: active named sandbox reuse, timeout extension, snapshot-backed starts, and no implicit durable workspace recovery after stop unless persistent APIs are explicitly used.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-sandbox-tools`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `sandbox-tools`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Decide whether missing-path results should be thrown expected errors or model-visible `ok:false` payloads per tool.
- [ ] 3.2 Decide whether `attachFile` should use `ToolInputError` for missing/empty/oversized files.
- [ ] 3.3 Decide where bash timeout/interruption semantics are canonical.
- [ ] 3.4 Decide whether `/tmp` attachment paths remain intentionally allowed outside the workspace root.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map sandbox lazy-acquisition tests to named sandbox-tool scenarios.
- [ ] 4.3 Add focused coverage for any unverified command interruption or path confinement behavior.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-sandbox-tools`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
