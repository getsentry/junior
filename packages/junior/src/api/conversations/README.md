# Conversation REST resources

Conversation reporting is split across three authenticated resources:

- Detail returns mutable conversation metadata and the latest bounded page of
  projected events. Its `eventCursor` starts forward polling after the snapshot
  high-water sequence; `previousCursor` is present when older projected events
  remain.
- `/events` reads strictly before a `before` cursor and returns the next older
  bounded page.
- `/updates` reads strictly after a `cursor`, advances through one stable
  high-water sequence, and reports `hasMore` when another forward page remains.

Cursors are opaque, HMAC-signed, and bound to one conversation, direction, and
canonical event sequence. Detail anchors both paging directions. Callers must
not derive or modify cursor positions.

Canonical storage contains events that do not appear in the transcript.
Paging therefore scans bounded row batches until it finds the requested number
of projected reporting events. Forward cursors advance across filtered rows so
later updates neither repeat nor skip visible events. A paged
`subagent_ended` event resolves its matching start even when that start is
outside the current page.

Each resource re-evaluates participant access and retention from persisted
conversation state. Private payloads are projected as redacted for other
viewers. Purged histories return `eventHistory.status === "expired"` with no
events or model usage.
