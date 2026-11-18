# Inbox

The Inbox is the dashboard view of the Review desk. It shows the open Review
items for the viewer as one stack for each root Conversation. Each item in a
stack is a card that the viewer answers, dismisses, or snoozes on its own.
`./review-desk.md` owns who sees an item and who can act on it.

## Intent

- One stack for each root Conversation. People start and follow root
  Conversations. They usually do not know which Threads and Tasks run under
  a root, or their names. An item from a child agent shows in the stack of
  its root, not as a stack of its own.
- Each Review item is its own card, with its own actions. An action never
  applies to a group of items. A pull request review and a question are
  different decisions, and one click must not make both.
- The reader finishes one Conversation before the next. Next goes to the
  next card in the same stack first, so the context that the reader just
  read stays useful.
- The Inbox is quiet. Stacks and cards use the classic Inbox look and add no
  color. The waiting dot and the kind of each item carry its state.

## Entry points

- Dashboard: Inbox, with To do, Up for grabs, the Conversation sections,
  and Snoozed.
- The stack header, and its "Open conversation" action.
- On each card: the answer form, Dismiss, and Snooze.
- On the stack: Snooze, for every card in it.
- A link to one item, such as `/?view=inbox&item=<id>`, opens its stack at
  its card.

## Rules

Grouping:

- A child Conversation, at any depth, rolls up to its root. The card shows a
  quiet label that names the child, such as its Thread title, so the reader
  knows which sub-thread asked.
- An item rolls up only when the viewer can see its root, as
  `../policies/conversation-access.md` says. Otherwise it keeps a stack for
  the Conversation that added it. The viewer never sees a title, a name, or
  a root that they cannot see.
- The stack header names the root Conversation and opens it. It shows the
  root's Brief and activity. A card never renames its stack.

Actions:

- Each card carries its own answer, Dismiss, and Snooze. An answer closes
  the item as done. None of them act on the other cards of the stack.
- A card that closes leaves with one motion, whatever closed it: its own
  action, another person, an agent, or Slack. The other cards stay.
- When a card leaves, the next card in its stack opens. When the last card
  of a stack leaves, the stack leaves and the next stack opens.

Order and counts:

- In a stack, actions come first, then notices. Each group is oldest first.
- Stacks that wait on the viewer come first, the one that waited longest at
  the top. Other stacks follow, oldest first. The order does not move while
  the reader works.
- A stack waits on the viewer when any of its cards does, including a card
  from a child.
- The header shows the number of open cards when there is more than one.
- Counts count Review items, not stacks. The To do count and the tab count
  stay the same when items roll up.

Snooze:

- Snooze on a card puts away only that item. It wakes at its time.
- Snooze on a stack puts away every card in it. It wakes at its time, or
  when the stack gets a newer item, also from a child.
- Snoozed shows each snoozed card under the stack of its root, and the card
  wakes there.

## Gaps

- Each child Conversation with items shows as its own row, apart from its
  root. This breaks "one stack for each root Conversation".
- A row with more than one item has one Dismiss and one Snooze that act on
  all of its items. This breaks "each Review item is its own card".
- After Dismiss, the next row opens, not the next item of the same
  Conversation. This breaks "next goes to the next card in the same stack
  first".
- An item that closes while its row stays open disappears without the leave
  motion. Only a row whose items all close leaves with it. This breaks "a
  card that closes leaves with one motion".
- A card names no child, so the reader cannot tell which sub-thread asked.
  This breaks the child label rule.
