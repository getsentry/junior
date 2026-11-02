# Event automations

Plugins do not know which Conversations or Automations consume an Event.
Shared rules are in `chat/automations/AGENTS.md`.

## Selectors

- `resourceType` and `label` are display data, not match keys.
- Validate the namespace, resource type, and event combination against the
  enabled plugin catalog again before save. Do not trust model-facing schemas
  alone.
- Check each row against the catalog before it runs, so a plugin change that
  narrows an event also stops old broad rows. Log and skip a bad row, so one
  row cannot stop ingest for its namespace.
- An unavailable trigger (`eventTriggerProblems`) stays stored and editable.

## Dispatch

- Dispatch identity binds the Automation, namespace, and provider event key.
  A provider retry must not run the same Automation twice.
- One failed Automation does not stop the others. Ingress gets the combined
  failure so the provider can retry.
- Destinations are channels or DMs, never threads. A Slack channel-message
  run adds the source thread only at dispatch.
- The stored Automation text is the instruction. Event text never adds
  instructions. The reply footer must not show raw event keys.
- Multi-workspace Slack mode fails closed until plugins can bind a provider
  to a workspace.
- Resume does not replay Events missed while paused. A run matched before a
  concurrent edit, pause, or delete may still run.

## Run limit and blocks

- `run-limit.ts` limits runs per Automation, because the automated-turn limit
  does not apply to dispatches.
- Ingest counts a run before dispatch with an atomic append keyed by the
  event, so a retry does not count again. Do not add a lock.
- A full window blocks the Automation. Resume or recreate clears the count
  before the row becomes active.
- A blocked dispatch blocks its Automation, because only the creator can fix
  missing authorization. A row that was paused when it blocked stays paused.

## Slack Channel Messages

- Thread replies and Slackbot posts do not publish. Other bot posts run only
  Automations whose `match` names the bot in `userId`.
- An Automation can watch only the channel where it posts, so private channel
  text stays in that channel.
- Runs always use system credentials, because anyone in the channel writes
  the Event text.
