# Annotations

An Annotation saves facts or a link on one Conversation, for an object that
the Conversation created, changed, or deleted, such as a pull request, an
issue, a calendar event, a deployment, or an Automation. People see these
objects as the Conversation's Linked work.

## Intent

- Linked work answers "what did this Conversation do?" A reader finds the
  objects that its work changed without reading the transcript.
- Linked work holds only objects that the Conversation created, edited, or
  deleted. An object that Junior only read, and a link that a person or
  Junior sent, are not Linked work.
- A root Conversation shows the Linked work of its child Conversations.
- Linked work stays current. When an object changes outside Junior, such as
  a pull request that merges, its status changes on the Conversations that
  link it.

## Rules

- Only a create, an edit, or a delete saves an Annotation. A read-only tool
  saves none, and Junior refuses an Annotation that one returns.
- A person cannot add Linked work by hand. A link in a Message adds none.
- A change to an object outside Junior updates only the Conversations that
  created or changed it.
- An update to an Annotation sends no message.
- A viewer who cannot open an object sees only its link in Linked work.

## Gaps

- A plugin tool gets the same annotation store for all its tools, so a
  read-only plugin tool can save an Annotation directly.
