# Inbox

The Inbox is where work waits for a person. Junior or a plugin adds an
Inbox item: an action that asks a question, or a notice that names a step
for a person. A To-do that an agent assigns to a person shows as a "To do
for you" item. The first answer lets the work continue.
[Inbox stacks](./inbox-stacks.md) owns how the dashboard groups and acts on
its rows.

## Jobs

- When work needs a person's decision, Junior asks them with an Inbox
  item, so who must act, whether it is open, and the answer are on record.
- When a person must read or fix something, such as a reply or a blocked
  Automation, they get a notice that says what to do.
- When an agent needs a person to do a task, the person sees it with their
  other asks and closes it themselves, so the agent learns that it is done.
- When a person checks what waits on them, every surface shows the same
  asks, so they can trust any one of them.

## Rules

**Asking**

- `one-way-to-ask` Junior asks a person only with an Inbox item, and only
  for a decision that is theirs and blocks the work.
  - Example: whether Junior starts new work for the requester, such as a
    Thread that implements an issue it filed, is the requester's decision.
    Junior asks.
- `notice-never-asks` A notice never asks. It says what the person must
  read or fix, and what to do.
- `seen-everywhere` Each assignee sees an item in the Inbox and as a card
  in its linked Slack threads.
- `same-asks` Slack and the dashboard ask for the same things. The
  dashboard can show more detail, but not more asks.
- `detached-thread` A Slack thread that its Conversation detached from gets
  no new item card.
- `never-blocks` A question never blocks its Conversation. It shows as a
  card in the transcript where Junior asked it. Nothing docks over the
  message box, and nothing takes the focus. A typed message still answers
  it.
- `waiting-pill` While a waiting card is not in full view, a "N questions
  waiting" pill shows above the message box and goes to the oldest such
  card.

**Answering**

- `who-answers` Only an assignee answers a private item. Anyone who can
  see a public question can answer it, but only an assignee dismisses or
  takes it.
- `answer-authority` An answer carries the authority of the person who
  gives it. Junior, an Event, or a trigger never answers or approves for a
  person.
- `first-answer-closes` The first answer or dismiss closes the item for
  everyone. A dismiss is not a decision, so it does not continue the work.
- `click-picks` A click on a choice picks it. Send answers, with the note
  line. An action that takes no words, such as a plugin's Resume, is one
  click.
- `snooze-for-others` When a person wants someone else to answer, they
  snooze the item until it closes. It then waits in their Snoozed view,
  where they can still answer it, dismiss it, or wake it.
- `plugin-answers` The answer to an item that a plugin added goes to that
  plugin, which does the work, such as Resume on a merge conflict fix that
  did not land. It starts no Turn.

**Who sees and changes an item**

- `no-assignee` An item with no assignee is up for grabs. Anyone who can
  see it can take it or answer it.
- `default-assignees` When no assignees are named, the item goes to the
  person in the Turn, else the Automation creator, else the Conversation's
  active Participants.
- `public-visible` An item from a public Conversation is visible to the
  whole workspace.
- `private-stays-private` An item from a private Conversation stays
  private. Everyone means the people who can see the Conversation: its
  members when it is private, and anyone when it is public. If the
  Conversation becomes public, its private items stay hidden.
- `owner-changes` Only the Conversation or the plugin that added an item
  can change it, and only within the assignee rules.

**To-dos for a person**

- `todo-item` A To-do that an agent assigns to a person is an open action
  for that person alone, in the stack of its Conversation. Its title and
  notes follow the To-do.
- `todo-private` Only the assignee sees a "To do for you" item, and only
  while they can see the Conversation's private content. No other person
  and no agent sees or changes it. The Conversation waits on the assignee
  alone, and its shared status does not change.
- `todo-close` Done marks the To-do done, and Dismiss drops it. Neither
  starts a Turn: the agent sees the change in its next Turn. Snooze works
  as on any row, and a snooze that resolves on an Event marks the To-do
  done.
- `todo-follows` When the agent closes, drops, or removes the To-do, or
  gives it to itself or a child agent, its item closes. When the To-do goes
  to another person, the item goes with it. When the To-do opens again, it
  gets a new item.

**Notices and Automation alerts**

- `reply-notice` A reply in a dashboard Conversation is a notice for its
  starter. One notice per Conversation holds the latest reply, and it
  closes when the starter reads it. A Slack reply adds no notice, because
  the Slack thread already tells people.
