# Conversations

## Event log

- `junior_conversation_events` is the only transcript and agent-history
  table. Do not add a second history store or a message projection table.
- `message` events are chat content for display, delivery, privacy, and
  search. `user_message`, `assistant_message`, and `tool_result` are replayable
  agent history. Do not use one kind for the other.
- Store and replay `<runtime-turn-context>` unchanged. Replay decodes stored
  message JSON as-is. Do not rebuild it from a field list.
- Only `compaction` and `handoff` replace active agent history.
  `messages_summarized` does not.
- Persist inbound `message` events before agent execution. Persist assistant
  `message` events only after the destination accepts them.
- All writes for one Conversation take the
  `junior_conversation:<conversationId>` advisory lock.
- Keep imports and migrations idempotent. Keep Conversation ids.

## Compatibility

- Live writers accept only canonical event types and the current schema
  version.
- Readers keep an unsupported type or version as `unknown`. Reporting and
  search ignore it. Agent-history replay rejects it.
- A malformed event of a supported type and version is corrupt. Reject it,
  never downgrade it to `unknown`.

## Privacy

- `Conversation.location` is the only Location field for new code. Privacy is
  in `Conversation.visibility`, not in Location.
- Destination visibility is the privacy authority. Messages, agent history,
  child Conversations, Agent invocations, and plugin projections inherit it.
- REST access joins through `root_conversation_id`. Missing or invalid root
  metadata fails closed.
- Raw event payloads are internal. Reporting APIs return an authorized,
  redacted projection.
- Cross-Conversation search stays in one Slack workspace and public
  destinations.
- Retention purges the full child tree, including delegated input and
  results.

## Conversation notes

- Only core adds a note. No tool lets the model write one.
- A note never starts a Turn, adds no mailbox work, and does not count toward
  the automated-turn limit. It is context, never user intent.
- A failed-Turn note has the error `event_id`, never the raw error.

## Forks

- Do not copy credentials, approvals, provider connections, Guardian reviews,
  plugin state, the Sandbox, files, Location, active work, Watches, or
  Automations.
- The fork keeps the source visibility. Source authors do not become
  participants. `forked_from_conversation_id` is not a delegation parent.

## Object annotations and Message cards

- An object annotation is the latest saved facts, not the object store.
  Message `objectCards` store only `{ kind, plugin, key }`.
- `annotations.upsert` and webhook updates never queue a card or start a
  Turn.
- Plugins return only facts safe for the Conversation audience. Cards do not
  expand provider permissions. Detail views use Conversation access, not the
  original actor's credentials.
- Show a missing annotation as unavailable, never as stale facts.
- Core and the web do not parse provider URLs to guess a type.
- Change the icon asset path version when an existing image changes.
