# Conversation REST Resources

- Stored events are not a REST contract. Do not expose replacement history,
  opaque provider metadata, or fields the reporting API does not own.
- Projections are append-only: later facts make new observations. Clients
  reduce observations by stable identity.
- Keep start-context and model-settings lookups bounded. Do not widen or merge
  cached REST resources.
- Never fill missing historical model settings from current host config.
