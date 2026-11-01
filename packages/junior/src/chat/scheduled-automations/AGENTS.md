# Scheduled automations

This module owns one-time and recurring Scheduled automations. The core
heartbeat claims due rows before plugin heartbeat hooks run.

Shared access, edit, credential, and run rules are in
`chat/automations/AGENTS.md`.

## Dispatch

- Scheduled runs use the core Conversation work queue.
- Keep `scheduler` as the dispatch label. It is also the signed task
  credential binding label. A change breaks existing task credentials.
- The heartbeat limits claims for each invocation. It reconciles incomplete
  dispatches before it claims new work.
- A recurring Automation advances only after its current run ends.
- A successful last run makes the Automation `completed`. A failed or skipped
  last run makes it `deleted`. Lists hide `deleted` rows but keep them.

## Timezones

- Order: the timezone the user asks for, the Slack profile `tz`,
  `junior_users.timezone`, then `JUNIOR_TIMEZONE`.
- Edits keep the Schedule timezone unless the user asks to change it.
- Do not put the timezone on the Actor. The Actor is stored with each
  Message, and a timezone is a user preference that can change.

## Destination

- The Destination is a channel or DM, never a thread. A call from a thread
  uses its channel.
- Only the creator can move the Destination. A move keeps the Automation id,
  Schedule, creator, credential mode, and next run. It is refused while a run
  is pending or running. Do not emulate a move with create and delete.

## Pause And Resume

- Pause stops future claims. Claimed work may finish but cannot remove a
  pause.
- Resume selects the next future time and skips missed runs.
- Pausing blocked work keeps its reason. Removing the pause restores the
  block.
- Run now counts as a start. A non-creator cannot run now with creator
  credentials.
