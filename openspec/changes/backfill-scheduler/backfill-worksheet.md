# Backfill Worksheet: `scheduler`

## Scope

- Capability: Scheduler
- Change: `backfill-scheduler`
- Owner: spec backfill program
- Status: draft
- Canonical target: existing `specs/scheduler.md` plus `openspec/specs/scheduler/spec.md` after review

## Current-Source Inventory

### Existing Specs And Policies

- `specs/scheduler.md`: current prose scheduler contract.
- `specs/trusted-plugin-heartbeat.md`: heartbeat pulse and trusted plugin context.
- `specs/trusted-plugin-dispatch.md`: core dispatch API and runner.
- `specs/slack-agent-delivery.md`: Slack delivery behavior.
- `specs/agent-prompt.md`: prompt/context ownership.
- `specs/credential-injection.md`: credential subject behavior.
- `specs/testing.md`: verification layer ownership.

### Code Paths

- `packages/junior-scheduler/src/types.ts`: task/run/actor/destination/schedule types.
- `packages/junior-scheduler/src/cadence.ts`: ISO timestamp parsing, timezone parts, recurrence derivation, next-run calculation.
- `packages/junior-scheduler/src/store.ts`: durable plugin-state-backed task/run store, indexes, claims, missed-run policy, run transitions.
- `packages/junior-scheduler/src/schedule-tools.ts`: Slack schedule create/list/update/delete/run-now tools.
- `packages/junior-scheduler/src/plugin.ts`: trusted scheduler plugin tool registration and heartbeat dispatch flow.
- `packages/junior-scheduler/src/prompt.ts`: scheduled-run prompt framing.
- `packages/junior-scheduler/plugin.yaml`: packaged plugin declaration.

### Tests And Evals

- Integration:
  - `packages/junior/tests/integration/slack-schedule-tools.test.ts`
  - `packages/junior/tests/integration/heartbeat.test.ts`
- Unit:
  - `packages/junior/tests/unit/slack/tool-registration.test.ts`
  - `packages/junior/tests/unit/vercel.test.ts`
- Evals:
  - `packages/junior-evals/evals/core/scheduler.eval.ts`

## Prior Art

- Vercel Cron Jobs provide periodic trigger delivery, not per-user dynamic task storage or exact scheduled agent work.
- Slack `chat.scheduleMessage` can schedule fixed Slack messages, but it is not sufficient for Junior scheduled tasks because Junior runs agent work at execution time.
- RFC 5545 iCalendar defines broad recurrence semantics; Junior implements a deliberately smaller recurrence surface.

Sources:

- RFC 5545 iCalendar: https://www.rfc-editor.org/rfc/rfc5545
- Slack `chat.scheduleMessage`: https://api.slack.com/methods/chat.scheduleMessage
- Vercel Cron Jobs: https://vercel.com/docs/cron-jobs/

## Implemented Behavior

- Behavior that code currently enforces:
  - Task records include creator, destination, schedule, timezone, status, task text, execution actor, optional conversation access, optional credential subject, next run, run-now timestamp, and recurrence.
  - `next_run_at` must be exact ISO timestamp; natural-language times are rejected at tool boundary.
  - Default timezone is `JUNIOR_TIMEZONE` or `America/Los_Angeles`.
  - Recurrence supports daily/weekly/monthly/yearly and rejects other frequencies.
  - Weekly recurrence defaults to first run weekday; monthly/yearly use exact day-of-month and skip unsupported dates.
  - Tools derive destination from active Slack context, normalize `slack:<channel>:<ts>` ids, and ignore existing thread timestamps for destination storage.
  - DM tasks store private direct conversation access and user credential subject; groups/channels do not.
  - Any requester in the same active destination can manage task ids from that destination; other destinations are rejected.
  - Run-now stores a separate immediate timestamp and requires the task to already be active.
  - Store indexes tasks globally and by team, suppresses duplicate claims, prevents overlapping task runs, and skips stale missed occurrences.
  - Scheduler heartbeat reconciles incomplete dispatches, claims bounded due work, builds prompts, dispatches agent work, and marks prompt/dispatch failures blocked.
  - Scheduled-run prompt uses marker-delimited blocks and system-actor rules.
- Behavior that tests currently verify:
  - Creation/listing destination scope, clear immediate creation without confirmation, invalid Slack context, one-off reminders, invalid timestamps, sub-daily recurrence rejection, edits/deletes, cross-destination rejection, same-destination management by another requester, credential subject DM exception, private group no delegation, default timezone, invalid timezone, run-now, idempotent due claims.
  - Heartbeat dispatch/reconcile, credential subject persistence, missing dispatch failure, malformed prompt blocked, invalid dispatch blocked, stale recurring skip/advance, duplicate stale task skip.
  - Evals for simple one-off reminder creation and clear recurring creation.
- Behavior that appears accidental or weakly enforced:
  - Recurrence helper edge cases lack direct unit tests.
  - Conversation access is inferred from Slack id prefixes rather than API metadata.
  - Blocked-run private notification is specified in prose but not implemented in inspected code.
  - Scheduled-run execution framing has fewer evals than schedule creation.
  - Management authorization is broad by design but may need product review.

## Intended Behavior

