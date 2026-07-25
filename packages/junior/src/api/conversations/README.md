# Conversation REST resources

Conversation reporting is split across authenticated detail and event
resources:

- Detail returns mutable conversation metadata and the latest bounded page of
  projected events. Clients poll this bounded resource while the conversation
  is active. `previousCursor` is present when older projected events remain.
- `/events` reads strictly before a `before` cursor and returns the next older
  bounded page.

Cursors are opaque, HMAC-signed, and bound to one conversation and canonical
event sequence. Callers must not derive or modify cursor positions.

Canonical storage contains events that do not appear in the transcript.
Paging therefore scans bounded row batches until it finds the requested number
of projected reporting events. A paged `subagent_ended` event resolves its
matching start even when that start is outside the current page.

Each resource re-evaluates participant access and retention from persisted
conversation state. Private payloads are projected as redacted for other
viewers. Purged histories return `eventHistory.status === "expired"` with no
events or model usage.
