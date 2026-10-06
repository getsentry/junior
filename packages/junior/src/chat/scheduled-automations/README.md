# Scheduled automations

This module owns Junior's one-time and recurring task domain. Scheduled-task tools are core tools for complete Slack turns, and the core heartbeat claims due rows before plugin heartbeat hooks run.

## Persistence

The SQL tables retain their deployed `junior_scheduler_*` names so moving the feature into core does not copy or rename task data. Core migration `0016` supports both cases:

- fresh databases create the tables and indexes;
- databases upgraded from `@sentry/junior-scheduler` adopt the existing tables, normalize older records, and backfill canonical creator identities.

The legacy creator trigger remains during rolling deployment so an old worker can insert a task that a new worker can read. Remove it only in a later migration after old Scheduler workers can no longer overlap an upgrade.

## Dispatch

Scheduled runs use the core conversation work queue. They preserve `scheduler` as historical dispatch provenance and as the signed task-credential binding label; changing that value would invalidate existing task-scoped credential authority.

The agent input uses shared framing from `task-input.ts`. See `chat/README.md`
(Task agent input) for the section outline.

The heartbeat bounds claims per invocation, reconciles incomplete dispatches before claiming new work, and advances recurring tasks only after their current run reaches a terminal outcome.

Task status is `active`, `paused`, `blocked`, `completed`, or `deleted`. A person can pause future claims without deleting history. A block means a requirement prevents dispatch. A successful terminal run with no future occurrence becomes `completed` so creators can still find one-off reminders. Failed/skipped terminal work without a future occurrence is tombstoned as `deleted`. Listings and tool lookups hide `deleted` rows while retaining the record as a tombstone. Public workspace listings also omit `completed` rows; the creator-owned Tasks view keeps them.

## Timezones

A new schedule uses the first available timezone from this list:

1. the timezone that the user asks for;
2. the creator's Slack profile `tz`;
3. the creator's `junior_users.timezone`;
4. `JUNIOR_TIMEZONE`, or `America/Los_Angeles` when that setting is absent.

The create tool saves a valid Slack timezone to `junior_users.timezone`. The saved value is used only when Slack has no valid timezone. Edits keep the schedule timezone unless the user asks to change it.

Do not put the timezone on the Actor. The Actor is stored with each message, and a timezone is a user preference that can change.

## Destination moves

A scheduled Automation targets a Slack channel or direct message. It never targets a thread. A tool call from a thread uses the active channel as the Destination.

Same-channel create/list/update/delete stay bound to the active Slack channel by default.

Cross-channel rehomes stay destination-first and reuse the existing tools:

1. ask in the channel where the task should deliver next;
2. `slackScheduleListAutomations` with optional `channel_id` / `query` finds the requester's matching task elsewhere in the workspace;
3. `slackScheduleUpdateAutomation` with `destination: "here"` rehomes that existing task row into the active channel.

Only the creator may change destination. Move preserves task id, instruction, schedule, creator identity, credential mode, and next run. It reclassifies conversation access from the active Slack source and refuses while an incomplete occurrence is already pending or running. Do not emulate a move with create+delete.

## Pause and resume

Pause stops future claims. Already-claimed work may finish but cannot remove a
pause. Resume selects the next future Schedule time and skips missed runs.
A missed one-off needs a new Schedule. Pausing blocked work keeps its reason;
removing the pause restores the block until the user resolves it and resumes.

Deploy all workers before using pause. Older workers read paused rows as deleted.
Pause uses the existing text status column. Migration 0017 removes only legacy
paused rows on installations that have not yet applied it.
