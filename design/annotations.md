# Annotations

An Annotation shows that a Conversation created, changed, or deleted an
object, such as a pull request, a Ticket, or a Calendar event. People see it
in Linked work, as a Message card, and in search.

## Intent

- An Annotation names one object and what the Conversation did to it, and
  holds the title, the state, and the link of the object.
- People see the current state of the object. Webhooks and tools keep the
  Annotation current, so the UI never depends on a query to the provider,
  with or without a cache.
- An object keeps its Annotations when its provider renames or moves it.

## Rules

- An Annotation stores the kind and the id of the object, what the
  Conversation did, and when, and the title, the state, and the link of the
  object. The plugin makes the short label from the object.
- A card shows the title and the state from the Annotation, with the same
  renderer as the Inbox. Showing a card never queries the provider.
- A read adds no Annotation. A change at the provider, such as a merge,
  updates the Annotation when a webhook or a tool reports it.
- A link that someone shares in a Message is not an Annotation. The agent
  reads it from the transcript.
- A card shows only what the viewer can see. A viewer who cannot read the
  object sees only its label.
- A root Conversation shows the Annotations of its child agents.
- An Annotation never gives access to the object.
- A card that Junior posted in Slack keeps the facts that it had then. Its
  details show the current state from the Annotation.

## Gaps

- A card reads the title and the state of a GitHub object from GitHub when
  a page loads. This breaks "showing a card never queries the provider".
