# Annotations

An Annotation shows that a Conversation created, changed, or deleted an
object, such as a pull request, a Ticket, or a Calendar event. People see it
in Linked work, as a Message card, and in search.

## Intent

- An Annotation is a pointer. It names one object and what the Conversation
  did to it. The object owns its title, its state, and its links.
- People see the current state of the object, not the state when Junior
  last wrote it.
- An object keeps its Annotations when its provider renames or moves it.

## Rules

- An Annotation stores the kind and the id of the object, what the
  Conversation did, and when. It also stores the title and a link, so that
  search can find the object and a card can show when the provider is
  down. The plugin makes the short label from the object.
- Page loads, API responses, and polling render a card only from stored
  data: the annotation and the provider state that webhooks write. Anyone
  who can read the Conversation sees that state. A card may read its
  provider once when it is hovered or scrolls into view. Every provider
  call has a deadline, so a slow provider cannot block a request.
- A read adds no Annotation. A change at the provider, such as a merge,
  changes no Annotation.
- A link that someone shares in a Message is not an Annotation. The agent
  reads it from the transcript.
- A card shows what its Conversation's viewers may see: stored state to
  anyone who can read the Conversation, and a live hover read only when
  the viewer can read the object.
- A root Conversation shows the Annotations of its child agents.
- An Annotation never gives access to the object.
- A card that Junior posted in Slack keeps the facts that it had then. Its
  details read the object live.