- Product/runtime behavior that should be normative:
  - Scheduled tasks are normalized execution contracts.
  - Tools only manage the active Slack destination.
  - Heartbeat dispatches bounded due work; it does not execute inline.
  - Scheduled runs execute as system actor runs.
  - User credential delegation requires explicit private-DM credential subject.
  - Old missed work is skipped, not backfilled unboundedly.
- Behavior that should remain implementation detail:
  - Exact task id UUID format.
  - Exact stale-claim and missed-run durations.
  - Exact storage key strings.
  - Exact eval wording.
- Behavior that should be non-goal:
  - Arbitrary cron syntax.
  - Sub-daily recurring schedules.
  - Slack scheduled message API as execution engine.
  - Event/webhook-driven scheduler.

## Undefined Behavior / Open Questions

| Question                                               | Evidence                                                                            | Options                                                            | Recommendation                                                                  | Status |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------ |
| Should conversation privacy be fetched from Slack API? | Current code infers from `D/G/C` prefixes and leaves `C` visibility unknown.        | Prefix inference, Slack API lookup, or fail closed for all non-DM. | Keep prefix inference for V1; consider API lookup if credential policy expands. | open   |
| Should blocked runs notify creators privately?         | Prose mentions notification; inspected code marks blocked but no notification path. | Implement notification, omit, or separate notification spec.       | Track as follow-up before promising UX.                                         | open   |
| Should management authorization be stricter?           | Spec allows same-destination participants.                                          | Keep broad, creator-only, admin-only, or app-configurable.         | Keep V1 broad unless users report misuse.                                       | open   |
| Do recurrence helpers need dedicated tests?            | Edge behavior implemented but mostly tested through tools.                          | Add unit tests or rely on integration.                             | Add unit tests for DST/calendar edge cases.                                     | open   |
| How should scheduled-run execution be evaled?          | Existing evals focus schedule creation.                                             | Add execution eval, integration-only, or prompt snapshot.          | Add eval for executing stored task rather than scheduling.                      | open   |

## OpenSpec Requirements Draft

| Requirement                     | Scenarios                                                      | Source Evidence                | Notes                         |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------ | ----------------------------- |
| Scheduled task data model       | create, creator, original request, delete                      | types/tools/tests              | Contract not raw utterance.   |
| Scheduled run data model        | claim, dispatch, terminal                                      | store/heartbeat tests          | At-least-once trigger.        |
| Calendar schedule model         | ISO, natural-language reject, timezone                         | cadence/tools tests            | Agent interprets NL.          |
| Calendar recurrence model       | one-off, supported, weekly, unsupported dates, sub-daily, null | cadence/tools tests            | RFC 5545 subset.              |
| Tool availability               | complete context, no requester, no destination                 | plugin/tool-registration tests | Trusted plugin tools.         |
| Task creation                   | one-off, recurring, thread, other destinations                 | schedule tool tests/evals      | Active destination.           |
| Conversation access/credentials | DM, group, channel, dispatch credential                        | schedule/heartbeat tests       | Auth boundary.                |
| Destination-scoped management   | list, same, different, resume                                  | schedule tool tests            | Broad V1 policy.              |
| Run-now                         | active, paused, claim order                                    | schedule tool/store tests      | Separate timestamp.           |
| Storage/indexes                 | save, team, delete, active run                                 | store/tests                    | Plugin state.                 |
| Run idempotency                 | duplicate, stale pending, active marker                        | store tests                    | Best-effort exactly once.     |
| Missed run policy               | one-off, recurring, run-now, duplicate stale                   | heartbeat/store tests          | No unbounded catch-up.        |
| Heartbeat flow                  | reconcile, missing, due, prompt fail, dispatch fail, limit     | heartbeat tests                | Dispatch spec adjacent.       |
| Prompt framing                  | markers, empty text, actor facts, execute now                  | prompt/code/evals gap          | Execution eval gap.           |
| Actor/auth model                | system actor, no implicit creator tokens, auth block           | dispatch/heartbeat tests       | Credential subject exception. |
| Slack UX/evals                  | one-off, recurring, ambiguous, execution                       | evals                          | Need more taxonomy.           |
| Verification taxonomy           | deterministic, heartbeat, NL                                   | testing spec                   | Layer map.                    |

## Migration Notes

- Canonical spec updates:
  - Consolidate `specs/scheduler.md` with this OpenSpec capability after review.
  - Keep trusted dispatch/heartbeat mechanics in their own capabilities.
- Index/pointer updates:
  - Existing `specs/index.md` and root `AGENTS.md` already list scheduler prose; add OpenSpec pointer after acceptance.
- Superseded content:
  - Move dispatch callback details to `trusted-plugin-dispatch`.
  - Move cron endpoint auth details to `trusted-plugin-heartbeat`.
- Test/eval taxonomy changes:
  - Add recurrence unit tests.
  - Add scheduled-run execution evals.
  - Keep Slack tool/store behavior in integration tests.

## Validation Notes

- `openspec validate`: passed with `Change 'backfill-scheduler' is valid`.
- Targeted tests/evals: intentionally not run for this spec-only backfill; current tests/evals were inventoried but not changed.
- Deferred verification: Slack privacy lookup, blocked creator notification, management auth policy, recurrence edge tests, scheduled-run execution evals.
