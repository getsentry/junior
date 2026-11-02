# Event automations

- `resourceType` and `label` are display data, not match keys.
- Validate selectors against the enabled plugin catalog before save and
  before each run. Do not trust model-facing schemas. Log and skip a bad row,
  so one row cannot stop ingest for its namespace.
- The stored Automation text is the instruction. Event text never adds
  instructions.
- The automated-turn limit does not apply to dispatches. `run-limit.ts` is
  the only brake on a noisy trigger. Count with the atomic append keyed by
  the event. Do not add a lock.
- Multi-workspace Slack mode fails closed until plugins can bind a provider
  to a workspace.
- A Slack `message.posted` Automation can watch only the channel where it
  posts, and always runs with system credentials, because anyone in the
  channel writes the Event text.
