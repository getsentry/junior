# Review desk

The Review desk is where work waits for a person. Junior or a plugin adds a
Review item: an action that asks a question, or a notice that only tells.
Its assignees see it on the desk and in its linked Slack threads, and the
first answer lets the work continue. The dashboard labels the desk "Inbox".

## Intent

- Work that needs a person is shared, lasting state: who must act, whether
  it is open, and the answer on record. A Slack message alone has none of
  these.
- There is one way to ask a person, and only for a decision that is theirs
  and blocks the work. Progress, offers, and scope choices are not items.
  Whether Junior starts new work for the requester, such as a Thread that
  implements an issue it filed, is the requester's decision, not an offer.
- A notice tells a person something that they must know or fix, such as a
  failed or blocked Automation. It never asks.
- Only an assignee answers, and the answer carries their authority. Junior,
  an Event, or a trigger never answers or approves for a person.
- "Needs you" means one thing on every surface: an open action assigned to
  you.

## Entry points

- Slack: the item card in each linked thread, and a thread reply.
- Dashboard: Inbox, the Home summary, "Needs you" in the conversation list,
  and the question above the message box.
- Settings: "Show the Inbox count in the tab".
- MCP server: read-only search and fetch with the `review_items:read` scope.

## Rules

- The first answer or dismiss closes the item for everyone. A dismiss is
  not a decision, so it does not continue the work.
- Every item has at least one assignee: a User, or Everyone. When no
  assignee is left, the item dismisses itself.
- With no assignees named, the item goes to the person in the Turn, else
  the Automation creator, else the Conversation's active Participants.
- An item from a private Conversation stays private and cannot go to
  Everyone.
- Making a Conversation public does not show its private items.
- A Slack thread that its Conversation detached from gets no new item card.
- Only the Conversation or the plugin that added an item can change it,
  and only within the assignee rules.
- An item from a public Conversation is visible to the whole workspace.
- Auto-archive never hides work that waits for a person. It skips a
  Conversation while it or a child has an open action, an open To-do
  for a person, or an answer that its starter has not read.

## Gaps

- An item can have no assignees, and then anyone who can see it can answer
  it. It does not dismiss itself. This breaks "every item has at least one
  assignee" and "only an assignee answers".
- An agent in any public Conversation can change, reassign, or close a
  public item that an agent added, and a new item with the same key
  overwrites it. This breaks "only the Conversation or the plugin that added
  an item can change it" and lets a person reassign an item to themselves
  and answer it.
- The "Needs you" list of Conversations also shows Conversations that wait
  for a sign-in. This breaks "'Needs you' means one thing".
- The "Needs you" group of the classic Inbox also shows open actions for
  Everyone and actions with no assignees. The Inbox count and To do in the
  new Inbox leave them out. This breaks "'Needs you' means one thing".
