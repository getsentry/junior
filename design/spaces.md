# Spaces

A Space is a named home for a body of related work, such as "Junior iOS" or
"Billing migration". People create a Space, share it, and talk to its Lead,
which starts, tracks, and steers the Space's Conversations. Work that does
not need a home stays a one-off Conversation.

## Intent

- Large work has a home that people choose. A Space holds one body of work,
  big or small, short or long, with a name that people pick. Its Lead keeps
  track of that work only, so a person can hand it a lot without mixing it
  with unrelated work.
- Every Conversation knows its Space. A Conversation is in one Space or in
  none, and each surface can show which. A Space's Conversations are
  children of its Lead, so a Conversation is in the Space of its tree. Its
  history does not decide it.
- Work that a Space starts stays in the Space. Each Conversation that the
  Space's Lead starts, and each child agent under it, is in the Space. The
  Lead reads and finds other Conversations by the usual access rules, as a
  Conversation in its Space, so a member's private work never enters the
  Space. Its reach does not move other work into the Space.
- One-off work stays light. A Conversation with no Space is a one-off. It
  needs no setup, and nothing asks the person to choose a Space first.
- Spaces are shared. A Space is public by default, so anyone in the
  organization can find it, read it, and join it. Its members talk to the
  same Lead and see the same transcript.
- A Space sets its own configuration. The configuration keys that a Slack
  channel can set, such as a default repository or Sentry organization, can
  also be set on a Space. They apply to every Conversation in the Space.
- A Space's Lead coordinates and does not do the work. It hands each request
  to a child Conversation at once, and archives work when it is done.
  Starts, messages, Watches, and action review work the same as for every
  other Conversation.
- Finished work leaves the lists. A person can archive a Space when its
  work is done. Archiving a Space stops and archives every Conversation in
  it, so no work in it keeps running.

## Rules

- A Conversation joins a Space only when a person or the Space's Lead puts
  it there: it starts in the Space, the Lead starts it, or a person moves
  it. Junior can suggest a Space, but it does not choose one without a
  person.
- A Conversation joins a Space as a child of the Space's Lead, and leaves it
  as a root. Its own child agents move with it.
- A move never makes private work public. A private Conversation cannot move
  into a public Space.
- A child Conversation is always in the Space of its root.
- Each Space has exactly one Lead. A person has no Lead outside a Space.
- A Space and its Lead share one name, description, and To-do list.
- A public Space is readable by anyone in the organization. Only its
  members can talk to its Lead or start work in it, so a person joins the
  Space first. Its Conversations follow the usual rules for public
  Conversations ([Conversation access](../policies/conversation-access.md)).
- A private Space is readable only by its members, like a private Slack
  channel. Its Conversations are private, and they share one audience: the
  members. A Conversation in a private Space can read the other
  Conversations in that Space, and no data goes from it to a Conversation
  outside the Space.
- A Space's visibility is set when the Space is created and never changes.
  To make work private or public, a person creates a new Space and moves
  the work there.
- Members see the Space in their sidebar. A person who is not a member can
  open a public Space and join it.
- Each Space in the sidebar shows what its Conversations need from the
  member, the first that applies: a Conversation needs them, one failed, or
  one works. A Space with none of these shows nothing. Its Conversations
  still show in In flight, so each one stays one click away.
- Any member can archive a Space.
- Configuration resolves in this order: an explicit target in the request,
  then the Space, then the Slack channel, then the install-wide defaults.

## Gaps

- A Space's Lead cannot archive a Conversation that it started. This breaks
  "a Space's Lead coordinates and does not do the work".
- The public MCP server does not show a Conversation's Space, so the iOS app
  cannot show it. This breaks "every Conversation knows its Space".
- A Conversation in a private Space cannot move out, and only a public
  Conversation can join a Space. So a person cannot move work to change
  its visibility. This breaks "to make work private or public, a person
  creates a new Space and moves the work there".
