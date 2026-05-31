# Backfill Worksheet: `trusted-plugin-dispatch`

## Scope

- Capability: Trusted plugin dispatch
- Change: `backfill-trusted-plugin-dispatch`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/trusted-plugin-dispatch.md` plus `openspec/specs/trusted-plugin-dispatch/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/trusted-plugin-dispatch.md`: current prose dispatch contract.
- `specs/trusted-plugin-heartbeat.md`: heartbeat auth/invocation and recovery placement.
- `specs/scheduler.md`: scheduler plugin domain semantics.
- `specs/agent-session-resumability.md`: turn timeout/resume records.
- `specs/slack-agent-delivery.md`: Slack reply delivery and state persistence.
- `specs/credential-injection.md`: delegated credential subject behavior.
- `specs/security-policy.md`: callback signing, secrets, and prompt/input secrecy.
- `specs/testing.md`: verification layer ownership.

### Code Paths

- `packages/junior-plugin-api/src/index.ts`: trusted plugin `DispatchOptions`, `DispatchResult`, `Dispatch`, and heartbeat context API.
- `packages/junior/src/chat/agent-dispatch/types.ts`: internal record/projection/callback types.
- `packages/junior/src/chat/agent-dispatch/validation.ts`: plugin-provided option validation and limits.
- `packages/junior/src/chat/agent-dispatch/store.ts`: deterministic ids, records, locks, incomplete index, projection.
- `packages/junior/src/chat/agent-dispatch/context.ts`: heartbeat context, fanout limit, create/get API, callback scheduling.
- `packages/junior/src/chat/agent-dispatch/signing.ts`: HMAC-signed internal callback scheduling and verification.
- `packages/junior/src/chat/agent-dispatch/heartbeat.ts`: stale dispatch recovery and trusted plugin heartbeat invocation.
- `packages/junior/src/chat/agent-dispatch/runner.ts`: slice claim, system actor context, agent call, Slack delivery, continuation, blocked/failed/completed status.
- `packages/junior/src/handlers/agent-dispatch.ts`: internal callback route.
- `packages/junior/src/app.ts`: route registration.

### Tests And Evals

- Unit:
  - `packages/junior/tests/unit/runtime/agent-dispatch-validation.test.ts`
  - `packages/junior/tests/unit/runtime/agent-dispatch-signing.test.ts`
- Integration:
  - `packages/junior/tests/integration/agent-dispatch-runner.test.ts`
  - `packages/junior/tests/integration/heartbeat.test.ts`
- Evals:
  - Scheduler/provider workflows may cover user-visible scheduled output, but not dispatch mechanics directly.

## Prior Art

- Durable queue systems commonly provide at-least-once execution and require idempotent handlers or idempotency keys for externally visible effects.
- HMAC-signed webhook/callback systems use a shared secret, timestamp window, versioned signature, and constant-time comparison to authenticate internal callback requests and reduce replay risk.
- Slack message delivery is channel/conversation-id based; bot delivery succeeds only when the bot can post to the destination conversation.

Sources:

- Vercel Queues docs: https://vercel.com/docs/queues
- Slack `chat.postMessage` docs: https://docs.slack.dev/reference/methods/chat.postMessage

## Implemented Behavior

- Behavior that code currently enforces:
  - Dispatch API exists only inside heartbeat context.
  - Validation checks idempotency key, Slack platform/team/channel ids, input length, metadata bounds, and delegated credential subject constraints.
  - Invalid dispatch requests do not count against heartbeat fanout.
  - Dispatch ids are deterministic from plugin name plus idempotency key.
  - Records are persisted with system actor, destination, input, optional credential subject/metadata, attempts, max attempts, version, timestamps, and status.
  - Incomplete records are indexed for recovery; terminal records are removed from the index.
  - Plugin lookup is scoped by plugin and returns a projection only.
  - Callback scheduling requires base URL and `JUNIOR_SECRET`, signs body with HMAC-SHA256, and rejects non-2xx callback responses.
  - Callback verification checks timestamp, signature, secret, JSON body, and payload shape; invalid requests return 401.
  - Recovery re-drives stale pending/running/awaiting-resume records and fails expired or over-attempt stale records.
  - Runner claims by dispatch lock and expected version, then acquires destination conversation lock.
  - Busy destination returns dispatch to pending without burning an attempt.
  - Runner calls `generateAssistantReply` with system actor correlation, no requester, disabled auth flow, persisted state, channel config, stable dispatch turn id, and optional credential subject.
  - Runner persists stable synthetic user/assistant messages and dispatch completion timestamp.
  - Existing persisted assistant reply suppresses duplicate Slack posting.
  - Timeout resume uses dispatch callback scheduling.
  - Auth-required outcomes are marked blocked.
- Behavior that tests currently verify:
  - Validation of valid dispatch, max idempotency/metadata, delegated credential DM restriction.
  - Callback signing and invalid signature rejection.
  - Plugin-scoped lookup and hidden fields by projection shape.
  - Fanout limit and invalid dispatch not counting.
  - Retry exhaustion, terminal index cleanup, active leased max-attempt handling.
  - Scheduler dispatch/reconcile, credential subject persistence, missing dispatch failure, malformed/invalid scheduler runs.
  - Runner system context, Slack delivery persistence, timeout continuation, delegated credential subject context, and busy conversation behavior.
- Behavior that appears accidental or weakly enforced:
  - Destination postability is not preflighted before callback scheduling.
  - Callback handler `waitUntil` behavior is mostly covered indirectly.
  - Auth-blocking branches in runner are not strongly covered by direct tests.
  - Delivery duplicate suppression cannot cover the Slack-accepted/state-persist-failed window.
  - Retention/expiration behavior is inherited from thread state TTL and not product-shaped.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Dispatch is core-owned after plugin creation.
  - Same plugin/idempotency key creates at most one record.
  - Plugins only see projections of records they own.
  - Dispatch callbacks are signed and versioned.
  - Dispatch runner is a system actor with disabled interactive auth.
  - Delegated credential subjects are constrained to private direct conversations.
  - Delivery is best-effort exactly once under at-least-once callback delivery.
  - Recovery is bounded and durable-state-driven.
- Behavior that should remain implementation detail:
  - Exact max lengths, max attempts, lease duration, and recovery limits.
  - Exact HMAC context string/header names unless public compatibility is needed.
  - Exact synthetic prompt prefix text.
  - Exact Slack footer formatting.
- Behavior that should be non-goal:
  - Scheduler task recurrence policy.
  - User-facing slash commands for dispatch.
  - Plugin-owned callback routes.
  - Exactly-once distributed delivery guarantees.

## Undefined Behavior / Open Questions

| Question                                                     | Evidence                                                                     | Options                                                                      | Recommendation                                                    | Status |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------ |
| Should dispatch use Vercel Queues instead of self-callbacks? | Current code uses signed fetch to internal route.                            | Keep self-callback, migrate to queues, or adapter.                           | Keep invariant-focused spec; decide implementation separately.    | open   |
| Should destination postability be preflighted?               | Validation checks id shape, not Slack access.                                | Preflight, let runner fail, or preflight only scheduler UI.                  | Let runner fail unless UX needs earlier feedback.                 | open   |
| Should auth-blocking branches have direct tests?             | Runner code handles auth errors; inspected tests cover surrounding behavior. | Add direct runner tests or rely on provider flows.                           | Add focused integration tests.                                    | open   |
| What is plugin-visible lookup after TTL expiry?              | Store uses `THREAD_STATE_TTL_MS`.                                            | Undefined, return missing, or terminal history store.                        | Specify `undefined` after retention unless product needs history. | open   |
| How should duplicate Slack post window be handled?           | Slack post/state commit not atomic.                                          | Accept best-effort, use Slack client msg id if possible, or delivery ledger. | Keep best-effort for baseline; investigate client ids.            | open   |

## OpenSpec Requirements Draft

| Requirement                             | Scenarios                                         | Source Evidence         | Notes                         |
| --------------------------------------- | ------------------------------------------------- | ----------------------- | ----------------------------- |
| Plugin-facing dispatch API              | create, duplicate, get own, get other             | context/store/tests     | Heartbeat only.               |
| Dispatch option validation              | key, destination, input, metadata                 | validation tests        | Constants detail.             |
| Delegated credential subject validation | valid DM, channel fail, malformed                 | validation/runner tests | User credential exception.    |
| Durable dispatch record creation        | new, existing, incomplete index, terminal cleanup | store/tests             | Core state separate.          |
| Dispatch projection privacy             | projection, hidden fields                         | store/heartbeat tests   | Plugin scoped.                |
| Internal callback signing               | schedule, missing config, invalid, handler        | signing tests/handler   | Handler gap.                  |
| Heartbeat recovery                      | pending/running/resume, max age/attempt, terminal | heartbeat tests/code    | Recovery before plugin hooks. |
| Dispatch claim and locking              | claim, stale, busy, attempt                       | runner tests/code       | Lock order invariant.         |
| System actor runner context             | agent context, synthetic user, credential subject | runner tests            | Auth disabled.                |
| Slack delivery idempotency              | persisted duplicate, reply, files, failure        | runner tests/code       | Duplicate window open.        |
| Timeout continuation                    | timeout, next callback                            | runner tests            | Dispatch path only.           |
| Authorization blocking                  | auth required, plugin credential failure          | runner code             | Direct tests gap.             |
| Limits                                  | fanout, invalid not counted, recovery limit       | heartbeat tests/code    | Exact values impl detail.     |
| Verification taxonomy                   | unit, integration, scheduler                      | testing spec            | Layer map.                    |

## Migration Notes

- Canonical spec updates:
  - Consolidate `specs/trusted-plugin-dispatch.md` with this OpenSpec capability after review.
  - Keep generic `agent-dispatch` implementation spec separate only if non-plugin dispatch emerges.
- Index/pointer updates:
  - Existing `specs/index.md` and root `AGENTS.md` already list trusted plugin dispatch; add OpenSpec pointer after acceptance.
- Superseded content:
  - Move scheduler domain behavior to `scheduler`.
  - Move heartbeat auth/invocation behavior to `trusted-plugin-heartbeat`.
  - Move credential lease behavior to `credential-injection`/`plugin-auth`.
- Test/eval taxonomy changes:
  - Keep validation/signing in unit tests.
  - Keep runner/recovery/scheduler reconciliation in integration tests.
  - Avoid evals for callback mechanics.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-trusted-plugin-dispatch' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests were inventoried but not changed.
- Deferred verification: callback handler direct tests, auth-blocking runner tests, destination postability policy, TTL lookup behavior, duplicate Slack post window.
