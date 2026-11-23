# Inbox

The Inbox is where work waits for a person. Junior or a plugin adds a
Inbox item: an action that asks a question, or a notice that names a step
for a person. A To-do that an agent assigns to a person shows as a "To do
for you" item.
Its assignees see it in the Inbox and in its linked Slack threads, and the
first answer lets the work continue. [Inbox stacks](./inbox-stacks.md) owns
how the dashboard groups and acts on its rows.

## Intent

- Work that needs a person is shared, lasting state: who must act, whether
  it is open, and the answer on record. A Slack message alone has none of
  these.
- There is one way to ask a person, and only for a decision that is theirs
  and blocks the work. Progress, status, offers, scope choices, and work
  that Junior owns are not items ([Attention](./attention.md)).
  Whether Junior starts new work for the requester, such as a Thread that
  implements an issue it filed, is the requester's decision, not an offer.
- A notice tells a person about something that they must fix, such as a
  blocked Automation, and says what to do. It never asks.
- A task for a person is a To-do assigned to them. They see it with their
  other asks, close it themselves, and the agent learns that it is done.
- Only an assignee answers, and the answer carries their authority. Junior,
  an Event, or a trigger never answers or approves for a person.
- "Needs you" means one thing on every surface: an open action assigned to
  you.

## Entry points

- Slack: the item card in each linked thread, and a thread reply.
- Dashboard: Inbox, the Home summary, "Needs you" in the conversation list,
  the question card in the Conversation transcript, and the questions pill.
  Done and Dismiss on a "To do for you" row.
- Dashboard filters: All, PRs, Decisions, and Other in the Inbox; All,
  Needs you, Working, Watching, and Done in Conversations and a
  repository's Conversations tab; and Pinned in the same control in all three.
- Settings: "Show the Inbox count in the tab".
- MCP server: read-only search and fetch with the `inbox_items:read` scope.

## Rules

- The Inbox filters its asks by type: PRs (asks about a code
  change), Decisions (other asks with a form), and Other (the rest, such
  as To-dos and Resume). Each count holds the asks that wait on the viewer,
  one per ask. The type counts add up to All, and All is the Inbox count.
  A type with nothing waiting hides, but All always shows.
- The Conversation filters use the state that the row shows: Needs you
  when an ask or the tree waits on the viewer, then Working, then
  Watching. Done is the rest.
- Pinned, a tab of the same control, shows only the rows of the viewer's pinned Conversations.
  Pins have no section of their own: a pin stays in its place, with a pin
  marker.
- The filters stay in the URL, so a reload or a link keeps them. They fit
  one row, also on a phone.
- A question never blocks its Conversation. It shows as a card in the
  transcript where Junior asked it. Nothing docks over the message box, and
  nothing takes the focus. A typed message still answers it.
- While a waiting card is not in full view, a "N questions waiting" pill
  shows above the message box and goes to the oldest such card.
- A question card has one layout in the Inbox and the transcript: the
  question under its "Question" label, then the last message of the Turn
  that asked it (about 12 lines, then Show more), then the form. The card
  has no subject preview: the row head and Related link the subject. In
  the transcript, a waiting card spans the transcript width.
- A click on a choice picks it. Send answers, with the note line. An
  action that takes no words, such as a plugin's Resume, is one click.
- The first answer or dismiss closes the item for everyone. A dismiss is
  not a decision, so it does not continue the work.
- A person who wants someone else to answer snoozes it until it closes.
  It then waits in their Snoozed view, where they can still answer it,
  dismiss it, or wake it.
- A card's actions read Dismiss, Snooze, then the main action, such as
  Send, last. Every card that shows an item uses this order.
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
- The answer to an item that a plugin added goes to that plugin, which does
  the work, such as Resume on a merge conflict fix that did not land. It
  starts no Turn.
- An item from a public Conversation is visible to the whole workspace.
- An Automation alert follows its Automation's Destination: a public
  channel makes it visible to the workspace. Only core changes or closes
  it, and a person can dismiss it.
- A failed-run Automation alert offers the steps that fit its Automation,
  and core takes the step.
- A dismissed Automation alert hides every alert of that Automation until
  the Automation recovers: it is active, its last run succeeded, and its
  trigger is available. A pause is no recovery.
- A To-do for a person is an open action for that person alone, in the
  stack of its Conversation. Its title and notes follow the To-do. Only the
  assignee sees it, and only while they can see the Conversation's private
  content. No other person and no agent sees or changes it. The
  Conversation waits on the assignee alone; its shared status does not
  change.
- Done or Dismiss closes a "To do for you" item: Done marks the To-do
  done, and Dismiss drops it. Neither starts a Turn: the agent sees the
  change in its next Turn. Snooze works as on any row, and a snooze that
  resolves on an Event marks the To-do done.
- When the agent closes, drops, or removes the To-do, or gives it to
  itself or a child agent, its item closes. A To-do that goes to another
  person takes its item along. A To-do that opens again gets a new item.
- When a time or an Event wakes a snooze, the item's Inbox row and card
  say why in a muted line, such as "Woke: getsentry/junior#12 is merged".
  Only the person whose snooze woke sees it. It goes when they open the
  item from the Inbox, act on it, or snooze it again. A Wake that they
  pick, and a trigger that resolves the item, show nothing.
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
- An alert for a blocked Automation, or for a trigger that is not
  available, is an action that asks no question, not a notice. It counts
  as needing the creator. This breaks "a notice tells a person about
  something that they must fix" and "there is one way to ask a person".
- The "Needs you" list of Conversations also shows Conversations that wait
  for a sign-in. This breaks "'Needs you' means one thing".
- A "To do for you" item has no Slack card. In Slack, the person learns of
  the To-do only from the reply. This breaks "its assignees see it in the
  Inbox and in its linked Slack threads".
- Core adds a "To do for you" item only when its To-do changes. A person
  who can see the Conversation only after that gets no item until the
  To-do changes again. This breaks "a task for a person is a To-do
  assigned to them. They see it with their other asks".
- The "Needs you" group of the classic Inbox also shows open actions for
  Everyone and actions with no assignees. To do in the new Inbox shows
  actions with no assignees, and the Inbox count leaves them out. This
  breaks "'Needs you' means one thing".
