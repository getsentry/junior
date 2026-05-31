## 1. Source Inventory

- [x] 1.1 Review `agent-prompt`, `tool-execution`, `sandbox-tools`, `plugin-runtime`, `mcp-tool-runtime`, `testing`, and `eval-testing` boundaries.
- [x] 1.2 Inspect `skills.ts`, `load-skill.ts`, `skill-sandbox.ts`, skill sync behavior, prompt/respond skill loading, and skill tests/evals.
- [x] 1.3 Inventory coverage for frontmatter validation, discovery, invocation parsing, plugin ownership, runtime boundaries, loadSkill output, allowed-tools filtering, and skill file sandboxing.
- [x] 1.4 Review Agent Skills/SKILL.md prior art around metadata discovery, on-demand full-body loading, references, and tool restrictions.

## 2. OpenSpec Backfill Artifacts

- [x] 2.1 Create the proposal for `backfill-skill-runtime`.
- [x] 2.2 Create the design document with decisions, risks, and open questions.
- [x] 2.3 Create the OpenSpec capability spec for `skill-runtime`.
- [x] 2.4 Create the backfill worksheet.
- [x] 2.5 Create the verification map.

## 3. Canonical Alignment Review

- [ ] 3.1 Decide exact semantics of `disable-model-invocation`.
- [ ] 3.2 Decide whether `allowed-tools` remains exact runtime names or supports portable patterns.
- [ ] 3.3 Decide whether unknown skill results should become expected tool errors.
- [ ] 3.4 Decide whether discovery cache TTL should be specified or left implementation detail.

## 4. Verification Taxonomy Follow-up

- [ ] 4.1 Convert verification-map `add`, `split`, and `rename` entries into follow-up tasks after review.
- [ ] 4.2 Map skill evals to named skill-runtime requirements.
- [ ] 4.3 Add missing coverage for discovery precedence/cache and plugin mismatch if absent.

## 5. Validation

- [x] 5.1 Run `openspec validate backfill-skill-runtime`.
- [x] 5.2 Record validation results and deferred runtime/test/eval verification.
