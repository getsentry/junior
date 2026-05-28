# Scheduler Spec

## Metadata

- Created: 2026-05-18
- Last Edited: 2026-05-27

## Changelog

- 2026-05-27: Added stale missed-run policy: old occurrences are skipped and consumed or advanced, not dispatched late and not blocked for human review.
- 2026-05-27: Added the recurring schedule frequency limit: at most once per day.
- 2026-05-27: Changed Slack authoring to auto-create clear scheduled work and reserve confirmation for ambiguous requests.
- 2026-05-26: Reframed scheduled execution around system actors: creator is metadata/contact, scheduled runs execute as a system actor, and user-bound auth must not be borrowed implicitly.
- 2026-05-18: Clarified V1 calendar model: exact next-run instants plus simple daily/weekly/monthly/yearly recurrence rules.
- 2026-05-18: Initial draft contract for scheduled Junior tasks, prompt framing, no-SQL storage, run idempotency, and eval-first verification.

## Status

Draft

## Purpose

Define the first scheduler contract for Junior: users can create durable tasks that Junior executes later or repeatedly, with explicit task framing and delivery back to the configured surface.

## Scope

- Scheduled task and scheduled run data model.
- Prompt envelope used when executing a scheduled task.
- Storage and idempotency rules.
- Slack authoring and management behavior.
- Verification layer responsibilities.

## Non-Goals

- A generic event-rule engine for GitHub, Slack, Sentry, or webhook events.
- SQL-backed storage as a V1 requirement.
- A full durable workflow runtime such as Temporal or Vercel Workflow.
- Reusing timeout-resume callbacks as the product scheduler.
- Slack `chat.scheduleMessage` as the execution mechanism.

## Contracts

### Product Boundary

A scheduled task is not a stored Slack message. It is a normalized task contract that Junior executes on a time trigger.

The stored task must include:

- task title
- objective
- instructions
- expected output
- creator metadata
- execution actor metadata
- destination surface
- schedule and timezone
- current status
- next-run timestamp when active
- recurrence rule when recurring
- optional constraints and source context

The original user utterance may be retained for audit/debugging, but it must not be the sole execution input.

Slack destinations are conversations, not existing threads. A scheduled task may target the active Slack DM or channel, and scheduled output posts as a new message in that conversation.

Creator metadata records the user who confirmed the task so Junior can audit changes and privately notify someone when the task needs attention. The creator is not an owner, is not an authorization principal, and is not the actor for future scheduled runs.

Task management is controlled only by access to the destination conversation window. If a user can post or trigger Junior in that Slack DM or channel context, they can manage scheduled tasks for that same context. The scheduler must not add creator-only, owner-only, workspace-admin-only, or channel-admin-only gates for V1 management.

### Calendar Model

Every active task must have an exact `nextRunAtMs` instant. For one-off tasks, that instant is the complete schedule.
Slack authoring may accept supported relative one-off phrases such as "tomorrow at 9am"; these must be resolved to an exact `nextRunAtMs` before storage. When a user does not provide a timezone, scheduler authoring defaults to `America/Los_Angeles` unless `JUNIOR_TIMEZONE` overrides it.

Recurring tasks must also store a small calendar recurrence rule:

- frequency: `daily`, `weekly`, `monthly`, or `yearly`
- positive interval
- local start date
- local time
- timezone
- optional weekly weekdays
- optional monthly/yearly exact day-of-month and month

V1 recurrence is calendar-based, not fixed-duration. For example, "every Monday at 9am America/Los_Angeles" should continue to run at 9am local time across daylight-saving changes. Monthly and yearly recurrences use exact calendar dates; unsupported dates are skipped rather than converted into "last day" or "business day" behavior.

Recurring tasks must not run more than once per day. Slack authoring must reject hourly, twice-daily, or other sub-daily recurring schedules instead of storing a task contract that cannot execute as requested.

The scheduler does not need advanced rules such as first business day, nearest weekday, holiday calendars, or arbitrary cron syntax.

Run-now has a separate contract:

1. Run-now applies only to active tasks.
2. Run-now must not implicitly resume paused or blocked tasks.
3. Run-now must not rewrite the task's stored calendar schedule.
4. A task may store a separate immediate-run timestamp.
5. When both the immediate-run timestamp and ordinary `nextRunAtMs` are due, the scheduler claims the immediate run first.
6. After the manual run reaches a terminal state, clear the immediate-run timestamp.
7. If the ordinary `nextRunAtMs` was already overdue when the manual run completed, consume that scheduled occurrence and advance recurrence once instead of running the same task twice in one tick.

