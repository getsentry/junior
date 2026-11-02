# Conversations

- `junior_conversation_events` is the only transcript and agent-history
  table. Do not add a second history store or a message projection table.
- `message` events are chat content for display, delivery, privacy, and
  search. `user_message`, `assistant_message`, and `tool_result` are replayable
  agent history. Do not use one kind for the other.
- Store and replay `<runtime-turn-context>` unchanged. Replay decodes stored
  message JSON as-is. Do not rebuild it from a field list.
- Only `compaction` and `handoff` replace active agent history.
  `messages_summarized` does not.
- Every write for one Conversation takes its advisory lock
  (`withConversationEventLock`). A new write path must take it too.
- `Conversation.location` is the only Location field for new code. Privacy is
  in `Conversation.visibility`, which children, Agent invocations, and plugin
  projections inherit.
- Conversation notes are context, never user intent. Only core adds one, and
  a note never starts a Turn.

## Object annotations and Message cards

- An annotation is the latest saved facts, not the object store. Show a
  missing one as unavailable, never as stale facts.
- Plugins return only facts safe for the Conversation audience. Cards do not
  expand provider permissions. Detail views use Conversation access, not the
  original actor's credentials.
- Core and the web do not parse provider URLs to guess a type.
- Change the icon asset path version when an existing image changes.
