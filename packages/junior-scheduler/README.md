# @sentry/junior-scheduler

The scheduler plugin stores user-created schedules and dispatches due work into
Junior's durable agent runtime.

## Task Model

- A scheduled task records its creator, execution actor, Slack destination,
  prompt text, timezone-aware schedule, recurrence, credential mode, status, and
  next-run state.
- SQL schemas and migrations are authoritative for persistence.
- Model-facing tools accept structured schedule intent. The scheduler resolves
  relative delays and calendar fields against its server clock and timezone,
  computes `nextRunAtMs`, and stores the canonical schedule. Execution does not
  reinterpret the original natural-language request.
- Relative delays are elapsed durations. Calendar schedules use local wall-clock
  time: nonexistent recurring times are skipped, nonexistent one-off times are
  rejected, and repeated times use their first instant.
- Multi-week recurrences use Monday-based calendar weeks; `startDate` is the
  lower bound and its containing week is the first active week.
- Create tool-call identities produce stable task ids so retrying one committed
  tool invocation returns the existing task instead of duplicating it.
- Updates and deletion invalidate obsolete pending run times.

## Dispatch

- Heartbeat claims a bounded number of due runs.
- Claiming and completion transitions are atomic and safe to retry.
- Each run dispatches with explicit source, destination, creator attribution,
  execution actor, metadata, and idempotency identity.
- A deleted, paused, or rescheduled task is skipped when its claimed run no
  longer matches current task state.
- Dispatch completion, failure, or blocking updates both the run and the task's
  next-run state.
- Missed recurring work advances according to the stored calendar rather than
  creating an unbounded catch-up burst.

## Authority

- Creation requires the active Slack actor and destination.
- Tasks use system credentials by default. Creator credentials require explicit
  authorization from the verified task creator and work in DMs or channels.
- Only the creator may enable or re-enable creator credential mode. Any
  conversation manager may disable it, and another user's executable task edit
  clears it; schedule, status, and run-now changes preserve it.
- Scheduled execution remains a system actor. At dispatch, creator mode derives
  a user credential subject bound to the exact scheduler task; interactive OAuth
  remains disabled.
- Stored creator attribution grants no broader task-management or execution
  authority.
- Slack tool management remains scoped to the active Slack context. The
  dashboard may list and delete a viewer's own tasks across linked Slack
  workspaces.

## Operations

The plugin exposes create, update, delete, list, and run-now tools plus bounded
operational reporting. The dashboard exposes a searchable **Scheduled tasks**
user page containing non-deleted tasks created by the signed-in viewer's linked
Slack actors. A viewer may delete those tasks from the page.

Generate schema changes with
`pnpm --filter @sentry/junior-scheduler db:generate`.

Follow `../../policies/serverless-background-work.md`,
`../../policies/context-bound-systems.md`, and
`../junior-plugin-api/README.md`.