### Missed Run Policy

The scheduler must not execute arbitrarily old work just because heartbeat delivery or dispatch recovery was broken. At claim time, any scheduled occurrence more than 24 hours older than the scheduler's current clock is stale.

Stale occurrences are terminal skipped runs:

1. The scheduler records a run for the missed `task_id:scheduled_for_ms` with `status: skipped`.
2. The scheduler must not dispatch the agent for that occurrence.
3. A skipped stale occurrence does not update `lastRunAtMs`, because no task execution happened.
4. A one-off stale occurrence is consumed: the task becomes `paused` with no `nextRunAtMs`.
5. A recurring stale occurrence is consumed and the task advances directly to the next future recurrence. The scheduler must not run catch-up loops for every missed recurrence.
6. A stale run-now request is cleared without shifting the stored ordinary schedule.
7. During stale recovery, an equivalent newer active task in the same destination should be skipped and paused when an older active task with the same schedule and task contract remains canonical.
8. Staleness is not a blocked or missing-input state and must not require human review. A user can still run the task manually if the missed work is still useful.

### Prompt Framing

Every scheduled run must compile the stored task into a marker-delimited prompt before entering the agent runtime.

The prompt must make these facts explicit:

1. This is an autonomous scheduled run.
2. The task contract is the source of truth for what to execute.
3. The run executes as a Junior system actor, not as the user who created the task.
4. The run should complete without asking follow-up questions unless access, approval, or required input is missing.
5. If blocked, the result should identify the missing provider, permission, or input.

The compiled prompt must separate descriptive task facts from directives. Use marker blocks such as:

- `<scheduled-task-run>`
- `<scheduled-task>`
- `<run-context>`
- `<execution-rules>`
- `<current-instruction priority="highest">`

This follows the router and turn-context pattern: background and state live in descriptive blocks, while behavior rules live in a rules block and the actual ask appears last.

### Storage

V1 must not require SQL. The scheduler store should use the existing durable state dependency already required by Junior deployments.

The initial implementation may use the Chat SDK state adapter and a global task index:

- `junior:scheduler:task:{task_id}` stores the task record.
- `junior:scheduler:tasks` stores task ids for due scans.
- `junior:scheduler:team:{team_id}:tasks` stores task ids for workspace management.
- `junior:scheduler:run:{run_id}` stores run history.
- `junior:scheduler:active:{task_id}` stores the currently active run marker for task-level overlap prevention.
- `junior:scheduler:claim:{task_id}:{scheduled_for_ms}` is the idempotency claim.

A future Redis-native store may replace the scan index with a sorted due index without changing the runtime-facing scheduler store interface.

### Run Idempotency

Scheduled execution is at-least-once at the trigger layer and exactly-once-best-effort at Junior's run layer.

Rules:

1. A run idempotency key is `task_id:scheduled_for_ms`.
2. The scheduler must claim that key before dispatch.
3. Duplicate ticks and retries must not dispatch the same scheduled run more than once.
4. Run side effects must be keyed by the scheduled run id where possible.
5. V1 tasks do not overlap with themselves. If a task already has an active run, later due claims for that same task are not dispatched.
6. Stale pending claims may be reclaimed after the scheduler's stale-claim timeout.

### Actor And Auth Model

Scheduled tasks must distinguish these V1 identities:

- **Creator:** the human who confirmed the task. This is audit and notification metadata only.
- **Conversation manager:** any user who can post or trigger Junior in the destination Slack conversation window. This controls who may list, pause, resume, delete, or run-now the task for that same conversation.
- **Execution actor:** the actor used for the autonomous scheduled run. For scheduled tasks, this is a Junior system actor, not a Slack user.

Scheduled runs must not pass the creator as the runtime requester or treat the creator as if they were present and acting during the run. Audit and correlation metadata should include both the system execution actor and creator metadata, but auth decisions must use the execution actor.

V1 scheduled execution has no user requester. User OAuth tokens cannot be used merely because that user created the task. Authorization flows are disabled during scheduled runs, and authorization links must not be posted publicly. If no usable non-user credential exists, Junior must block the run and privately notify the creator when possible.

