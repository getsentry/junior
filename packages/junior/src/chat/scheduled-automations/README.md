# Scheduled automations

This module owns Junior's one-time and recurring task domain. Scheduled-task tools are core tools for Turns that a person started, and the core heartbeat claims due rows before plugin heartbeat hooks run.

## Persistence

Scheduled automations are `scheduled` rows in `junior_automations`. Their runs
are rows in `junior_automation_runs`. Migrations 0055 and 0056 copied them from
the older `junior_scheduler_*` tables, and migration 0057 dropped those tables.

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

A scheduled Automation targets a channel or direct message. It never targets a thread. A tool call from a thread uses its channel as the Destination. Destinations are stored as Slack channels, because Slack is the only delivery provider.

Create uses the Destination of the Conversation Location. A Conversation with no Location, such as a dashboard Conversation, can search and manage Automations, but it cannot create or move one. `searchScheduledAutomations`
uses the dashboard Automations search. It finds the requester's tasks, tasks in
public channels of their workspaces, and tasks that deliver to this Conversation. Scope
`current_conversation` limits it to this Conversation.

Cross-channel rehomes stay destination-first and reuse the existing tools:

1. ask in the channel where the task should deliver next;
2. `searchScheduledAutomations` with optional `query` / `destination` finds the requester's matching task;
3. `updateScheduledAutomation` with `destination: "current_conversation"` rehomes that existing task row into this Conversation's Destination.

Only the creator may change destination. Move preserves task id, instruction, schedule, creator identity, credential mode, and next run. It reclassifies conversation access from the Conversation visibility and refuses while an incomplete occurrence is already pending or running. Do not emulate a move with create+delete.

## Management access

The tools use the shared rule in `chat/automations/README.md` (Management
access). `requireToolAutomation` in `chat/automations/tool-access.ts` loads a task with that rule.
Run-now counts as a start: a non-creator cannot run now a task that still uses
creator credentials.

## Pause and resume

Pause stops future claims. Already-claimed work may finish but cannot remove a
pause. Resume selects the next future Schedule time and skips missed runs.
A missed one-off needs a new Schedule. Pausing blocked work keeps its reason;
removing the pause restores the block until the user resolves it and resumes.
