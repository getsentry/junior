## 1. Source Inventory

- [x] 1.1 Review `agent-execution`, `harness-agent`, `harness-tool-context`, `credential-injection`, `agent-session-resumability`, and `testing` boundaries.
- [x] 1.2 Inspect `definition.ts`, `agent-tools.ts`, `index.ts`, `execution/*`, `idempotency.ts`, and MCP managed tool error behavior.
- [x] 1.3 Inventory coverage for result normalization, sandbox input shaping, tool error handling, tool wrapper metadata, progress status, idempotency, dynamic MCP tools, and plugin/auth pauses.
- [x] 1.4 Review Pi integration prior art: tool calls/results are internal execution artifacts; repairable failures belong in the tool-result error channel.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-tool-execution`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `tool-execution`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Audit concrete `{ ok:false }` tool results and classify each as either a repairable failure that should become an expected tool error or a legitimate negative domain result documented by the owning tool-family spec.
- [ ] 3.2 Decide whether expected tool-error repair needs end-to-end Pi tests or evals.
- [ ] 3.3 Decide whether turn-scoped idempotency is sufficient for Slack/provider side effects.
- [ ] 3.4 Decide whether plugin hook input/env mutation belongs here or in plugin-runtime.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map generic tool wrapper tests away from concrete tool-family test files where useful.
- [ ] 4.3 Add end-to-end expected tool-error repair coverage if absent.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-tool-execution`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
