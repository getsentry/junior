# Scheduler Spec

## Metadata

- Created: 2026-05-18
- Last Edited: 2026-05-18

## Changelog

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
- Verification layer ownership.

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
- creator/requester identity
- destination surface
- schedule and timezone
- current status
- next-run timestamp when active
- recurrence rule when recurring
- optional constraints and source context

The original user utterance may be retained for audit/debugging, but it must not be the sole execution input.

### Calendar Model

Every active task must have an exact `nextRunAtMs` instant. For one-off tasks, that instant is the complete schedule.

Recurring tasks must also store a small calendar recurrence rule:

- frequency: `daily`, `weekly`, `monthly`, or `yearly`
- positive interval
- local start date
- local time
- timezone
- optional weekly weekdays
- optional monthly/yearly exact day-of-month and month

V1 recurrence is calendar-based, not fixed-duration. For example, "every Monday at 9am America/Los_Angeles" should continue to run at 9am local time across daylight-saving changes. Monthly and yearly recurrences use exact calendar dates; unsupported dates are skipped rather than converted into "last day" or "business day" behavior.

The scheduler does not need advanced rules such as first business day, nearest weekday, holiday calendars, or arbitrary cron syntax.

### Prompt Framing

Every scheduled run must compile the stored task into a marker-delimited prompt before entering the agent runtime.

The prompt must make these facts explicit:

1. This is an autonomous scheduled run.
2. This is not a request to create, update, pause, delete, or list schedules.
3. The task contract is the source of truth for what to execute.
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
- `junior:scheduler:claim:{task_id}:{scheduled_for_ms}` is the idempotency claim.

A future Redis-native store may replace the scan index with a sorted due index without changing the runtime-facing scheduler store interface.

### Run Idempotency

Scheduled execution is at-least-once at the trigger layer and exactly-once-best-effort at Junior's run layer.

Rules:

1. A run idempotency key is `task_id:scheduled_for_ms`.
2. The scheduler must claim that key before dispatch.
3. Duplicate ticks, retries, and overlapping invocations must return the existing run or skip dispatch.
4. Run side effects must be keyed by the scheduled run id where possible.
5. A task must not overlap with itself by default. If one run is active, a later due time should be skipped, coalesced, or blocked according to the task policy.

### Auth Principal

Scheduled runs execute as the task creator unless the task contract explicitly names a different supported service principal.

Requester-bound provider credentials, OAuth state, sandbox egress, and audit metadata must use the scheduled task principal. If that principal lacks valid credentials, Junior must block the run and privately notify the creator when possible. Authorization links must not be posted publicly.

### Slack UX

Slack authoring should be confirm-first:

1. User asks Junior to schedule work.
2. Junior drafts the normalized task: title, cadence, timezone, destination, objective, expected output, and next run.
3. User confirms before the task becomes active.
4. Junior supports list, pause, resume, delete, and run-now commands.

Confirmation should show the executable task contract, not only echo the user's text.

## Failure Model

1. Tick delivery fails: the task remains due and a later tick may claim it.
2. Duplicate tick delivery: the run claim suppresses duplicate dispatch.
3. Run fails after claim: run record captures failure and retry policy decides whether to re-dispatch.
4. Task credentials are missing: mark the run blocked and keep or pause the task according to policy.
5. Prompt framing is ambiguous: evals must catch cases where the model creates/edits a schedule instead of executing the task.

## Observability

Scheduler execution should emit safe task/run metadata only:

- task id
- run id
- scheduled timestamp
- task status
- run status
- destination platform and channel id
- requester Slack user id

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
- blocked auth path
- dispatch to Slack delivery
- pause/delete/list management surfaces

Use unit tests only for small deterministic helpers when integration or eval coverage would be wasteful.

## Related Specs

- `./chat-architecture-spec.md`
- `./agent-prompt-spec.md`
- `./agent-session-resumability-spec.md`
- `./slack-agent-delivery-spec.md`
- `./testing/index.md`
