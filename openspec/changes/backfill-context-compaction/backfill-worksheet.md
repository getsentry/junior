# Backfill Worksheet: `context-compaction`

## Scope

- Capability: Context compaction
- Change: `backfill-context-compaction`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/context-compaction/spec.md` after review; current prose source remains `specs/context-compaction.md`

## Current-Source Inventory

### Existing Specs And Policies

- `specs/context-compaction.md`: primary target contract for Pi-history compaction, visible conversation-state bounds, summary shape, token accounting, failure behavior, and verification.
- `specs/agent-session-resumability.md`: durable session-log projection, safe pause boundaries, and transient session-record/read-model migration.
- `specs/agent-prompt.md`: volatile runtime-turn context ownership and stripping.
- `specs/slack-agent-delivery.md`: compaction status and no standalone Slack message delivery.
- `specs/testing.md`: unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/services/context-compaction.ts`: retained user-message selection, summary input rendering, summarizer call, replacement history construction, session-log projection commit, and compaction result.
- `packages/junior/src/chat/services/context-budget.ts`: model context-window threshold calculations and environment override behavior.
- `packages/junior/src/chat/respond-helpers.ts`: runtime-turn-context stripping and trailing assistant trimming.
- `packages/junior/src/chat/state/session-log.ts`: projection-reset mechanics, conversation-local `sessionId` markers, active projection filtering, and durable session-log projection.
- `packages/junior/src/chat/state/turn-session.ts`: transitional pause/resume read model; no longer the compaction storage target.
- Slack runtime/turn preparation paths that load prior Pi history, invoke the compactor, show status, and pass `piMessages` into assistant execution.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/services/context-compaction.test.ts`
  - `packages/junior/tests/unit/services/context-compaction.test.ts` threshold cases through `context-budget`
  - `packages/junior/tests/unit/services/context-compaction.test.ts` projection reset and awaiting-resume cases
  - `packages/junior/tests/unit/services/context-compaction.test.ts` summary input tail preservation
- Integration:
  - `packages/junior/tests/integration/slack/message-content-behavior.test.ts`
    - uses compacted Pi history on the next turn
    - shows compaction status and returns to normal status
    - prefers active-turn Pi history over compacting older completed history
- Evals:
  - No dedicated long-thread compaction eval was identified in this pass.

### Package Docs And Scripts

- `packages/junior-evals/README.md`: eval behavior layer for future long-thread continuity coverage.
- Root `AGENTS.md`: evals for model-dependent behavior and integration tests for runtime wiring.

## Prior Art

- Platform or API docs:
  - No external API owns Junior's local compaction flow.
- SDK/source references:
  - Pi/Codex-style agents treat compaction as model-history projection replacement: preserve durable history, create a handoff summary, and keep a recent tail rather than mutating every old item.
  - Junior's session log supports projection replacement with `projection_reset` and conversation-local `sessionId` filtering.
- Comparable product or agent behavior:
  - Long-running coding agents compact by summarizing older context and preserving recent user intent so the next model step can continue without replaying the full transcript.
- Notes on applicability:
  - Prior art supports projection replacement and tail preservation. Junior-specific Slack status, visible conversation-state compaction, and session-record migration remain repo-owned behavior.

## Implemented Behavior

- Behavior that code currently enforces:
  - Automatic compaction operates on reusable Pi messages selected by the runtime before the next turn.
  - Oversized reusable history is summarized with the fast model.
  - Summary input preserves recent history by keeping the tail and marking older context omitted.
  - Retained user messages are selected newest-first within budget and restored to chronological order.
  - Retained messages exclude stale runtime context, existing compaction summaries, base64/image-heavy payloads, assistant messages, and tool results.
  - Replacement history is retained user messages plus one synthetic user-role handoff summary.
  - Current implementation persists the replacement through `commitMessages(...)`; divergent replacement history appends `projection_reset` and advances the active `sessionId`.
  - Automatic compaction status can be shown before the agent turn and normal status resumes before assistant execution.
  - Summarization failure logs a warning and continues with prior history.
- Behavior that tests currently verify:
  - Context-window threshold math and model override behavior.
  - Retained-message selection and runtime-context stripping.
  - Compaction replaces the current conversation projection without creating a synthetic session record and does not rewrite prior log entries.
  - Tail-preserving summary input for oversized source histories.
  - Structured tool context contributes to threshold decisions.
  - Awaiting-resume and missing reusable histories do not compact.
  - Slack runtime uses compacted Pi history on the next turn and shows status.
  - Active turn history is preferred over compacting older completed history.
- Behavior that appears accidental or weakly enforced:
  - Deterministic event ids/idempotency keys for automatic compaction are target behavior; current reset markers are generated from reset count (`session_#`).
  - Visible Slack conversation-state compaction is described in prose, but concrete implementation and tests were not confirmed in this pass.
  - No dedicated model-behavior eval proves long-thread continuity after compaction.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Compaction is a pre-turn optimization for reusable history, not a user-visible command.
  - Compaction must never rewrite prior durable history destructively.
  - Replacement history must be small, safe, and useful: recent user wording plus a concise handoff summary.
  - Awaiting timeout/auth pauses must not be compacted.
  - Runtime context is reintroduced by prompt construction, not stored in compacted history.
  - Visible Slack conversation-state compaction remains bounded and preserves attachment/image summaries needed for future mentions.
