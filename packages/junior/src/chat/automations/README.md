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

## Versions

An Automation version is one saved definition. The definition is the title,
instruction, Schedule or event selector, Destination, outcomes, and credential
mode. Status and run times are not part of it. Pause, resume, delete, and
run-now do not make a version.

The save writes the version in the same transaction and lock as the
Automation. A save that does not change the definition does not make a
version. A new Automation gets version 1 from its creator. A Slack edit records
the requester. A web edit records the creator, because only the creator can
edit on the web.

Migration 0046 saves the current definition of each live Automation as
version 1, with no editor. Edits by older workers during a rolling deploy do
not make versions.

`GET /api/automations/:kind/:id/versions` returns the newest 100 versions. It
uses the same read access as executions.

## Pause and attention

Pause and resume are creator-only actions, separate from form saves. Both check
the read revision under the same lock as edits. They keep credentials and history
and cannot restart completed work.

`scope=attention` filters the full collection before counting and paging. It
includes blocked Automations, unavailable event triggers, and failed or blocked
last runs. It excludes paused and completed work. A failed run does not mean
future runs are disabled.
