## Context

Current turn-response behavior is implemented across several surfaces:

- `packages/junior/src/chat/runtime/slack-runtime.ts` decides Slack entry behavior for explicit mentions and subscribed-thread messages, including skipped passive messages and thread opt-out.
- `packages/junior/src/chat/services/subscribed-decision.ts` contains the prior-art routing policy for passive subscribed threads: explicit mentions reply, acknowledgements and side conversations stay silent, immediate clarifications after Junior replies can continue, and low-confidence classifier outcomes skip.
- `packages/junior/src/chat/prompt.ts` carries the model-facing execution contract: act in the current turn, use tools for mutable/current/source-backed work, ask only when blocked, use Slack side-effect tools only on explicit request, and finish with a final Slack-markdown response unless a successful Slack side effect already satisfied the request.
- `packages/junior/src/chat/respond.ts` owns Pi agent execution, skill/tool discovery, runtime turn context, progress reporting, session records, auth pause, timeout pause, and final assistant output resolution.
- `packages/junior/src/chat/runtime/reply-executor.ts` owns the outer turn lifecycle: start active turn, preserve queued messages, schedule continuations, deliver final Slack replies/files, persist assistant state only after delivery, and recover from auth/timeout/failure paths.

The canonical specs already define surrounding contracts:

- `specs/chat-architecture.md`: end-to-end data flow and module ownership.
- `specs/slack-agent-delivery.md`: Slack entry, progress, continuation acknowledgement, and final delivery.
- `specs/agent-session-resumability.md`: session records and continuation slices.
- `specs/agent-prompt.md`: prompt ownership, source hierarchy, execution bias, and prompt bloat controls.
- `specs/harness-agent.md`: Pi loop and final output resolution.
- `specs/harness-tool-context.md`: runtime-owned tool targeting.

The missing layer is the user-message policy that says what Junior is supposed to do for a turn before the details fall into prompt text, routing heuristics, runtime persistence, or Slack API delivery.

## Goals / Non-Goals

**Goals:**

- Add a testable capability spec for agent turn handling, focused on user intent, participation policy, tool/source use, clarification, Slack side effects, and completion.
- Describe Slackbot scenarios in product terms so future prompt/routing/runtime changes can be evaluated against the same contract.
- Preserve existing ownership boundaries: this spec references delivery, resumability, prompt, and harness specs instead of duplicating their low-level rules.
- Make verification expectations explicit: deterministic routing and delivery use integration/unit tests; model judgment and reply quality use evals.

**Non-Goals:**

- Rewriting Slack transport, message chunking, status, or final delivery contracts.
- Replacing the Pi agent loop or session resumability specs.
- Freezing exact prompt prose or classifier wording.
- Defining plugin-specific workflows or provider-specific tool behavior.

## Decisions

### Decision: Create a new `agent-turn-handling` capability

The new capability owns "how Junior should respond to a user-authored message" at the policy/scenario level. It does not own how a response is posted, persisted, or resumed.

Alternatives considered:

- Extend `slack-agent-delivery.md`: rejected because that spec already owns Slack delivery mechanics and should not absorb model-behavior policy.
- Extend `agent-prompt.md`: rejected because prompt text is one implementation mechanism. The desired contract must also constrain routing, tests, and future non-prompt agent surfaces.
- Extend `harness-agent.md`: rejected because harness output resolution is lower level than user-message participation and Slackbot interaction policy.

### Decision: Treat current implementation as prior art, not as the whole contract

The spec should encode the important behavior already present in code while naming scenarios that are currently implicit:

- Explicit mentions and DMs are active requests.
- Slack assistant lifecycle events initialize or refresh metadata; `message.im`/Chat-tab user messages are the actual assistant app-thread turns.
- Subscribed threads are passive unless routed back to Junior.
- Attachments affect routing and answer context but do not automatically make a passive subscribed-thread message reply-worthy.
- Queued skipped messages are part of the next handled turn.
- Acknowledgements, status chatter, and human side conversations do not require replies.
- Terse clarifications immediately after Junior's answer can be implicit follow-ups.
- Self-authored messages are ignored to avoid reply loops.
- Successful Slack side-effect tools can satisfy a turn without a duplicate thread reply.
- Auth/timeout notices are runtime-owned and resumed turns should return final content only.

Alternatives considered:

- Document only implementation structure: rejected because it would not help evaluate conversational scenarios.
- Define broad conversational ideals: rejected because it would be too hard to verify and too easy to conflict with runtime contracts.

### Decision: Verify model interpretation with evals, deterministic boundaries with tests

Scenarios that depend on natural-language judgment, such as whether a subscribed-thread message turns back to Junior, require eval coverage. Scenarios with deterministic behavior, such as explicit mentions bypassing passive routing or runtime suppressing duplicate reply text after a reaction, belong in unit/integration tests according to `specs/testing.md`.

Alternatives considered:

- Static prompt assertions: rejected by `specs/agent-prompt.md` and `specs/testing.md`.
- Unit tests for full Slackbot workflows: rejected because runtime behavior should use real wiring where possible.

## Risks / Trade-offs

- Spec overlap with existing Slack and prompt specs -> Mitigation: keep this capability focused on user-message policy and link to existing specs for delivery, prompt, tool targeting, and resumability.
- Over-constraining model behavior -> Mitigation: specify observable turn outcomes and scenarios, not exact wording.
- Under-testing natural-language cases -> Mitigation: tasks require eval cases for implicit follow-up, side conversation, opt-out, and Slack side-effect scenarios.
- Drift between OpenSpec artifacts and canonical `specs/` docs -> Mitigation: implementation task includes adding `specs/agent-turn-handling.md` and updating `specs/index.md` plus root known-spec pointers.

## Migration Plan

1. Add canonical `specs/agent-turn-handling.md` from the OpenSpec requirements and design decisions.
2. Update spec indexes/pointers so future agents discover it.
3. Add focused verification for high-risk gaps only:
   - deterministic routing/unit coverage for subscribed preflight and explicit mention behavior where missing
   - integration coverage for queued-message and duplicate Slack side-effect outcomes where missing
   - eval coverage for natural-language participation and reply policy
4. Update prompt/routing/runtime code only if verification reveals drift from the new spec.

Rollback is documentation-only until implementation changes are made: remove the new canonical spec and index pointers if the contract is rejected.

## Open Questions

- Should passive subscribed-thread classifier confidence thresholds remain implementation details, or should the canonical spec name minimum confidence behavior explicitly?
- Should "DM" and "Slack assistant app thread" be represented as separate scenarios if they share the same active-request policy?
- Which existing eval harness best captures Slackbot turn behavior without duplicating Slack delivery integration tests?