- `alert-visibility` An Automation alert follows its Automation's
  Destination: a public channel makes it visible to the workspace. No agent
  or plugin changes or closes it. A person can dismiss it.
- `alert-steps` A failed-run Automation alert offers the steps that fit its
  Automation, and Junior takes the step that the person picks.
- `alert-dismiss` When a person dismisses an Automation alert, every alert
  of that Automation stays hidden until the Automation recovers: it is
  active, its last run succeeded, and its trigger is available. A pause is
  no recovery.

**Dashboard**

- `needs-you` "Needs you" means one thing on every surface: an ask or a
  Conversation tree that waits on you.
- `type-filters` The Inbox filters its asks by type: PRs (asks about a code
  change), Decisions (other asks with a form), To-dos (the viewer's
  To-dos), and Other (the rest, such as Resume). Each count holds the asks
  that wait on the viewer, one per ask, and the counts add up to All. All
  is the Inbox count. A type with nothing waiting hides, but All always
  shows.
- `conversation-filters` The Conversation filters use the state that the
  row shows: Needs you when an ask or the tree waits on the viewer, then
  Working, then Watching. Done is the rest.
- `pinned` Pinned, a tab of the same control, shows only the rows of the
  viewer's pinned Conversations. A pinned row stays in its place, with a
  pin marker.
- `filters-in-url` The filters stay in the URL, so a reload or a link
  keeps them. They fit one row, also on a phone.
- `card-layout` A question card has one layout in the Inbox and the
  transcript: the question under its "Question" label, then the last
  message of the Turn that asked it (about 12 lines, then Show more), then
  the form. The row head and Related link the subject, so the card has no
  subject preview. In the transcript, a waiting card spans the transcript
  width.
- `action-order` Every card that shows an item has its actions in this
  order: Dismiss, Snooze, then the main action, such as Send.
- `woke-line` When a time or an Event wakes a snooze, the item's row and
  card say why in a muted line, such as "Woke: getsentry/junior#12 is
  merged". Only the person whose snooze woke sees it, until they open the
  item from the Inbox, act on it, or snooze it again. A Wake that they
  pick, and a trigger that resolves the item, show nothing.
- `no-archive` Auto-archive never hides work that waits for a person. It
  skips a Conversation while it or a child has an open action, an open
  To-do for a person, or an answer that its starter has not read.

**Push notifications**

- `push` A push goes to each User assigned to an open action, once per
  item. A reply notice pushes to its starter at each new reply, and
  replaces the push before it. When a time or an Event wakes a person's
  snooze, it pushes to them once more. Everyone items and other notices do
  not push. When the item closes, its push goes away on every device.
- `slack-first` When Slack shows the item in a card, Slack asks first. The
  push goes only to a User who is still away in Slack after a short wait.
  An answer, a dismiss, or a reply in that time stops it.

## Non-goals

- Items for progress, status, offers, scope choices, or work that Junior
  owns.
- A plain Slack message as a way to ask. It has no assignee, no open state,
  and no answer on record.

## Gaps

- `owner-changes`: an agent in any public Conversation can change,
  reassign, or close a public item that an agent added, and a new item with
  the same key overwrites it. A person can then reassign the item to
  themselves and answer it.
- `notice-never-asks`, `one-way-to-ask`: an alert for a blocked
  Automation, or for a trigger that is not available, is an action that
  asks no question. It counts as needing the creator.
- `needs-you`: the "Needs you" list of Conversations also shows actions for
  Everyone and actions with no assignees.
- `seen-everywhere`: a "To do for you" item has no Slack card. In Slack,
  the person learns of the To-do only from the reply.
- `todo-item`: a "To do for you" item appears only when its To-do changes.
  A person who can see the Conversation only after that gets no item until
  the To-do changes again.
- `notice-never-asks`: an agent or a plugin can add a notice that names no
  next step, and the Inbox shows it in FYI.
- `same-asks`: an Automation alert shows only in the dashboard Inbox. For a
  blocked Automation, Slack gets a DM with no card. For a failed run or a
  trigger that is not available, Slack gets nothing.
- `one-way-to-ask`, `same-asks`: when automatic updates stop at the limit
  of automated Turns in a row, the notice that asks the person to send a
  message is a plain Slack reply, with no Inbox item. A dashboard
  Conversation gets nothing.
- `push`: an Automation alert is an action for its creator, but it sends no
  push.
- `push`: when an item closes, its push stays on a device until the next
  push to that User.
