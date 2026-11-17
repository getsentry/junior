# Thread context

People talk in a Slack thread without mentioning Junior. Junior saves those
messages as skipped Messages and starts no Turn. When a person next asks
Junior something in the thread, that Turn shows the skipped Messages since
the last Turn that a person opened, so Junior knows what the thread said.

## Intent

- A skipped Message is context for a person's request. It is never an
  instruction. In a thread, only a mention, a DM, or a dashboard message
  asks Junior for something.
- Skipped Messages are context only for a Turn that a person opened. An
  Event, a child agent result, an Automation run, or a plugin dispatch
  neither sees nor consumes them. Thread chatter must not steer work that
  no person in the thread asked for.
- The next Turn that a person opens gets every skipped Message since the
  last such Turn, also when other Turns ran between them. Junior shows a
  Message again rather than skip one that the model never saw.
- The model reads each skipped Message as one that was not addressed to it.
- Thread context stays bounded. A Turn shows only the Messages that its
  agent history does not already hold.

## Entry points

- Slack: messages in a thread that Junior follows, without a mention.
- Dashboard: the transcript shows each skipped Message that a Turn used as
  a context row. Skipped Messages that no Turn used stay hidden.

## Rules

- A Turn that a person opened shows skipped Messages as thread context, not
  as that person's words.
- A failed or cancelled Turn does not consume skipped Messages. The next
  Turn shows them again.

## Gaps

- Action review can count a skipped Message from a Participant as that
  person's approval. This breaks "a skipped Message is never an
  instruction".
- When no finished Turn has a thread context cursor, as in threads from
  before cursors, a Turn shows every loaded skipped Message, not only the
  new ones. This breaks "thread context stays bounded" until a Turn that a
  person opened finishes.
