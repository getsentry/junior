# @sentry/junior-scheduler

The scheduler plugin stores user-created schedules and dispatches due work into
Junior's durable agent runtime.

## Task Model

- A scheduled task records its creator, execution actor, Slack destination,
  prompt text, timezone-aware schedule, recurrence, status, and next-run state.
- SQL schemas and migrations are authoritative for persistence.
- Schedule parsing normalizes calendar intent before storage; execution does not
  reinterpret the original natural-language request.
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
- Stored creator attribution does not automatically authorize use of another
  user's provider credentials.
- Execution uses the sanitized principal and explicit credential subject carried
  by the scheduled task contract.
- User-visible schedule management remains scoped to the active Slack context.

## Operations

The plugin exposes create, update, delete, list, and run-now tools plus bounded
operational reporting. Generate schema changes with
`pnpm --filter @sentry/junior-scheduler db:generate`.

Follow `../../policies/serverless-background-work.md`,
`../../policies/context-bound-systems.md`, and
`../junior-plugin-api/README.md`.
