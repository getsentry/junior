# Backfill Worksheet: `agent-turn-handling`

## Scope

- Capability: `agent-turn-handling`
- Change: `spec-agent-turn-handling`
- Owner: chat/agent Slack runtime
- Status: drafted OpenSpec change, not yet canonical
- Canonical target: `specs/agent-turn-handling.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/chat-architecture.md`: end-to-end Slack event to durable agent turn flow.
- `specs/slack-agent-delivery.md`: Slack entry surfaces, progress, replies, continuation, files, images, resume delivery.
- `specs/agent-session-resumability.md`: timeout/auth pause, session records, continuation slices.
- `specs/agent-prompt.md`: execution bias, source hierarchy, Slack side-effect rules, resumed-turn prompt context.
- `specs/harness-agent.md`: Pi loop, terminal output resolution, diagnostics.
- `specs/harness-tool-context.md`: runtime-owned context-bound tool targets.
- `specs/testing.md`: layer selection rules.

### Code Paths

- `packages/junior/src/chat/ingress/message-router.ts`: DM/mention/subscribed routing.
- `packages/junior/src/chat/runtime/slack-runtime.ts`: mention/subscribed handlers, queued skipped messages, opt-out, processing reaction hooks.
- `packages/junior/src/chat/services/subscribed-decision.ts`: passive subscribed-thread routing.
- `packages/junior/src/chat/prompt.ts`: model-facing execution, conversation, Slack side-effect, progress, and failure rules.
- `packages/junior/src/chat/respond.ts`: Pi turn execution, skills/tools, auth pause, timeout pause, resumed-turn context.
- `packages/junior/src/chat/runtime/reply-executor.ts`: turn lifecycle, final Slack delivery, side-effect suppression, persistence.
- `packages/junior/src/chat/services/turn-result.ts`: terminal output and reaction/channel side-effect result handling.

### Tests And Evals

- Unit:
  - `tests/unit/slack/chat-ingress-bindings.test.ts`
  - `tests/unit/slack/slack-runtime.test.ts`
  - `tests/unit/routing/subscribed-decision.test.ts`
  - `tests/unit/turn-result.test.ts`
- Integration:
  - `tests/integration/slack/bot-handlers.test.ts`
  - `tests/integration/slack/new-mention-behavior.test.ts`
  - `tests/integration/slack/subscribed-message-behavior.test.ts`
  - `tests/integration/slack/processing-reaction-behavior.test.ts`
  - `tests/integration/slack/attachment-media-behavior.test.ts`
  - `tests/integration/slack/bot-image-hydration.test.ts`
  - `tests/integration/turn-resume-slack.test.ts`
  - `tests/integration/oauth-resume-slack.test.ts`
- Evals:
  - `packages/junior-evals/evals/core/passive-behavior.eval.ts`
  - `packages/junior-evals/evals/core/routing-and-continuity.eval.ts`
  - `packages/junior-evals/evals/core/lifecycle-and-resilience.eval.ts`
  - `packages/junior-evals/evals/core/output-contract.eval.ts`
  - `packages/junior-evals/evals/core/media-and-attachments.eval.ts`
  - `packages/junior-evals/evals/core/oauth-workflows.eval.ts`

### Package Docs And Scripts

- `packages/junior-evals/README.md`: eval layer intent and execution.
- Root `AGENTS.md`: Slack/runtime/test layer conventions.
- `pnpm --filter @sentry/junior exec vitest run ...`: targeted deterministic checks.
- `pnpm --filter @sentry/junior-evals evals ...`: model-dependent checks.

## Prior Art

- Slack app design: shared-channel apps should avoid noisy, chatty behavior and use appropriate surfaces.
- Slack agent/assistant docs: assistant threads provide app-thread UX and status/title surfaces, while user messages remain the conversational input.
- Slack Marketplace Messages tab guidance: direct messages are an explicit conversational surface when enabled.
- Microsoft Teams bot docs: personal chats are conversational; channel/group chat bot participation is generally explicit/mentioned.
- Discord bot best practices: avoid normal-chat activation and prefer explicit invocation to reduce spam.

Applicability: these platforms differ in APIs, but they share a norm that shared spaces require stricter invocation than private/app-owned conversations.

## Implemented Behavior

- DMs route as `new_mention` without requiring `isMention`.
- Subscribed messages route through passive reply policy even when mention state is present; explicit mention short-circuits policy to reply.
- Unsubscribed non-mentions are ignored.
- Runtime ignores messages authored by Junior itself.
- `MessageContext.skipped` messages are forwarded into the next handled turn.
- Subscribed-thread preflight skips leading addresses to another party.
- Acknowledgement-only passive messages skip without calling the classifier.
- Attachment-backed passive messages go through the classifier rather than auto-replying.
- Immediate terse clarifications after Junior's prior answer can reply.
- Low-confidence classifier `true` decisions skip.
- Explicit stop instructions unsubscribe and acknowledge.
- Channel post and reaction tool results can suppress duplicate thread text.
- Auth and timeout pauses are runtime-owned; resumed turns continue from durable session state.
- Image attachments are preserved and unavailable vision is distinguished from no attachment.

## Intended Behavior

