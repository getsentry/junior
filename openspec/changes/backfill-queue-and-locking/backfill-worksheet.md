# Backfill Worksheet: `queue-and-locking`

## Scope

- Capability: Queue and locking
- Change: `backfill-queue-and-locking`
- Owner: spec backfill program
- Status: draft
- Canonical target: `openspec/specs/queue-and-locking/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/chat-architecture.md`: queue/lock layer, data authority, and per-thread serialization.
- `specs/agent-session-resumability.md`: session continuation, timeout callback validation, and resume lock behavior.
- `specs/agent-turn-handling.md`: queued/skipped user input behavior at turn-policy level.
- `specs/slack-ingress-routing.md`: normalized thread id and dispatcher boundary.
- `specs/testing.md`: unit/integration/eval layer boundaries.

### Code Paths

- `packages/junior/src/chat/app/production.ts`: Chat SDK queue configuration and production handler registration.
- `packages/junior/src/chat/state/adapter.ts`: memory/Redis adapter selection, key prefixing, active lock heartbeat, lock release/extend behavior.
- `packages/junior/src/chat/queue/thread-message-dispatcher.ts`: queue dispatch and attachment fetcher rehydration.
- `packages/junior/src/chat/runtime/slack-runtime.ts`: skipped-message extraction and runtime entrypoint consumption.
- `packages/junior/src/chat/runtime/reply-executor.ts`: active continuation follow-up rescheduling.
- `packages/junior/src/chat/runtime/slack-resume.ts`: resume lock acquisition/release and lock-busy error.
- `packages/junior/src/handlers/turn-resume.ts`: lock-busy retry/reschedule callback behavior.
- `packages/junior/src/chat/services/timeout-resume.ts`: signed continuation request and scheduling.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/state/state-adapter-lock.test.ts`
  - `packages/junior/tests/unit/queue/thread-message-dispatcher.test.ts`
  - `packages/junior/tests/unit/slack/slack-runtime.test.ts`
  - `packages/junior/tests/unit/handlers/turn-resume.test.ts`
  - `packages/junior/tests/unit/runtime/timeout-resume.test.ts`
- Integration:
  - `packages/junior/tests/integration/slack/new-mention-behavior.test.ts`
  - `packages/junior/tests/integration/slack/message-content-behavior.test.ts`
  - `packages/junior/tests/integration/slack/bot-handlers.test.ts`
  - `packages/junior/tests/integration/turn-resume-slack.test.ts`
- Evals:
  - No direct evals needed; model behavior around queued/skipped context belongs to `agent-turn-handling`.

## Prior Art

- Chat SDK queue contract: per-thread `concurrency: "queue"` serializes handler execution and exposes skipped messages when multiple user messages arrive during one active handler.
- State adapters typically use leases/locks with TTL; Junior wraps those locks with heartbeat for long-running agent turns.
- Durable workflow recovery is intentionally not delegated to ephemeral queue entries; Junior reconstructs from persisted thread/session state.

## Implemented Behavior

- Behavior that code currently enforces:
  - Production Chat SDK uses `concurrency.strategy = "queue"`.
  - Queue entry TTL is `botConfig.turnTimeoutMs + 60_000`.
  - Queue dispatcher routes `new_mention` to `handleNewMention` and `subscribed_message` to `handleSubscribedMessage`.
  - Queue/deserialized attachment fetchers are rehydrated from Slack private URLs.
  - State adapter prefixes physical storage keys while returning unprefixed lock identifiers.
  - Active SDK-sized locks heartbeat every 30 seconds and stop on release/disconnect/force-release.
  - Active lock heartbeat stops after turn timeout plus active lock TTL.
  - Explicit long-TTL locks are not heartbeated by default.
  - Resume paths acquire the same logical thread lock and throw lock-busy errors when unavailable.
  - Timeout resume callback tests cover retry and reschedule on lock busy.
  - Live user follow-up can reschedule an awaiting timeout continuation instead of starting a second turn.
- Behavior that tests currently verify:
  - Active lock heartbeat keeps a lock alive past static TTL.
  - Heartbeat stops on release and after configured max age.
  - Long explicit TTL locks are not heartbeated.
  - Prefixed adapters keep caller-facing lock and queue identifiers unprefixed.
  - Queue dispatcher forwards subscribed messages.
  - Skipped messages reach runtime/prompt context.
  - Lock-busy timeout resume callbacks retry/reschedule.
- Behavior that appears accidental or weakly enforced:
  - Queue entry TTL margin is documented in code but not directly tested.
  - Dispatcher tests cover subscribed kind but may not explicitly cover mention kind or attachment rehydration.
  - Queue max-size/drop behavior is not specified.
  - Resume lock release before deferred side effects is important but not clearly isolated in tests.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Serialize live Slack handling per normalized thread.
  - Preserve skipped user input and attachments.
  - Keep active locks alive during expected long turns but bounded for recovery.
  - Use the same lock for resume and live handling.
  - Treat queue as coordination, not durable session history.
- Behavior that should remain implementation detail:
  - Exact heartbeat interval.
  - Exact lock token format.
  - Exact queue entry serialization format.
  - Exact lock-busy retry delays.
- Behavior that should be non-goal:
  - Generic durable workflow queues.
  - Provider credential leases.
  - Model reply/no-reply decisions.

## Undefined Behavior / Open Questions

| Question                                                | Evidence                                                                  | Options                                                                | Recommendation                                                              | Status |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| How normative is queue TTL margin?                      | Production sets turn timeout plus 60s.                                    | Exact margin, configurable threshold, or only "exceeds turn duration". | Specify exceeds max turn duration; keep exact margin implementation detail. | open   |
| What happens when queue max size is exceeded?           | Chat SDK adapter owns queue max behavior.                                 | Drop oldest, drop newest, fail webhook, or unspecified.                | Backfill after inspecting SDK adapter if product behavior needs it.         | open   |
| Should resume lock-busy policy be owned here?           | Session spec has retry/reschedule details.                                | Own here, own in session spec, or split.                               | Split: shared lock contract here; retry policy in session spec.             | open   |
| Should all dispatcher paths have focused unit coverage? | Existing dispatcher test only shows subscribed route in inspected output. | Add mention/rehydration tests, rely on integration, or leave.          | Add small unit tests later if absent.                                       | open   |
| Should heartbeat max age be configurable?               | Derived from turn timeout plus active TTL.                                | Keep derived, expose config, or fixed.                                 | Keep derived unless operational evidence says otherwise.                    | open   |

## OpenSpec Requirements Draft

| Requirement                            | Scenarios                                                     | Source Evidence                        | Notes                            |
| -------------------------------------- | ------------------------------------------------------------- | -------------------------------------- | -------------------------------- |
| Live thread queue configuration        | production queue, TTL, normalized id                          | `production.ts`, ingress spec          | Queue is live transport.         |
| Queued and skipped preservation        | skipped input, attachment rehydration, dispatcher kinds       | dispatcher/runtime tests               | Cross-link turn handling.        |
| State adapter key and lock prefixing   | prefix storage, lock ids, queue ids                           | `state-adapter-lock.test.ts`           | Pure adapter behavior.           |
| Active lock heartbeat                  | acquire, release, max age, long TTL                           | `adapter.ts`, lock tests               | Critical long-turn reliability.  |
| Resume lock coordination               | acquire same lock, busy, release before deferred side effects | `slack-resume.ts`, turn-resume tests   | Retry details in session spec.   |
| Active continuation follow-up handling | awaiting continuation, no continuation                        | `reply-executor.ts`, integration tests | Prevents duplicate active turns. |
| Verification taxonomy                  | unit, integration, session boundary                           | `testing.md`                           | No evals.                        |

## Migration Notes

- Canonical spec updates:
  - Add `queue-and-locking` to index after acceptance.
  - Keep durable session lifecycle in `agent-session-resumability`.
- Index/pointer updates:
  - Add to `specs/index.md` and root `AGENTS.md` known specs after acceptance.
- Superseded content:
  - Do not duplicate all queue rules in `chat-architecture`; link here.
- Test/eval taxonomy changes:
  - Split queue/skipped-message tests from broad Slack behavior suites only after review.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-queue-and-locking' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: queue TTL config test, dispatcher mention/rehydration unit coverage, queue max-size/drop policy, and resume lock release sequencing.
