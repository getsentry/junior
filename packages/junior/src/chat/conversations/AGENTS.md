# Conversations

This module owns the durable Conversation record: Location, Messages, agent
history, Conversation notes, forks, search, visibility, and retention. HTTP
routes call this code. They do not own another Conversation or Turn.

## Event log

- `junior_conversation_events` is the only transcript and agent-history table.
  Do not add a second history store or a message projection table.
- `message` events are exact source or destination chat content. They own
  transcript display, delivery handling, privacy, and search.
- `user_message`, `assistant_message`, and `tool_result` are replayable agent
  history. They own the next model request. Do not use one kind in place of
  the other.
- `<runtime-turn-context>` is part of the exact model history. Store and
  replay it unchanged.
- Replay decodes the stored message JSON as-is. Do not rebuild messages from a
  field list. Replay ignores report copies such as `usage` and `model`.
- `messages_summarized` is not a history replacement.

## Write rules

- Persist inbound `message` events before agent execution.
- Persist assistant `message` events only after the destination accepts them.
- Append agent history in sequence order. Reject a change to a committed
  history prefix.
- Only `compaction` and `handoff` replace active agent history.
- All writes for one Conversation take the
  `junior_conversation:<conversationId>` advisory lock.
- Keep imports and migrations idempotent. Keep Conversation ids.

## Compatibility

- Live writers accept only canonical event types and the current schema
  version.
- Readers keep an unsupported type or version as an `unknown` event.
  Reporting and search ignore it. Agent-history replay rejects it.
- A malformed event of a supported type and version is corrupt. Reject it. Do
  not downgrade it to `unknown`.

## Location

- `Conversation.location` is the only Location field for new code. No Location
  means the Conversation stays inside Junior.
- Source does not contain Location. Privacy is in `Conversation.visibility`,
  not in Location.

## Privacy and authorization

- Destination visibility is the privacy authority. Messages, agent history,
  child Conversations, Agent invocations, and plugin projections inherit it.
  Follow `policies/data-redaction.md`.
- Each row has `root_conversation_id`. REST access joins through it. Missing or
  invalid root metadata fails closed.
- Raw event payloads are internal. Reporting APIs return an authorized,
  redacted projection. Keep visible `message` events apart from reasoning.
- Cross-Conversation search stays in one Slack workspace and public
  destinations.
- Retention purges the full child tree, including delegated input and results.

## Conversation notes

- `notes.ts` owns notes. Only core adds a note. No tool lets the model write
  one.
- A note never starts a Turn, adds no mailbox work, and does not count toward
  the automated-turn limit. It is context, never user intent.
- A failed-Turn note has the error `event_id`, never the raw error.

## Forks

- `forkConversation` forks only at a completed reply with a saved agent
  message. All fork writes are in one transaction.
- Do not copy credentials, approvals, provider connections, Guardian reviews,
  plugin state, the Sandbox, files, Location, active work, Watches, or
  Automations.
- The fork keeps the source visibility. The requester owns it. Source authors
  do not become participants. `forked_from_conversation_id` is not a
  delegation parent.

## Object annotations and Message cards

- An object annotation is the latest saved facts, not the authoritative object
  store. Message `objectCards` store only `{ kind, plugin, key }` references.
  The Conversation supplies the scope.
- Pending cards come from committed successful tool results. A visible Message
  consumes them. `annotations.upsert` and webhook updates never queue a card or
  start a Turn.
- Plugins return only facts safe for the Conversation audience. Cards do not
  expand provider permissions. Detail views use Conversation access, not the
  original actor's credentials.
- Show a missing annotation as unavailable, never as stale facts.
- `object-facts.ts` and `object-presentation.ts` in the plugin API own the
  shared facts and visual language. Core and the web do not parse provider
  URLs to guess a type.
- `node scripts/generate-object-icons.mjs` rebuilds the icons. Change the asset
  path version when an existing image changes.
