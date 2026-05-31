# Backfill Worksheet: `harness-agent`

## Scope

- Capability: Harness agent
- Change: `backfill-harness-agent`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/harness-agent/spec.md` after review; current prose source remains `specs/harness-agent.md`

## Current-Source Inventory

### Existing Specs And Policies

- `specs/harness-agent.md`: primary existing contract for Pi loop, final output, streaming, timeout, diagnostics.
- `specs/agent-session-resumability.md`: safe boundaries and timeout continuation after harness detection.
- `specs/agent-execution.md`: tool execution and model-repairable error behavior.
- `specs/harness-tool-context.md`: context-bound tool targeting.
- `specs/slack-agent-delivery.md`: final visible delivery and Slack persistence success gate.
- `specs/testing.md`: layer boundaries.

### Code Paths

- `packages/junior/src/chat/respond.ts`: Pi agent setup, prompt/continue, streaming subscription, timeout abort, provider retry, auth pause, turn result construction.
- `packages/junior/src/chat/services/turn-result.ts`: terminal assistant output extraction, side-effect-only success, delivery plan, diagnostics.
- `packages/junior/src/chat/services/turn-thinking-level.ts`: thinking-level routing.
- `packages/junior/src/chat/services/turn-failure-response.ts`: failed-turn finalization and diagnostics attributes.
- `packages/junior/src/chat/respond-helpers.ts`: assistant/tool message detection, text extraction, escape/raw payload detection.
- `packages/junior/src/chat/pi/traced-stream.ts`: provider tracing/error behavior.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/turn-result.test.ts`
  - `packages/junior/tests/unit/runtime/respond-timeout-resume.test.ts`
  - `packages/junior/tests/unit/runtime/respond-provider-retry.test.ts`
  - `packages/junior/tests/unit/runtime/respond-error-path.test.ts`
  - `packages/junior/tests/unit/runtime/respond-lazy-sandbox.test.ts`
  - `packages/junior/tests/unit/runtime/respond-mcp-progressive-loading.test.ts`
  - `packages/junior/tests/unit/services/turn-thinking-level.test.ts`
  - `packages/junior/tests/unit/chat/pi/traced-stream.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/finalized-reply-behavior.test.ts`
  - `packages/junior/tests/integration/mcp-auth-runtime-slack.test.ts`
  - `packages/junior/tests/integration/turn-resume-slack.test.ts`
- Evals:
  - Reply-quality evals indirectly verify final answer usefulness; they should not be used for deterministic harness mechanics.

## Prior Art

- Platform or API docs: No external platform defines Junior's harness contract.
- SDK/source references: Pi `Agent` supports `prompt()`, `continue()`, mutable `state.messages`, `subscribe(...)`, and `abort()`, which are the local primitives Junior relies on.
- Comparable product or agent behavior: Agent harnesses commonly separate intermediate tool transcript, provisional stream output, final assistant message extraction, and outer transport delivery.
- Notes on applicability: This spec should remain Pi/harness-focused and not absorb Slack delivery.

## Implemented Behavior

- Behavior that code currently enforces:
  - Fresh turns call `prompt(...)`; resumed turns call `continue()` after restoring messages.
  - Text deltas are forwarded best effort through callbacks.
  - Timeout calls `agent.abort()` and waits before snapshotting messages.
  - Provider retry trims retryable assistant error tails and continues from safe boundary.
  - Final output uses terminal assistant messages after tool results.
  - Empty, raw payload-like, or execution-escape output becomes execution failure.
  - Side-effect-only Slack reaction/channel/file successes can produce success without primary text.
  - Diagnostics include outcome, model, counts, thinking, usage, duration, and primary-text flag.
- Behavior that tests currently verify:
  - Terminal output extraction and provisional text suppression.
  - Provider error and empty output outcomes.
  - Side-effect-only delivery planning and reaction text suppression.
  - Canvas reply shortening.
  - Structured timing/usage diagnostics.
  - Timeout abort/resume metadata.
  - Provider retry success and cumulative usage.
  - Non-retryable failure diagnostics.
- Behavior that appears accidental or weakly enforced:
  - Exact stream separator differs from spec prose in places (`"\n\n"` versus `"\n"` expectation).
  - Side-effect delivery planning lives partly in `buildTurnResult`, which overlaps reply planning.
  - Diagnostics stability for public consumers is not fully classified.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Harness owns Pi execution and structured assistant reply creation.
  - Transport delivery is outside harness.
  - Provisional/pre-tool text is not terminal output.
  - Timeout and provider retry happen before final delivery.
  - Diagnostics are always present for downstream delivery/observability.
- Behavior that should remain implementation detail:
  - Exact Pi mock shape in tests.
  - Exact log event names for streaming callback failures.
  - Exact stream separator unless product relies on it.
- Behavior that should be non-goal:
  - Slack API posting.
  - OAuth credential security.
  - Tool schema definitions.
  - Model answer quality rubrics.

## Undefined Behavior / Open Questions

| Question                                              | Evidence                                                                                          | Options                                                             | Recommendation                                                              | Status |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| Should streaming separator be `\n` or `\n\n`?         | Existing prose says match final join; code inserts `\n\n` between assistant messages in one path. | Specify exact separator or only readability.                        | Keep behavior-level readability unless UI tests require exact.              | open   |
| Should side-effect-only planning move out of harness? | `buildTurnResult` creates delivery plan; reply planner also owns delivery.                        | Keep split, move to reply planning, or introduce shared planner.    | Defer to `reply-planning` backfill.                                         | open   |
| Which diagnostics are stable?                         | Footer/observability use subset of fields.                                                        | Make all stable, only outcome/counts stable, or presentation-owned. | Treat `AssistantReply.diagnostics` as internal structured contract for now. | open   |

## OpenSpec Requirements Draft

| Requirement             | Scenarios                                                        | Source Evidence                         | Notes                             |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| Pi turn execution       | Fresh, resumed, current prompt                                   | `respond.ts`, timeout/provider tests    | Cross-link session resumability.  |
| Thinking-level routing  | Success, fallback, context floor                                 | `turn-thinking-level.ts`, tests         | Could become separate spec later. |
| Final output resolution | Pre-tool ignored, terminal text, empty, raw payload, side-effect | `turn-result.ts`, `turn-result.test.ts` | Core harness behavior.            |
| Streaming callbacks     | Delta, separators, callback failure                              | `respond.ts`, finalized reply tests     | Final delivery separate.          |
| Timeout handling        | Abort, retryable metadata, fallback                              | `respond.ts`, timeout tests             | Session scheduling elsewhere.     |
| Provider retry          | Retry, success, unsafe/limit                                     | `respond.ts`, provider retry tests      | Cross-link session projection.    |
| Harness diagnostics     | Success, provider error, execution failure                       | `turn-result.ts`, tests                 | Avoid span/log assertions.        |
| Verification taxonomy   | Unit, runtime, eval                                              | testing specs                           | Required cleanup map.             |

## Migration Notes

- Canonical spec updates:
  - Keep `specs/harness-agent.md` authoritative until OpenSpec baseline is accepted.
  - Clarify stream separator and side-effect planning ownership later.
- Index/pointer updates:
  - No index update needed; `specs/harness-agent.md` is already listed.
- Superseded content:
  - None yet.
- Test/eval taxonomy changes:
  - Defer any test renames/splits to follow-up.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-harness-agent' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: stream separator, side-effect planning ownership, diagnostics public stability.
