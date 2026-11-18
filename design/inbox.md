# Inbox

The Inbox is the dashboard view of the Review desk. It shows the open Review
items for the viewer as rows. The rows of one root Conversation sit together
in a stack: a light border under the root's title. The viewer answers,
dismisses, or snoozes each row on its own. `./review-desk.md` owns who sees
an item and who can act on it.

## Intent

- One stack for each root Conversation. People start and follow root
  Conversations. They usually do not know which Threads and Tasks run under
  a root, or their names. An item from a child agent shows in the stack of
  its root, not on its own.
- Each Review item is its own row, with its own actions. An action never
  applies to a group of items. A pull request review and a question are
  different decisions, and one click must not make both.
- The reader finishes one Conversation before the next. Next goes to the
  next row in the same stack first, so the context that the reader just
  read stays useful.
- A stack is a light grouping, not a new kind of row. It sits inside the
  To do, Up for grabs, and other sections, around the normal Inbox rows.
  It uses the classic Inbox look and adds no color.

## Entry points

- Dashboard: Inbox, with To do, Up for grabs, the Conversation sections,
  and Snoozed.
- The stack title, which opens the root Conversation.
- A row click, which opens the row and its answer form.
- On each row, on hover and always on touch: Open, Snooze, and Dismiss.
- On a stack: Snooze all.
- A link to one item, such as `/?view=inbox&item=<id>`, opens its row.

## Rules

Grouping:

- A child Conversation, at any depth, rolls up to its root. The row shows a
  quiet label that names the child, such as its Thread title, so the reader
  knows which sub-thread asked.
- An item rolls up only when the viewer can see its root, as
  `../policies/conversation-access.md` says. Otherwise it groups under the
  Conversation that added it. The viewer never sees a title, a name, or a
  root that they cannot see.
- A Conversation with one item shows its normal row, with no border. A click
  on that row opens the Conversation.
- A stack of more than four rows shows the first four and "+N more in this
  Conversation". That control shows the rest in place. A stack also shows
  the rest when its open row is past the first four.
- The Conversations view keeps one row per Conversation, with Pin and
  Archive. Stacks are for the Inbox and Snoozed.

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
- When a stack shrinks to one row, that row becomes the normal row of its
  Conversation. An open row stays open.
- In To do, a stack leaves with its last row that waits on the viewer, and
  the next row of the list opens.
- Notices do not stack. A notice about the subject of an ask folds into the
  ask's row. Other notices show in FYI, one row each.

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
- Snooze all on a stack puts away every row in it. It wakes at its time, or
  when the stack gets a newer item, also from a child.
- Snoozed shows each snoozed row in the stack of its root. Wake on a row
  wakes only that item. The other rows of a Snooze all stay snoozed.

## Gaps

- A stack shows only the root's title. The Conversation row's kind pills,
  Brief, and activity do not show for a root with more than one item.
- Snooze all has no leave motion. The stack goes at once.
- A snooze lives in one browser. Another browser of the same viewer shows
  the item.