- Active surfaces: DM, explicit mention, and user-authored Slack assistant/app-thread messages should be reply-eligible.
- Passive subscribed threads should prefer silence unless the latest message turns the floor back to Junior.
- Attachments should influence routing and answer context, not automatically create reply intent.
- The model should act in-turn when tools/sources are available and ask only when blocked.
- Slack side effects should require explicit user intent and successful tool results.
- Runtime-authored status, auth, and continuation notices should not be duplicated by final model text.

## Undefined Behavior / Open Questions

| Question                                                                             | Evidence                                                                                                             | Options                                                            | Recommendation                                                                    | Status   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------- |
| Should Slack assistant app-thread user messages be a separate requirement from DMs?  | Current specs distinguish assistant lifecycle events from message events; routing treats DM/user messages as active. | Separate requirement; keep as active request scenario.             | Keep one active-request requirement with explicit lifecycle non-turn scenario.    | deferred |
| How strict should passive classifier confidence thresholds be in the canonical spec? | Code uses thresholds from `subscribed-decision.ts`; product intent is "prefer silence when uncertain."               | Specify numeric thresholds; keep thresholds implementation detail. | Keep numeric thresholds implementation detail and specify silence-on-uncertainty. | resolved |
| Should attachment-only passive messages ever auto-reply?                             | Unit/integration tests route through classifier; prior art discourages unsolicited shared-channel replies.           | Auto-reply for attachments; classify with attachment context.      | Classify with attachment context.                                                 | resolved |
| Which eval names should survive?                                                     | Existing eval files mix routing, lifecycle, output, auth, and media behavior.                                        | Keep names; rename/split by capability.                            | Build capability verification map first, then rename/split.                       | open     |

## OpenSpec Requirements Draft

| Requirement                             | Scenarios                                                                                                              | Source Evidence                                                                   | Notes                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Active user requests                    | DM ask, channel mention, assistant lifecycle setup, explicit stop instruction                                          | `message-router.ts`, `slack-runtime.ts`, chat ingress tests, Slack assistant docs | Lifecycle event is not a user turn.                    |
| Passive subscribed-thread participation | human side conversation, acknowledgement, terse clarification, low-confidence routing, attachment-only passive message | `subscribed-decision.ts`, routing tests, subscribed integration tests             | Attachment handling was corrected during verification. |
| Self-message loop prevention            | Junior-authored message observed                                                                                       | `reply-executor.ts` self-message guard                                            | Prevents reply loops.                                  |
| Queued and skipped user input           | queued messages, skipped passive later relevant                                                                        | `slack-runtime.ts`, Chat SDK queue contract, image hydration tests                | Need broader integration coverage audit.               |
| In-turn execution policy                | actionable request, missing access, mutable fact                                                                       | `prompt.ts`, evals                                                                | Primarily eval-verified.                               |
| Thread continuity and role attribution  | follow-up references prior answer, requester differs                                                                   | `prompt.ts`, conversation memory                                                  | Needs eval taxonomy review.                            |
| Slack side-effect intent                | channel post, reaction, side effect satisfies turn                                                                     | `prompt.ts`, `turn-result.ts`, Slack tool tests                                   | Deterministic plus eval coverage.                      |
| Progress and resumed-turn behavior      | long-running work, auth resume, timeout resume                                                                         | `prompt.ts`, `respond.ts`, resume tests                                           | Runtime delivery owned elsewhere.                      |
| Attachments and unavailable vision      | text/file attachment, image analysis unavailable                                                                       | media/attachment tests, Slack delivery spec                                       | Shared with attachment-and-vision capability.          |
| Turn completion                         | normal answer, failure, empty answer fallback                                                                          | `reply-executor.ts`, `turn-result.ts`, delivery tests                             | Final delivery is Slack spec boundary.                 |

## Migration Notes

- Canonical spec updates:
  - Add `specs/agent-turn-handling.md` after review.
  - Add to `specs/index.md` ownership map.
  - Add to root `AGENTS.md` known specs.
- Superseded content:
  - Keep `agent-prompt.md`, `harness-agent.md`, and `slack-agent-delivery.md` authoritative for their narrower boundaries.
  - Link them from the new turn-handling spec rather than moving all details.
- Test/eval taxonomy changes:
  - Create capability map before renaming existing eval files.
  - Likely split passive routing, source use, side effects, resume behavior, and output contract evals.

## Validation Notes

- `openspec validate spec-agent-turn-handling`: passed on 2026-05-30.
- Targeted deterministic tests run on 2026-05-30:
  - `tests/unit/routing/subscribed-decision.test.ts`
  - `tests/unit/slack/slack-runtime.test.ts`
  - `tests/unit/turn-result.test.ts`
  - `tests/unit/slack/chat-ingress-bindings.test.ts`
  - `tests/integration/slack/new-mention-behavior.test.ts`
- Repository validation run on 2026-05-30:
  - `pnpm typecheck`
  - `pnpm skills:check`
- Targeted eval command run on 2026-05-30:
  - `pnpm --filter @sentry/junior-evals evals evals/core/passive-behavior.eval.ts evals/core/routing-and-continuity.eval.ts evals/core/lifecycle-and-resilience.eval.ts evals/core/output-contract.eval.ts evals/core/media-and-attachments.eval.ts evals/core/oauth-workflows.eval.ts`
  - Result: 6 eval files passed, 25 tests passed. One lifecycle failure-reply scenario scored 0.75 while the suite passed.
- Deferred verification:
  - Model-dependent eval taxonomy audit and any renamed/split eval files.
