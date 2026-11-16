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

## Behaviors

- `ask` Junior asks a person. The item shows on the desk and as one card in
  each linked Slack thread, with a button per choice, an Answer form, or
  only Dismiss for a notice.
- `first-answer-closes` The first assignee to answer or dismiss closes the
  item for everyone. Every card shows that it is closed.
- `answer-resumes` After an answer, the agent gets it in its Conversation and
  continues the work. A dismiss does not start a Turn.
- `thread-reply` An assignee replies in the thread with an answer. The item
  closes. A reply that only acknowledges or asks back leaves it open.
- `desk-groups` The desk lists open actions under "Needs you" and notices
  under "FYI", oldest first. Closed items show only in search.
- `count` The Inbox badge and the browser tab count the open actions for
  the viewer as a named assignee.
- `take` Anyone takes an item for Everyone and becomes its only assignee.
- `dedupe` A later run with the same key updates the open item. It does
  not add a second one.
- `close-with-reason` Junior closes an item when the work resolves itself.
  The desk shows who closed it and why.
- `waiting` A dashboard conversation with an open item for the viewer shows
  under "Needs you", and the question docks above the message box. A typed
  message answers it.

## Entry points

- Slack: the item card in each linked thread, and a thread reply.
- Dashboard: Inbox, the Home summary, "Needs you" in the conversation list,
  and the question above the message box.
- Settings: "Show Inbox count on the tab icon".
- MCP server: read-only search and fetch with the `review_items:read` scope.

## Rules

- Every item has at least one assignee: a User, or Everyone.
- With no assignees named, the item goes to the person in the Turn, else
  the Automation creator, else the Conversation's Participants.
- An item from a private Conversation stays private and cannot go to
  Everyone.
- Making a Conversation public does not show its private items.
- Only the plugin that added an item, or a person, can change it.
- A Review item is not a Plan item.

## Gaps

- An item can end up with no assignees, and then anyone who can see it can
  answer it. This breaks "every item has at least one assignee" and "only an
  assignee answers".
