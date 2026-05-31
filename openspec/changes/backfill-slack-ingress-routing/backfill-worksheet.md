# Backfill Worksheet: `slack-ingress-routing`

## Scope

- Capability: Slack ingress routing
- Change: `backfill-slack-ingress-routing`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/slack-ingress-routing/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/chat-architecture.md`: ingress as normalization/classification/queue handoff only.
- `specs/agent-turn-handling.md`: active/passive turn behavior after ingress dispatch.
- `specs/slack-agent-delivery.md`: assistant lifecycle surfaces, status, final delivery, files/images.
- `specs/slack-outbound-contract.md`: Slack write boundary, not ingress.
- `specs/testing.md`: unit/integration/eval boundaries.

### Code Paths

- `packages/junior/src/chat/ingress/message-router.ts`: thread id normalization and message-kind classification.
- `packages/junior/src/chat/ingress/junior-chat.ts`: Chat SDK overrides, waitUntil background processing, external-user filtering, assistant lifecycle/app-home/action/slash routing.
- `packages/junior/src/chat/ingress/message-changed.ts`: edited-message mention extraction and synthetic message construction.
- `packages/junior/src/chat/ingress/workspace-membership.ts`: external Slack user detection.
- `packages/junior/src/chat/queue/thread-message-dispatcher.ts`: queued message dispatch and attachment fetcher rehydration.
- `packages/junior/src/chat/app/production.ts`: production handler registration, DM override, skipped-message rehydration, lifecycle handlers.
- `packages/junior/src/chat/runtime/slack-runtime.ts`: runtime entrypoints that ingress dispatches into.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/slack/chat-ingress-bindings.test.ts`
  - `packages/junior/tests/unit/ingress/junior-chat.test.ts`
  - `packages/junior/tests/unit/slack/message-changed-ingress.test.ts`
  - `packages/junior/tests/unit/queue/thread-message-dispatcher.test.ts`
  - `packages/junior/tests/unit/slack/slack-runtime.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/assistant-lifecycle-contract.test.ts`
  - `packages/junior/tests/integration/slack/assistant-lifecycle-behavior.test.ts`
  - `packages/junior/tests/integration/slack/assistant-thread-contract.test.ts`
  - `packages/junior/tests/integration/slack/message-changed-behavior.test.ts`
  - `packages/junior/tests/integration/slack/message-changed-reply-contract.test.ts`
  - `packages/junior/tests/integration/slack/new-mention-behavior.test.ts`
  - `packages/junior/tests/integration/slack/subscribed-message-behavior.test.ts`
- Evals:
  - No ingress-specific evals are needed; model reply/no-reply behavior belongs to `agent-turn-handling`.

### Package Docs And Scripts

- `.agents/skills/slack-development/SKILL.md`: Slack ingress and assistant-thread guardrails.
- Slack fixture comments in `packages/junior/tests/fixtures/slack/factories/events.ts`: Chat SDK and Slack event references.

## Prior Art

- Slack Events API message events use `channel`, `ts`, optional `thread_ts`, and optional `subtype`; the same `message` event semantics apply across channel, group, IM, and MPIM subscriptions.
- Slack `message_changed` events carry edited text under `event.message`, and the `message` property contains the updated message object.
- Slack bot messages can be detected from bot fields/subtypes, and Junior should avoid self/bot loops.
- Slack assistant-thread lifecycle events provide `assistant_thread.channel_id`, `assistant_thread.thread_ts`, `assistant_thread.user_id`, and context; lifecycle events are setup/context events rather than user-authored turns.
- Chat SDK queue behavior provides handler categories and skipped-message context; queued messages may be serialized, losing function-valued attachment fetchers unless Junior rehydrates them.

## Implemented Behavior

- Behavior that code currently enforces:
  - Slack thread IDs are normalized from raw `channel`, `thread_ts`, and `ts` before `super.processMessage(...)`.
  - External Slack users are filtered before process-message delegation.
  - Direct messages are registered to route through `handleNewMention(...)` in production.
  - Subscribed messages route through `handleSubscribedMessage(...)`.
  - Explicit mentions in unsubscribed threads route to `new_mention`.
  - Unsubscribed non-mentions produce no thread-message kind.
  - Message-changed events synthesize mention messages only when the bot mention is newly added.
  - Queued/deserialized attachments are rehydrated with private Slack file fetchers before runtime use.
  - Assistant lifecycle events call lifecycle handlers under `waitUntil`.
  - Action/slash/reaction/app-home work is also scheduled through `waitUntil`.
- Behavior that tests currently verify:
  - Thread-id normalization and message-kind classification.
  - JuniorChat action/slash command `waitUntil` forwarding.
  - Message-changed mention extraction.
  - Queue dispatcher kind-to-runtime handoff and attachment rehydration.
  - Assistant lifecycle behavior and contracts.
  - New mention/subscribed behavior after ingress handoff.
