# Automations

This module projects scheduled and event automations for signed-in users. It
includes automations that the user owns and automations in public destinations
in the user's linked Slack workspaces.

Results are newest-first. Owned and public results have separate limits. Public
access and destination labels come from the destination directory. Missing or
private directory entries do not grant access.

Scheduled automations run through the heartbeat. Event automations run when a
matching event arrives. The dashboard can delete only automations that the user
owns. A public destination grants read access, not write access.

Deleted automations keep their execution history and title. They do not match
new events or schedules.

An automation title is stored in the SQL `title` column. It is not part of the
legacy JSON payload. The API uses the first line of the instruction when a title
is missing.
