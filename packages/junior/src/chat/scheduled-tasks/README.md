# Scheduled tasks

This module owns Junior's one-time and recurring task domain. Scheduled-task tools are core tools for complete Slack turns, and the core heartbeat claims due rows before plugin heartbeat hooks run.

## Persistence

The SQL tables retain their deployed `junior_scheduler_*` names so moving the feature into core does not copy or rename task data. Core migration `0016` supports both cases:

- fresh databases create the tables and indexes;
- databases upgraded from `@sentry/junior-scheduler` adopt the existing tables, normalize older records, and backfill canonical creator identities.

The legacy creator trigger remains during rolling deployment so an old worker can insert a task that a new worker can read. Remove it only in a later migration after old Scheduler workers can no longer overlap an upgrade.

## Dispatch

Scheduled runs use the core conversation work queue. They preserve `scheduler` as historical dispatch provenance and as the signed task-credential binding label; changing that value would invalidate existing task-scoped credential authority.

The heartbeat bounds claims per invocation, reconciles incomplete dispatches before claiming new work, and advances recurring tasks only after their current run reaches a terminal outcome.

Task status is `active`, `blocked`, or `deleted`. There is no pause state: stop a task by deleting it, or leave it blocked when authorization/config prevents dispatch. When a terminal run leaves no future occurrence, the task is tombstoned as `deleted`. Listings, tool lookups, and the Tasks UI hide `deleted` rows while retaining the record as a tombstone.
