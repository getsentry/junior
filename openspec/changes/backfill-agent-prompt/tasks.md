## 1. Source Inventory

- [x] 1.1 Review `specs/agent-prompt.md` and adjacent prompt/turn/testing/plugin specs.
- [x] 1.2 Inspect `prompt.ts`, `respond.ts`, skill discovery/loading, tool guidance, and runtime-turn-context stripping.
- [x] 1.3 Inventory prompt unit tests, prompt-context integration tests, and model-behavior evals.
- [x] 1.4 Review prompt prior art from local agent architecture: static system prompt for cacheability, volatile turn context, dynamic skills/tools, and evals for model interpretation.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-agent-prompt`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `agent-prompt`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Compare OpenSpec requirements with `specs/agent-prompt.md` and mark any overlapping ownership with `agent-turn-handling`.
- [ ] 3.2 Decide whether prompt-builder tests should move from inline snapshots to structural assertions.
- [ ] 3.3 Decide whether `WORLD.md` belongs under personality/context or can carry broader organization policy.
- [ ] 3.4 Decide which prompt changes require a new eval before acceptance.
- [x] 3.5 Decide auth-resume prompt ownership: auth completion belongs to session-log projection, not `buildTurnContextPrompt(...)`.
- [ ] 3.6 Verify prompt tests or auth-resume integration tests explicitly guard against prompt-only auth lifecycle hints.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `replace` entries into follow-up tasks after review.
- [ ] 4.2 Map prompt-related evals to `agent-prompt`, `agent-turn-handling`, `skill-runtime`, and provider-specific capabilities.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-agent-prompt`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