- Behavior that should remain implementation detail:
  - Exact retained-message token budget value.
  - Exact summarizer prompt wording.
  - Exact status text such as "Compacting context".
  - Exact session-record helper function names during transition.
- Behavior that should be non-goal:
  - Mid-turn compaction.
  - User-facing compaction commands.
  - Remote compaction endpoints.
  - Rewriting partially visible assistant output.

## Undefined Behavior / Open Questions

| Question                                                | Evidence                                                                                                        | Options                                                                                       | Recommendation                                                                        | Status |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| What is the idempotency key for automatic compaction?   | Canonical spec wants deterministic source-position identity; implementation advances `session_#` on each reset. | Source event id, source message count/hash, previous session id, or explicit idempotency key. | Use source log position once the full session-log event envelope is implemented.      | open   |
| Who owns visible conversation-state compaction details? | Context spec mentions it; conversation state capability will own state shape.                                   | Keep here, move to `conversation-state`, or split.                                            | Keep high-level bounds here; concrete state schema belongs to `conversation-state`.   | open   |
| What eval proves compaction quality?                    | No dedicated eval identified.                                                                                   | Add core long-thread eval, reuse provider eval, or rely on integration only.                  | Add a core eval where answer depends on compacted summary plus retained user wording. | open   |
| Should mid-turn compaction ever exist?                  | Spec forbids it today.                                                                                          | Keep forbidden, add internal handoff later, or use Pi-native compaction if exposed.           | Keep forbidden until Pi `continue()` safety is proven.                                | open   |

## OpenSpec Requirements Draft

| Requirement                              | Scenarios                                                                     | Source Evidence                                            | Notes                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Context authority separation             | Reusable Pi history, visible state, runtime reinjection                       | `context-compaction.md`, `agent-prompt.md`, runtime wiring | Prevents confusing Slack transcript shrink with model history shrink. |
| Pre-turn Pi compaction eligibility       | Completed oversized, awaiting resume, running/missing, active-turn precedence | `context-compaction.ts`, integration tests                 | Critical safety boundary.                                             |
| Replacement history shape                | Replacement, truncation, existing summaries, unsafe content                   | `selectRetainedUserMessages`, unit tests                   | Exact budget value is implementation detail.                          |
| Handoff summary construction             | Prompt source, tail preservation, one item, secret redaction                  | `summarizeContext`, `renderSummaryInput`                   | Exact prose not stable.                                               |
| Compaction projection persistence        | projection reset, session marker advance, retry/idempotency                   | `session-log.ts`, tests                                    | Idempotency remains target/current gap.                               |
| Automatic compaction timing and Slack UX | Pre-turn, use compacted history, status, no thread message                    | Slack integration tests, delivery spec                     | Status delivery belongs to Slack runtime.                             |
| Token budget triggers                    | Agent threshold, visible threshold, usage counts, cumulative usage            | `context-budget.ts`, tests                                 | Server usage preference is target.                                    |
| Compaction failure behavior              | Summary failure, persistence failure, parse failure                           | code/tests                                                 | Persistence failure coverage unclear.                                 |
| Verification taxonomy                    | Unit, integration, eval                                                       | `testing.md`, current tests                                | Long-thread eval missing.                                             |

## Migration Notes

- Canonical spec updates:
  - Keep `specs/context-compaction.md` authoritative until OpenSpec baseline is accepted.
  - Clarify that same-log projection reset is current behavior; deterministic source-position idempotency remains open.
  - Keep visible conversation-state compaction high-level here and let `conversation-state` own exact storage fields.
- Index/pointer updates:
  - No index update needed for this draft because `specs/context-compaction.md` is already listed.
- Superseded content:
  - None yet. Do not archive canonical prose during this spec-only draft.
- Test/eval taxonomy changes:
  - Defer long-thread eval creation and deterministic reset-id tests until after review.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-context-compaction' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: deterministic idempotency, persistence failure handling, visible conversation-state compaction, and long-thread model continuity eval.
