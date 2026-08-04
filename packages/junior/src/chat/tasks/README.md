# Tasks

This module projects the two native durable task kinds for signed-in users:

- tasks owned through a canonical or viewer-linked Slack identity;
- tasks assigned to public destinations in the viewer's linked Slack workspaces.

The projection is newest-first and bounded. Destination labels come from the
persisted destination directory, with provider ids used only as a fallback. It
does not merge the persistence models or dispatch paths: scheduled work is
claimed by the heartbeat, while event work is matched during resource-event
ingestion. The dashboard API may delete only a task that belongs to the
resolved viewer; visibility grants read access, not mutation authority.
