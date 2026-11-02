# Conversation REST Resources

This directory owns HTTP access checks, request parsing, and the reporting
response format for Conversations. It does not own a Conversation or a Turn.
Web input and Turn state live in `chat/conversations`. The worker lives in
`chat/task-execution`.

## Rules

- Each resource checks participant access and retention again from stored
  Conversation state. Private payloads are redacted for other viewers. Purged
  history returns `eventHistory.status === "expired"` with no events or model
  usage.
- Cursors are opaque, HMAC-signed, and bound to one Conversation and event
  sequence. Callers must not build or change them.
- Stored events are not a REST contract. The reporting adapter projects them.
  Do not expose replacement history, opaque provider metadata, or fields that
  the reporting API does not own.
- Projections are append-only. Later facts make new observations. Clients
  reduce observations by stable identity.
- Lookups for start context and model settings must stay bounded. Do not widen
  or merge cached REST resources.
- Never fill missing historical model settings from current host config.
- `/agents` and `agentTree` read runtime agent invocation records, not model
  output. Each Conversation in a tree has its own access check.
- All summary views read the fallback title through
  `readFirstHumanMessageTexts`, so they show the same title.
- Mentions resolve on each read. Set `email` only for a linked, verified
  Junior user.
- Attachments can appear after the event. Clients compare attachment metadata
  as well as event sequence.
