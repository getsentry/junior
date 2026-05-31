# Backfill Worksheet: `reply-planning`

## Scope

- Capability: Reply planning
- Change: `backfill-reply-planning`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/reply-planning/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/agent-turn-handling.md`: owns whether a user message should receive a response and whether side-effect-only completion satisfies the turn.
- `specs/harness-agent.md`: owns Pi agent final output and diagnostics boundary.
- `specs/slack-agent-delivery.md`: owns visible Slack delivery lifecycle and final reply UX.
- `specs/slack-outbound-contract.md`: owns Slack API formatting, file upload behavior, retries, and API error mapping.
- `specs/testing.md`: owns unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/services/turn-result.ts`: resolves new agent messages, tool calls/results, files, artifacts, provider errors, execution escapes, and diagnostics into `AssistantReply`.
- `packages/junior/src/chat/services/reply-delivery-plan.ts`: determines `thread` versus `channel_only` delivery and inline/follow-up/none file placement.
- `packages/junior/src/chat/slack/reply.ts`: converts `AssistantReply` into planned Slack post stages, splits long replies, attaches files to stages, and executes planned posts through Slack APIs.
- `packages/junior/src/chat/slack/footer.ts`: builds compact finalized reply footer blocks.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/turn-result.test.ts`
  - `packages/junior/tests/unit/slack/footer.test.ts`
  - `packages/junior/tests/unit/slack/footer-sentry-link.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/finalized-reply-behavior.test.ts`
- Evals:
  - Direct reply-planning evals are not needed for deterministic planning.
  - Existing natural-language behavior evals remain relevant to adjacent intent capabilities.

## Prior Art

- Chat and agent runtimes generally distinguish streaming/provisional output from finalized assistant state. Reply planning should depend on final messages/tool results rather than early deltas.
- Slack messages support a plain-text fallback surface and Block Kit formatting. Junior's planning preserves top-level text for delivery while footer/context blocks are presentation details on finalized text-bearing posts.
- Chatbots that perform platform side effects commonly suppress duplicate acknowledgement text only when the side effect itself is the visible answer.

## Implemented Behavior

- Behavior that code currently enforces:
  - Terminal assistant messages after tool results supersede provisional pre-tool text.
  - Empty tool-only turns become execution failures unless successful side effects or deliverable files satisfy the request.
  - Provider-error terminal messages classify provider-error outcome and may post partial interrupted text.
  - Reaction-only intents suppress redundant model acknowledgement text after successful reaction execution.
  - Explicit successful channel posts can suppress thread text as `channel_only`.
  - Failed reaction validation leaves thread delivery enabled and marks execution failure.
  - File-only replies still produce visible Slack file delivery.
  - Files can be carried on the first text post or delivered as follow-up stages.
  - Canvas-created verbose assistant text is shortened to a concise acknowledgement/link.
  - Raw execution/tool payload text is suppressed and treated as execution failure.
  - Attachment claims are checked against planned files.
  - Long finalized replies split into continuation posts after final text is known.
  - Fenced code blocks are preserved across split posts.
  - Footer blocks include compact ID/tokens/time/thinking metadata and optional Sentry conversation links.
- Behavior that tests currently verify:
  - `turn-result.test.ts` covers terminal output selection, empty tool-only failures, provider errors, reaction-only suppression, channel-post suppression, canvas shortening, and diagnostics.
  - `finalized-reply-behavior.test.ts` covers finalized-only posting, provisional delta dropping, file-only replies, suppressed-thread file delivery, chunking, fenced-code preservation, and provider-error partial text.
  - Footer unit tests cover compact item formatting and Sentry link availability.
- Behavior that appears accidental or weakly enforced:
  - Follow-up file delivery is supported by types/planning but default builder coverage is unclear.
  - Footer placement on the last text chunk is primarily inferred from post planning and integration behavior.
  - Strict versus best-effort file upload failure mode belongs to outbound delivery, but its interaction with reply planning should stay explicit.
  - Attachment-claim validation has important user-facing implications and may need more direct scenario naming.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Resolve visible replies from finalized assistant state.
  - Suppress duplicate text only after validated visible side effects.
  - Preserve files and artifacts as visible output even when text is suppressed.
  - Never post raw execution payloads or misleading attachment claims.
  - Plan Slack post stages deterministically before API writes.
  - Attach finalized footer metadata only to text-bearing finalized replies.
- Behavior that should remain implementation detail:
  - Exact internal `AssistantReply` object shape.
  - Exact chunk size thresholds.
  - Exact footer item ordering beyond compact, non-broken output.
  - Exact helper names and diagnostics field names.
- Behavior that should be non-goal:
  - Deciding whether a user deserves a reply.
  - Choosing model prompt wording.
  - Slack API retry/backoff semantics.
  - Natural-language intent classification for channel/reaction/canvas requests.

## Undefined Behavior / Open Questions

| Question                                             | Evidence                                                                                              | Options                                                            | Recommendation                                                                         | Status |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------ |
| Should follow-up file delivery be first-class?       | `ReplyFileDelivery` includes `followup`; default builder mainly emits inline/none in inspected paths. | Keep, remove, or move to outbound.                                 | Keep as planning option until usage is audited.                                        | open   |
| Should provider-error partial text be mandatory?     | Integration verifies partial text can be marked interrupted and posted.                               | Always post partial, post only useful partial, or generic failure. | Specify MAY include useful partial text; revisit after product review.                 | open   |
| Where does canvas reply shortening belong?           | Implemented in `turn-result.ts`, but canvas behavior is tool-specific.                                | Reply planning, canvas tool spec, or split.                        | Keep general artifact shaping here; tool-specific creation in tool spec.               | open   |
| Is footer product behavior or diagnostics?           | Footer tests assert formatting and links; Slack delivery uses it on final text.                       | Canonical product behavior, diagnostic detail, or outbound-only.   | Specify placement and non-broken link invariant; leave exact metadata detail flexible. | open   |
| Should strict file upload failure be specified here? | `postSlackApiReplyPosts` owns upload failure handling.                                                | Reply planning owns, outbound owns, or split.                      | Outbound owns API failure; reply planning owns planned file visibility.                | open   |

## OpenSpec Requirements Draft

| Requirement                          | Scenarios                                                              | Source Evidence                                                      | Notes                                    |
| ------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| Terminal assistant output resolution | provisional ignored, terminal text used, provider error, empty failure | `turn-result.ts`, `turn-result.test.ts`, finalized reply integration | Bridges harness-agent to reply planning. |
| Side-effect-only reply planning      | channel post, reaction-only, reaction plus text, validation failure    | `reply-delivery-plan.ts`, `turn-result.test.ts`                      | Turn eligibility stays elsewhere.        |
| File-visible reply planning          | inline files, file-only, follow-up, channel-only files                 | `slack/reply.ts`, finalized reply integration                        | Preserves deliverables.                  |
| Canvas and artifact reply shaping    | URL, no URL                                                            | `turn-result.ts`, tests                                              | General artifact rule.                   |
| Unsafe payload suppression           | execution escape, attachment claim mismatch                            | `turn-result.ts`                                                     | Important safety contract.               |
| Slack reply post planning            | chunking, fenced code, file-only, empty                                | `slack/reply.ts`, integration tests                                  | API writes are outbound.                 |
| Final reply footer planning          | one post, multiple chunks, blank posts, missing Sentry link            | `footer.ts`, footer tests                                            | Presentation invariant.                  |
| Verification taxonomy                | unit, integration, eval boundary                                       | `testing.md`                                                         | Keeps evals scoped.                      |

## Migration Notes

- Canonical spec updates:
  - Add `reply-planning` to index after acceptance.
  - Keep `slack-outbound-contract` focused on API writes and formatting.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Narrow overlapping final-reply details in `slack-agent-delivery` after this capability is accepted.
- Test/eval taxonomy changes:
  - Rename broad finalized reply tests only if doing so improves discoverability without hiding Slack integration coverage.
  - Keep model intent evals outside this deterministic capability.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-reply-planning' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: follow-up file mode, footer last-chunk placement, attachment-claim scenario naming, and strict file upload failure boundary.
