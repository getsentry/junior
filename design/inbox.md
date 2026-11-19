# Inbox

The Inbox shows the open Review items for the viewer, one item row each.
The rows of one root Conversation sit together in a stack: a lightly
tinted tray under the root's title. The viewer answers, dismisses, or
snoozes each row on its own. `./review-desk.md` owns who sees an item and who can act on it.

## Intent

- One stack for each root Conversation. People start and follow root
  Conversations. They usually do not know which Threads and Tasks run under
  a root, or their names. An item from a child agent shows in the stack of
  its root, not on its own.
- Each Review item is its own row, with its own actions. An item row is
  always one actionable item, such as a question or a pull request. A
  Conversation row is a different row, for the Conversations view. A row
  action never applies to a group of items. A pull request review and a question are
  different decisions, and one click must not make both.
- The reader finishes one Conversation before the next. Next goes to the
  next row in the same stack first, so the context that the reader just
  read stays useful.
- A stack is a light grouping, not a new kind of row. It sits inside the
  To do, Up for grabs, and other sections, around the normal Inbox rows.
  It uses the classic Inbox look and adds no color.

## Entry points

- Dashboard: Inbox, with To do, Up for grabs, and FYI. Snoozed. The
  Conversations view.
- The stack title, which opens the root Conversation.
- A row click, which opens the row and its answer form.
- On each row, on hover: Open, Snooze, and Dismiss, as icons with their
  names as tooltips. A touch screen has no hover, so there a row shows its
  actions only once it is open. Rows do not repeat them.
- On a stack: Snooze and Dismiss, as quiet buttons, and the stack's item
  count once, right-most. The buttons do not repeat the count. Their names
  say what they cover, such as "Snooze 3 items in this stack". Snooze
  covers every row. Dismiss covers the open asks that the viewer can act
  on. Dismiss is the main action, so it comes last.
- A link to one item, such as `/?view=inbox&item=<id>`, opens its row.

## Rules

Grouping:

- A child Conversation, at any depth, rolls up to its root. Every item has
  the same root field, read from the root that each Conversation stores, so
  depth costs nothing. The row shows a quiet label that names the child,
  such as its Thread title, so the reader knows which sub-thread asked.
- An item rolls up only when the viewer can see its root, as
  `../policies/conversation-access.md` says. Otherwise it groups under the
  Conversation that added it. The viewer never sees a title, a name, or a
  root that they cannot see.
- A Conversation with one item shows that item's row, with no tray. A
  click on it opens the row, as in a stack.
- A stack of more than four rows shows the first four and "+N more in this
  Conversation". That control shows the rest in place. A stack also shows
  the rest when its open row is past the first four.
- An open row says each fact once. The row's head names the kind, the
  number, the title, and the sub-thread. The open card and the subject's
  preview do not say them again.
- The Conversations view keeps one Conversation row each, with Pin and
  Archive. Stacks are for To do, Up for grabs, FYI, and Snoozed.

Actions:

- Each row carries its own answer, Dismiss, and Snooze. An answer closes
  the item as done. None of them act on the other rows of the stack.
- A row that closes leaves with one motion, whatever closed it: its own
  action, another person, an agent, or Slack. The other rows stay.
- A row's own action applies before the server answers. When it fails, only
  that row comes back, and a toast offers Retry.
- When an open row leaves, the next row of its stack opens, also past the
  fold. After the last row of the stack, the row before it opens. When the
  stack has no other row, the next row of the list opens.
- When a stack shrinks to one row, the tray goes and the row stays. An
  open row stays open.
- A stack's Snooze and Dismiss put the whole stack away with the same leave
  motion as a row. When a row of the stack was open, the next row after the
  stack opens.
- In To do, a stack leaves with its last row that waits on the viewer, and
  the next row of the list opens.
- A notice about the subject of an ask folds into the ask's row. Other
  notices show in FYI, stacked by root as asks are, one row each.

Order and counts:

- In a stack, actions come first, then notices. Each group is oldest first.
- Stacks that wait on the viewer come first, the one that waited longest at
  the top. Other stacks follow, oldest first. The order does not move while
  the reader works.
- A stack waits on the viewer when any of its rows does, including a row
  from a child.
- Counts count Review items, not stacks. The To do count and the tab count
  stay the same when items roll up.

Snooze:

- Snooze on a row puts away only that item. It wakes at its time.
- Snooze on a stack snoozes each of its items until the same time. An
  item that arrives later is not snoozed: it shows in the Inbox by itself,
  and the rest stay in Snoozed.
- Snoozed shows each snoozed row in the stack of its root. Wake on a row
  wakes only that item.

## Gaps

- A stack shows only the root's title. The Conversation row's kind pills,
  Brief, and activity do not show for a root with more than one item.
- A snooze lives in one browser. Another browser of the same viewer shows
  the item. Server snoozes (getsentry/junior#3567, #3392) close this gap.
