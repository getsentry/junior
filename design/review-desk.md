# Review desk

The Review desk is where work waits for a person. Junior or a plugin adds a
Review item: an action that asks a question, or a notice that only tells.
Each assignee sees it on the desk and in its linked Slack threads, and the
first answer lets the work continue. The dashboard labels the desk "Inbox".

## Intent

- Work that needs a person is shared, lasting state: who must act, whether
  it is open, and the answer on record. A Slack message alone has none of
  these.
- There is one way to ask a person, and only for a decision that is theirs
  and blocks the work. Progress, offers, and scope choices are not items.
- Only an assignee answers, and the answer carries their authority. Junior,
  an Event, or a trigger never answers or approves for a person.
- "Needs you" means one thing on every surface: an open action assigned to
  you.

## Entry points

- Slack: the item card in each linked thread, and a thread reply.
- Dashboard: Inbox, the Home summary, "Needs you" in the conversation list,
  and the question above the message box.
- Settings: "Show Inbox count on the tab icon".
- MCP server: read-only search and fetch with the `review_items:read` scope.

## Rules

- The first answer or dismiss closes the item for everyone. A dismiss is
  not a decision, so it does not continue the work.
- Every item has at least one assignee: a User, or Everyone. When no
  assignee is left, the item dismisses itself.
- With no assignees named, the item goes to the person in the Turn, else
  the Automation creator, else the Conversation's Participants.
- An item from a private Conversation stays private and cannot go to
  Everyone.
- Making a Conversation public does not show its private items.
- Only the plugin that added an item, or a person, can change it.
- A Review item is not a Plan item.

## Gaps

- An item can have no assignees, and then anyone who can see it can answer
  it. It does not dismiss itself. This breaks "every item has at least one
  assignee" and "only an assignee answers".
