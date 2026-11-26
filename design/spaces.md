# Spaces

A Space is a named home for a body of related work, such as "Junior iOS" or
"Billing migration". A Space is its Lead and nothing more: a root
Conversation of kind `lead`, with a Space row that Junior creates with it.
The Lead is the root of the Space's tree, and every other Conversation
in the Space is a child of the Lead. People create a Space, share it, and
talk to its Lead. Work that does not need a home stays a one-off
Conversation. What the Lead does is in `./lead.md`.

## Intent

- A Space is a Conversation tree. Parents, roots, Participants, visibility,
  access, stops, archives, Watches, and updates work the same as in every
  other tree (`./agent-teams.md`). A Space adds only the layers under
  "Space layers", so a fix to the tree also fixes Spaces, and no Space code
  repeats tree code.
- Large work has a home that people choose. A Space holds one body of work,
  big or small, short or long, with a name that people pick. Its Lead keeps
  track of that work only, so a person can hand it a lot without mixing it
  with unrelated work.
- Every Conversation knows its Space. A Conversation is in the Space of the
  Lead at the root of its tree, or in none. Each surface can show which.
- Work that a Space starts stays in the Space. Each Conversation that the
  Lead starts, and each child agent under it, is in the Space. The Lead
  reads and finds other Conversations by the usual access rules, so a
  member's private work never enters the Space.
- One-off work stays light. A Conversation with no Space is a one-off. It
  needs no setup, and nothing asks the person to choose a Space first.
- Spaces are shared. A Space is public by default, so anyone in the
  organization can find it, read it, and join it. Its members talk to the
  same Lead and see the same transcript.
- Finished work leaves the lists. A person archives a Thread when its work
  is done, and archives the Lead when all of its work is done. Archiving the
  Lead archives the Space.

## Rules

**Tree**

- Each Space has exactly one Lead, and the Lead is the root of the Space's
  tree. A person has no Lead outside a Space.
- Each Conversation in a Space is a child of the Lead, and the Lead is its
  root. This is true when the Lead starts it, when a person starts it in the
  Space, and when a person moves it in.
- A Conversation joins a Space only when a person puts it there, or asks the
  Lead to. Junior can suggest a Space, but it does not choose one without a
  person.
- When a Conversation leaves a Space, it becomes a root. Its own child
  agents move with it in every move.
- A Conversation that moves into a Space keeps its Location, so a Slack
  thread still gets its replies.
- The Lead's Participants are the Space's members, and each child inherits
  them for access.
- Archive and snooze act on one child: they change that Thread and its own
  child agents, not the Lead or the other Threads. Archiving the Lead stops
  and archives every Conversation in its tree, and so archives the Space.
  Any member can archive the Lead.

**Space layers**

Only these sit on top of the tree:

- Metadata: the Space row's name and description, which the Lead shares.
  The Lead's Threads are its plan.
- Configuration: the keys that a Slack channel can set, such as a default
  repository or Sentry organization, can also be set on a Space. They apply
  to every Conversation in it. They resolve in this order: an explicit target
  in the request, the Space, the Slack channel, then the install-wide
  defaults.
- The Lead's prompt and tools, in `./lead.md`.
- Moves: `moveConversationToSpace` and `listSpaces`.
- Rendering: the sidebar, the Threads panel, and top-level lists.

**Access**

- A public Space is readable by anyone in the organization. Its
  Conversations follow the usual rules for public Conversations
  ([Conversation access](../policies/conversation-access.md)).
- A private Space is readable only by its members, like a private Slack
  channel. Its Conversations are private and share one audience: the
  members. No data goes from it to a Conversation outside the Space.
- A Space's visibility is its Lead's visibility. It is set when the Lead is
  created and never changes.
  To make public work private, a person moves it into a private Space.
  Private work never becomes public, so a private Conversation never joins a
  public Space.

**Rendering**

- The dashboard calls each child of a Lead a Thread. Top-level lists show
  each Thread as its own row, not nested under the Lead.
- Members see the Space in their sidebar. A person who is not a member can
  open a public Space and join it.
- Each Space in the sidebar shows what its Threads need from the member, the
  first that applies: a Thread needs them, one failed, or one works. A Space
  with none of these shows nothing.
- The Threads panel beside the Lead lists the Space's Threads in one list,
  in order of what they need from the viewer: needs you, working, waiting,
  done. It shows no group headings or counts.

## Gaps

- A Space's Conversations are roots that store their Space, not children of
  the Lead. So the Lead cannot stop or archive them, and its Participants do
  not give access to them. This breaks the "Tree" rules.
  getsentry/junior#4413 tracks it.
- The Threads panel lists Threads by their newest Message, not by what they
  need. getsentry/junior#4416 tracks it.
- The public MCP server does not show a Conversation's Space, so the iOS app
  cannot show it. This breaks "every Conversation knows its Space".
- A Conversation in a private Space cannot move to another private Space,
  and a private Conversation cannot join a private Space. So a person
  cannot put private work in the Space they choose. This breaks "a
  Conversation joins a Space only when a person puts it there".
- The Space row stores its own visibility and archive state, apart from its
  Lead. So archiving a Space is its own action, not archiving the Lead.
  This breaks "a Space is its Lead".
