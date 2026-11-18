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
- On a stack of more than one card: Snooze all.
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
- When a card leaves, the next card in its stack takes focus. When the last
  card of a stack leaves, the stack leaves and the next stack opens.
- In To do, a stack leaves with its last card that waits on the viewer, and
  the next stack opens. Its notices stay in the stack, in the section of
  its Conversation.

Order and counts:

- In a stack, actions come first, then notices. Each group is oldest first.
- Stacks that wait on the viewer come first, the one that waited longest at
  the top. Other stacks follow, oldest first. The order does not move while
  the reader works.
- A stack waits on the viewer when any of its cards does, including a card
  from a child.
- The header's pills count the open cards by kind.
- Counts count Review items, not stacks. The To do count and the tab count
  stay the same when items roll up.

Snooze:

- Snooze on a card puts away only that item. It wakes at its time.
- Snooze all on a stack puts away every card in it. It wakes at its time,
  or when the stack gets a newer item, also from a child. A stack of one
  card has only the card's Snooze.
- Snoozed shows each snoozed card under the stack of its root, and the card
  wakes there.

## Gaps

- Wake in Snoozed wakes the whole stack. A card that was snoozed alone
  cannot wake alone. This breaks "the card wakes there".
- A snooze lives in one browser. Another browser of the same viewer shows
  the item.
