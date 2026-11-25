# Annotations

An Annotation shows that a Conversation created, changed, or attached an
object, such as a pull request, a Ticket, or a Calendar event. People see it
on the Conversation row, as a Message card, and in search.

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
- A card reads the title and the state of the object live, with the same
  renderer as the Inbox. The cache keeps the last good value.
- A read adds no Annotation. A change at the provider, such as a merge,
  changes no Annotation.
- A card shows only what the viewer can see. A viewer who cannot read the
  object sees only its label.
- A root Conversation shows the Annotations of its child agents.
- An Annotation never gives access to the object.
- A card that Junior posted in Slack keeps the facts that it had then. Its
  details read the object live.

## Gaps

- A Linear Ticket has no live card.
