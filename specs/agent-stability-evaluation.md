# Agent Stability Evaluation

Last updated: 2026-02-27

## Scope

This document tracks stability risks in the Slack agent loop, concrete mitigations, and validation status.

## Baseline Findings

1. Multi-layer retry flow (`primary loop -> finalization retries -> forced finalization -> completion classifier -> completion retry loop`) can amplify failures and latency.
2. Completion classification uses an extra LLM step, introducing nondeterminism for terminal decisions.
3. Retry attempts inject corrective instructions as new user messages without preserving full previous assistant/tool state.
4. Multiple tools swallow operational errors (`{ ok: false }`) instead of surfacing hard tool errors to the loop runtime.
5. Broad `toolChoice: "required"` usage can encourage unstable tool oscillation.
6. Side-effect tools can repeat writes on retries without idempotency protections.
7. Loop observability is rich, but control-plane guards for "no progress" are limited.
8. The "continue loop" logic (ported from PI) likely contributes to instability via repeated autonomous retries.
9. Channel-member enrichment currently fans out one `users.info` call per member concurrently, which can trigger rate limiting and partial results.

## Evaluation Checklist

| Concern | Plan | Status | Validation |
| --- | --- | --- | --- |
| Collapse compounding retry structure | Remove classifier-driven continuation loop and keep bounded deterministic finalization | Completed | `src/chat/respond.ts` no longer runs completion classifier/retry agent branch |
| Reduce terminal nondeterminism | Remove LLM-based completion classifier from terminal decision path | Completed | `src/chat/respond.ts` no longer depends on `classifyCompletionOutcome` |
| Preserve retry context | Rework retries to use prior response messages/tool context rather than only corrective text | Completed | Finalization retries now include `...finalResult.response.messages` |
| Tool failure semantics | Throw operational tool failures to emit `tool-error` outputs | Completed | Updated `web-fetch`, `image-generate`, and Slack tool catch paths to throw |
| Tool-loop control | Add deterministic prepare-step guardrails against repetitive tool call patterns | Completed | Added `prepareStep` loop guard + `onStepFinish` tool-error logging in `respond.ts` |
| Side-effect idempotency | Add per-turn dedupe keys for create/update Slack artifact tools | Completed | Added operation cache in `ToolState` + dedupe keys in side-effect tools |
| PI continue-loop diagnosis | Remove/replace auto-continue branch and document behavior change | Completed | Removed PI-style auto-continue retry loop from `respond.ts` |
| Test coverage | Add focused tests for idempotency + regression-prone loop helpers | Completed | Added `tests/tool-idempotency.test.ts` |
| Channel member enrichment rate limits | Refactor member profile lookup to bounded concurrency (or staged hydration) | Pending | `src/chat/slack-actions/channel.ts` currently uses broad `Promise.all` fan-out |

## Notes

- This tracker is intentionally implementation-facing and should be updated as each concern is resolved.
- Validation run:
  - `pnpm test` passed (8 files, 25 tests)
  - `pnpm typecheck` passed
- Post-merge regression (2026-02-25):
  - Symptom: `AI_MissingToolResultsError` during finalization retries.
  - Cause: Retry history reused `response.messages` that could contain unresolved non-provider `tool-call` parts before appending a new user message.
  - Mitigation: sanitize retry history and strip unresolved non-provider tool calls before finalization retry generation (`src/chat/respond.ts`).
- Policy update (2026-02-25):
  - Finalization retries are disabled for now to avoid masking failures and compounding instability.
  - Runtime flow is now: primary loop -> forced no-tool finalization (single fallback) -> explicit failure surfacing.
- Validation run after mitigation:
  - `pnpm typecheck` passed
  - `pnpm test` passed (8 files, 25 tests)
- Residual risks:
  - Loop guard behavior is covered by unit-level logic and compile checks, but not by a full mocked `generateAssistantReply` integration test.
  - Tool idempotency cache is per turn (intended) and does not dedupe across separate Slack invocations.
