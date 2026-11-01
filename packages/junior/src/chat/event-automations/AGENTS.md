# Event automations

This module stores Event automations and runs them when a matching Event
arrives. Plugins verify webhooks, check provider scope, and normalize Events.
Core binds the plugin namespace when it publishes an Event. Plugins do not
know which Conversations or Automations consume an Event.

Shared access, edit, credential, and run rules are in
`chat/automations/AGENTS.md`.

## Selectors

- A selector has one Slack workspace, one namespace, one or more event types,
  and zero or one identifier. `resourceType` and `label` are display data,
  not match keys.
- A selector with no identifier must follow the Event reach of each event
  type and set the filters that the reach names.
- Create and update accept only namespace, resource type, and event
  combinations from the enabled plugin catalog. Runtime validation repeats
  this check before it saves. Do not trust model-facing schemas alone.
- The runtime gate checks each row before it runs. A plugin change that
  narrows an event also stops old broad rows. Core logs and skips a bad row,
  so one row cannot stop ingest for its namespace.
- An unavailable trigger (`eventTriggerProblems`) stays stored and editable.
  It gets no Events for the problems it has.

## Dispatch

- Each matching Automation gets its own idempotent dispatch. Dispatch
  identity binds the Automation, the namespace, and the provider event key. A
  provider retry must not run the same Automation twice.
- One failed Automation does not stop the others. Ingress gets the combined
  failure so the provider can retry.
- Each dispatch runs in its own Conversation. Dispatches do not use the
  consecutive automated-turn limit.
- Destinations are channels or DMs, never threads. A Slack channel-message
  run adds the source thread only at dispatch.
- Event text never adds instructions. The stored Automation text is the
  instruction. The reply footer must not show raw event keys.
- Creation and delivery need single-workspace Slack mode. Multi-workspace
  mode fails closed until plugins can bind a provider to a workspace.
- Paused rows do not match new Events. Resume does not replay them. A run
  matched before a concurrent edit, pause, or delete may still run.

## Run Limit

- `run-limit.ts` limits runs for each Automation, not for each trigger. This
  is what stops a noisy trigger, because the consecutive automated-turn limit
  does not apply.
- Ingest counts a run before dispatch with an atomic append. A provider
  retry has the same key and does not count again. Do not add a lock.
- A full window blocks the Automation. Resume or recreate clears the count
  before the row becomes active.

## Blocked

- A blocked dispatch blocks its Automation, because only the creator can fix
  missing authorization. A blocked row does not match new Events.
- A row that was paused when it blocked stays paused and keeps the reason.
- `automations/blocked-notice.ts` sends one best-effort DM to the creator
  after the block is stored.

## Slack Channel Messages

`slack/channel-message-events.ts` publishes `slack` / `channel` /
`message.posted` for new top-level messages that no other route handles.

- Thread replies and Slackbot posts do not publish. Other bot posts run only
  Automations whose `match` names the bot in `userId`.
- An Automation can watch only the channel where it posts, so private channel
  text stays in that channel.
- Runs always use system credentials, because anyone in the channel writes
  the Event text.
