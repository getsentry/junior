# Automations

This module projects scheduled and event automations for signed-in users. It
includes automations that the user owns and automations in public destinations
in the user's linked Slack workspaces.

The collection filters, sorts, and pages all accessible Automations in SQL.
Counts use the same access rules. Public access and Destination labels come
from the Destination directory. Missing or private entries do not grant access.

Scheduled automations run through the heartbeat. Event automations run when a
matching event arrives. The dashboard can edit and delete only Automations
that the user owns. A public Destination grants read access, not write access.

Deleted automations keep their execution history and title. They do not match
new events or schedules.

An automation title is stored in the SQL `title` column. It is not part of the
legacy JSON payload. The API uses the first line of the instruction when a title
is missing. Instruction edits keep the stored title. A title changes only when
an edit supplies a replacement.

## Web edits

`GET /api/automations/:kind/:id/edit` returns exact values and an opaque
revision. It does not depend on a list page. Scheduled edits return the stored
Schedule and next occurrence. Event edits return the full selector, including
match conditions. Both include ordered outcomes and credential mode.

`PATCH /api/automations/:kind/:id` requires that revision and the same `kind`.
It accepts only changed fields. Omitted fields stay unchanged. A replacement
Schedule uses `ScheduleIntent`, the same input as the Slack tools. The API does
not accept lifecycle or creator changes. It does not dispatch work or restart
a completed Automation.

The shared edit functions own Schedule compilation, plugin event validation,
creator credential rules, and outcome resolution. A new outcome can target only
the current Destination or the original creator. An exact stored outcome can
be kept or reordered, even if the editor cannot create that Destination.
Unchanged event selectors can keep unavailable events and match fields.
Replacement selectors must pass the current plugin catalog rules.

The revision hashes the decoded stored values, including title and lifecycle.
Scheduled saves compare it under the task lock. Event saves compare it under a
SQL row lock. Slack edits use the same check. A scheduler state change can also
invalidate an open edit. The API returns 409 for a stale edit, 400 with field
paths for input errors, and 404 for a missing or non-owned Automation. The
editor must keep unsaved input when a save fails.
