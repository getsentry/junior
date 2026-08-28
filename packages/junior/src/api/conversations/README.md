# Conversation REST resources

This directory owns the HTTP access checks, request parsing, and response
format. It does not own a Conversation or Turn. Web input and shared Turn state
live in `chat/conversations`. The worker lives in `chat/task-execution`.

Conversation reporting is split across authenticated detail and event
resources:

- Detail returns mutable conversation metadata and the latest bounded page of
  projected events. Clients poll this bounded resource while the conversation
  is active. `previousCursor` is present when older projected events remain.
- `/events` reads strictly before a `before` cursor and returns the next older
  bounded page.

Cursors are opaque, HMAC-signed, and bound to one conversation and canonical
event sequence. Callers must not derive or modify cursor positions.

Canonical storage contains runtime and Pi-shaped events that are not a suitable
REST contract. The reporting adapter projects those facts into normalized
resource events:

- `tool_calls` carries one or more tool observations. Each observation has a
  stable tool call id, name, and current status; input and model-visible output
  are optional according to access policy.
- `subagent` carries a stable child reference, canonical start position, and
  current status.
- message, turn lifecycle, compaction, and handoff events expose only the
  fields owned by the reporting API. Authorized compaction and handoff events
  include the generated continuation summary, but never the full replacement
  history.

The projection is append-only: later canonical facts produce new observations
instead of changing previously returned events. Clients reduce observations by
stable identity. A terminal tool or subagent observation includes its start
context even when the canonical start is outside the requested page. Resolving
that context uses bounded bulk lookups; it does not widen or merge cached REST
resources.

Paging scans bounded row batches until it finds the requested number of
projected reporting events because not every canonical event is reportable.

Each resource re-evaluates participant access and retention from persisted
conversation state. Private payloads are projected as redacted for other
viewers. Purged histories return `eventHistory.status === "expired"` with no
events or model usage.
