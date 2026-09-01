# Tasks

This module projects the two native durable task kinds for signed-in users:

- tasks owned through a canonical or viewer-linked Slack identity;
- tasks assigned to public destinations in the viewer's linked Slack workspaces.

The projection is newest-first and independently bounded for owned and public
tasks so activity in one scope cannot crowd the other out. Public access and
destination labels come from the current persisted destination directory;
missing or non-public directory entries fail closed, with provider ids used
only as label fallbacks. It does not merge the persistence models or dispatch paths:
scheduled work is claimed by the heartbeat, while event work is matched during
resource-event ingestion. The dashboard API may delete only a task that belongs
to the resolved viewer; visibility grants read access, not mutation authority.
Empty legacy scheduled-task text is projected with stable display placeholders
so one malformed record cannot fail the entire list.

Runs stay on the durable execution table after a task is deleted. The Runs view
keeps historical executions for deleted scheduled tasks the viewer owns, and for
executions on conversations where the viewer is a participant or root actor.
Scheduled delete keeps the task row for titles and stops future runs. Event
delete removes the task row, so those runs use the conversation title.

Tasks store an optional short `title` generated from the instruction the same
way conversation titles are generated. The title is a dedicated SQL column on
both `junior_scheduler_tasks` and `junior_event_tasks`, not a field inside the
JSON task payload. The Tasks API always projects a `title` for display, falling
back to a truncated first line of the instruction when no generated title is
stored yet.