Future actor-aware auth may add an explicit credential subject: an account, grant, or service principal whose provider credentials may be used by scheduled tools. Future credential subjects may include:

- system-owned credentials available to the scheduled-run actor
- an explicitly recorded delegated credential grant in the task contract
- a supported service principal named by the task contract

Those future credential subjects must be explicit and separate from creator metadata. Until that support exists, scheduled runs may use only credentials already available to the system execution actor.

### Implementation Plan

1. Introduce a small actor contract shared by runtime, scheduler, and auth boundaries. It should represent user actors, system actors, and future service actors without leaking Slack SDK types.
2. Keep `createdBy` as creator metadata and add an execution actor field to scheduled tasks. New scheduled tasks should default to a system actor such as `scheduled-task`; existing tasks may be read with that default until migrated.
3. Update the scheduled runner to enter the agent runtime with the system actor and no user requester. Creator details may remain in run context and notification metadata, but not in the actor slot.
4. Update auth and credential resolution so V1 scheduled runs cannot use requester-scoped OAuth or start interactive auth flows. Missing non-user credentials should produce a blocked run plus private notification.
5. Update telemetry, tests, and eval fixtures so scheduled execution assertions refer to creator metadata and execution actor separately.

### Slack UX

Slack authoring creates clear scheduled-work requests immediately for the active destination:

1. User asks Junior to schedule work.
2. Junior normalizes the task: title, objective, instructions, expected output, cadence, timezone, destination, and next run.
3. If the task contract, schedule, and active destination are clear, Junior creates the task immediately.
4. If the task contract, schedule, or active destination is ambiguous, Junior asks for confirmation or clarification before creating the task.
5. Junior replies with the task id, destination, schedule, timezone, and next run after creation.
6. Junior supports list, pause, resume, delete, and run-now commands from the destination conversation.

Confirmation should show the executable task contract, not only echo the user's text.
Anyone who can post or trigger Junior in the destination Slack conversation window may manage that conversation's scheduled tasks. Creator identity remains audit and notification metadata, but it is not an edit/delete/run-now ownership gate and is not the execution actor.
Task creation must use the current active Slack conversation as the destination. Users cannot create scheduled tasks for a different channel, and cannot create DMs for other users.
List output must be scoped to the active destination conversation and must not reveal tasks from other channels or DMs in the same workspace.
Blocked tasks must appear in list output with their blocked reason. After the missing requirement is fixed, a conversation manager can resume the task or run it now from the same destination conversation.

## Failure Model

1. Tick delivery fails: the task remains due and a later tick may claim it.
2. Duplicate tick delivery: the run claim suppresses duplicate dispatch.
3. Run fails after claim: run record captures failure and retry policy decides whether to re-dispatch.
4. Required non-user credentials are missing: mark the run blocked, keep or pause the task according to policy, and privately notify the creator when possible.
5. A task remains due for more than 24 hours: mark that occurrence skipped, then consume or advance the task according to the missed-run policy.
6. Prompt framing is ambiguous: evals must catch cases where the model creates/edits a schedule instead of executing the task.

## Observability

Scheduler execution should emit safe task/run metadata only:

- task id
- run id
- scheduled timestamp
- task status
- run status
- destination platform and channel id
- execution actor type and id
- creator Slack user id, when available

Logs and spans must not include OAuth tokens, provider credentials, raw authorization URLs, or private tool payloads.

## Verification

Use evals for model-dependent behavior:

- natural-language schedule extraction
- task framing quality
- confirmation quality
- scheduled-run execution behavior
- not confusing scheduled execution with schedule creation

Use integration tests for runtime/storage contracts that do not depend on model interpretation:

- due claim idempotency
- stale one-off, recurring, and run-now occurrences skip without dispatch
- stale recovery dedupes equivalent active tasks in the same destination
- blocked auth path for missing non-user credentials
- scheduled runner passes a system actor rather than the creator as requester
- user OAuth tokens are not used implicitly for scheduled tasks
- dispatch to Slack delivery
- destination-scoped list output
- conversation-access management for pause, resume, delete, and run-now

Use unit tests only for small deterministic helpers when integration or eval coverage would be wasteful.

## Related Specs

- `./chat-architecture-spec.md`
- `./agent-prompt-spec.md`
- `./agent-session-resumability-spec.md`
- `./slack-agent-delivery-spec.md`
- `./testing/index.md`