- Behavior that appears accidental or weakly enforced:
  - `JuniorChat` tests do not appear to cover all process overrides such as assistant lifecycle/app-home/reaction failures.
  - External Slack user filtering coverage should be verified.
  - The generic `determineThreadMessageKind(...)` returns `subscribed_message` before checking mention, while the broader turn-handling spec says explicit mentions bypass passive routing; production registration and runtime preflight handle this, but ownership should be clarified.
  - Chat SDK payload assumptions are spread across code comments and fixture comments.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Normalize Slack identity before queueing.
  - Preserve queued/skipped user messages and attachment fetchers.
  - Route lifecycle events without running assistant answers.
  - Treat edited mentions as active turns only when mention is newly added.
  - Keep ingress mechanical and leave answer decisions to runtime services.
- Behavior that should remain implementation detail:
  - Exact synthetic message id suffix for edited mentions.
  - Exact logger event names.
  - Exact Chat SDK internal method names.
  - Whether helper tests live under `unit/slack` or `unit/ingress`.
- Behavior that should be non-goal:
  - Passive subscribed-thread answer policy.
  - Final Slack reply formatting/delivery.
  - Model prompt behavior.

## Undefined Behavior / Open Questions

| Question                                                                           | Evidence                                                                                                                                                                         | Options                                                                    | Recommendation                                                                      | Status |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| Should generic message-kind classification prefer mentions over subscribed status? | `determineThreadMessageKind` currently returns subscribed first; production separately routes DMs through mention handler and subscribed runtime has explicit mention preflight. | Change helper, keep as-is, or split helper by SDK callback type.           | Clarify ownership before changing; avoid runtime behavior changes in this backfill. | open   |
| Should edited-message mention extraction live in ingress or adapter wrapper?       | Current parser inspects raw Slack body.                                                                                                                                          | Keep ingress helper, move to adapter, or teach Chat SDK adapter.           | Keep ingress helper unless more raw Slack event shims appear.                       | open   |
| Which Slack subtypes should be explicitly ignored?                                 | Slack has many message subtypes; Junior only special-cases changed/bot/self.                                                                                                     | Enumerate ignore list, rely on adapter, or specify consumed subtypes only. | Specify consumed subtypes only and add explicit ignores when behavior matters.      | open   |
| Is external Slack Connect filtering configurable?                                  | `isExternalSlackUser` drops unsupported users.                                                                                                                                   | Always drop, configurable allowlist, or runtime policy.                    | Keep drop behavior until workspace/product policy changes.                          | open   |
| Should Chat SDK queue payload assumptions have a local reference?                  | Comments explain serialization strips fetchers.                                                                                                                                  | Keep comments, create spec/reference, or add tests only.                   | Verification map plus tests may be enough; revisit if assumptions spread.           | open   |

## OpenSpec Requirements Draft

| Requirement                                      | Scenarios                                                    | Source Evidence                                     | Notes                                                 |
| ------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------- |
| Slack thread identity normalization              | thread_ts, ts fallback, raw-field precedence, missing fields | `message-router.ts`, tests, Slack message docs      | Critical before queue key selection.                  |
| Message-kind classification and runtime dispatch | DM, subscribed, mention, skip                                | `message-router.ts`, `production.ts`, runtime tests | Overlaps with turn handling only at boundary.         |
| Queue handoff and skipped preservation           | rehydrate attachments, skipped messages, dispatcher kinds    | `thread-message-dispatcher.ts`, Slack runtime tests | Queue semantics belong here; turn behavior elsewhere. |
| Webhook background processing                    | waitUntil available/missing/failure                          | `JuniorChat` overrides                              | Avoids blocking webhook response.                     |
| Assistant lifecycle routing                      | started, context changed                                     | Slack docs, `JuniorChat`, runtime tests             | No normal answer generation.                          |
| Edited-message mention extraction                | newly added mention, duplicate edit, no mention              | `message-changed.ts`, tests, Slack docs             | Synthetic active turn.                                |
| External and bot-authored filtering              | external user, Junior/bot authored                           | `workspace-membership.ts`, runtime self guards      | Bot-authored runtime guard overlaps turn handling.    |
| Verification taxonomy                            | unit, integration, turn-handling boundary                    | `specs/testing.md`                                  | No eval layer here.                                   |

## Migration Notes

- Canonical spec updates:
  - Add `slack-ingress-routing` to the canonical spec index after acceptance.
  - Keep `chat-architecture.md` as architectural overview and link to this capability for Slack ingress details.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Do not move passive reply policy from `agent-turn-handling`.
- Test/eval taxonomy changes:
  - Rename/split ingress tests only after review; no evals expected.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-slack-ingress-routing' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: external-user filtering coverage, assistant lifecycle override coverage, direct-message/subscribed helper ownership, and Chat SDK payload reference consolidation.
