# Inbox

The Inbox is where work waits for a person. An Inbox item points at one
subject, such as a question that Junior asked in a Conversation, a
Conversation message that a person must read, a To-do, a pull request, or
an Automation. The subject owns its content, its owner and its links. The
item adds only who must act and whether it is open. Each subject kind has
its own renderer. [Inbox stacks](./inbox-stacks.md) owns how the dashboard
groups and acts on its rows.

## Intent

- Work that needs a person is shared, lasting state: who must act, whether
  it is open, and the answer on record. A Slack message alone has none of
  these.
- There is one way to ask a person, and only for a decision that is theirs
  and blocks the work. Progress, status, offers, scope choices, and work
  that Junior owns are not items.
  Whether Junior starts new work for the requester, such as a Thread that
  implements an issue it filed, is the requester's decision, not an offer.
- A notice is a Conversation message that a person must read or act on,
  such as a reply or a blocked Automation. It says what to do and never
  asks. It can link to other objects, such as a pull request.
- A task for a person is a To-do assigned to them. They see it with their
  other asks, close it themselves, and the agent learns that it is done.
- Only an assignee answers or dismisses a private item that has assignees.
  Anyone who can see a public question can answer or dismiss it. The
  answer carries the authority of the person who gives
  it. Junior, an Event, or a trigger never answers or approves for a
  person.
- "Needs you" means one thing on every surface: an open Inbox item that
  waits on you.

## Rules

- The Inbox filters its asks by type: PRs (a code change's own asks,
  such as Review requested), Decisions (other asks with a form, also
  when they cite a code change), To-dos (the viewer's To-dos), and Other
  (the rest, such as Keep fixing). Each count holds the asks
  that wait on the viewer, one per ask. The type counts add up to All, and
  All is the Inbox count. A type with nothing waiting hides, but All always
  shows.
- The Conversation filters use the state that the row shows: Needs you
  when an Inbox item in the tree waits on the viewer, then Working, then
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
- A question card shows each question with its own header, choices, and answer.
  A card with one question shows it under its "Question" label. In the Inbox,
  the last message of the Turn that asked it comes first (about 12 lines, then
  Show more). A card in the transcript leaves that message out, because it sits
  right above the card. On a phone, the sheet that a transcript card opens shows
  the message, because the sheet covers the transcript. The card has no subject
  preview: the row head and Related link the subject. In the transcript, a
  waiting card spans the transcript width.
- A click on a choice picks it, and a click on the picked choice of a
  single-choice question clears it. A card has one Additional notes box,
  where the person can also write an answer that no choice fits: Enter adds
  a line, and Send or Cmd/Ctrl+Enter sends the answers with the notes. An
  action that takes no words, such as a plugin's Keep fixing, is one click.
- The first answer closes the item for everyone, and the item records who
  closed it and when.
- A dismiss closes the item for everyone, unless its subject gives each
  assignee their own place, such as a GitHub assignee or reviewer. Then a
  dismiss removes only the person who dismissed it, in the subject too. A
  dismiss is not a decision, so it does not continue the work.
- A plugin item's Dismiss says what else it changes on the provider.
- A person who wants someone else to act snoozes it until it closes.
  Snooze is per person. The item then waits in their Snoozed view, where
  they can still answer it, dismiss it, or wake it.
- A row in Snoozed says what ends its snooze, and when the person snoozed
  it, in a muted line, such as "Until Tue, Dec 9, 09:00 · snoozed 2 hours
  ago".
- A card's actions read Dismiss, Snooze, then the main action, such as
  Send, last. Every card that shows an item uses this order.
- An item with no assignee is up for grabs. Anyone who can see it can take
  it or answer it.
- With no assignees named, the item goes to the person in the Turn, else
  the Automation creator, else the Conversation's active Participants.
- A Slack thread that its Conversation detached from gets no new item card.
- An Inbox item stores only its subject, a `{ kind, id }` pair, and the
  fields that every item uses: assignees, status, and who closed it and
  when. Owner, visibility, title, state, and links come from the subject's
  stored data. The Inbox list calls no provider. An item can appear or
  disappear when its owner's visibility changes.
- A subject kind and id name one open item, across all workspaces. There
  is no dedupe key. A plugin kind starts with the plugin name. When the ask
  about the same object changes, such as from review to merge, the same
  item shows the new ask.
- A question belongs to the Conversation where Junior asked it, and holds
  its title, body, form, and answer, with who answered it and when.
  Related links that older questions stored still show on the card, but
  they never decide the card or add related work to another item.
- Only the Conversation or the plugin that added an item can change it,
  and only within the assignee rules.
- A plugin's subject kind can define actions, such as Keep fixing on a
  merge conflict fix that did not land. Each shows as a button on the
  kind's open items. A click closes the item as done, the item records the
  action, and the plugin does the work. It starts no Turn.
- An item is visible to whoever can see its subject's owner. An item from
  a public Conversation is visible to the whole workspace. Everyone means
  the people who can see the item's owner.
- A person whose role on a provider object puts them on its item sees the
  item and the object, but not its owner Conversation unless they can see
  it.
- The owner of a plugin item is a Conversation that the plugin names. For
  each of its subject kinds, the plugin maps a subject id to that
  Conversation from its own records, and Junior reads the owner through
  that map. The item stores no owner.
- An Automation is a definition, and each of its runs is a Conversation. A
  question that a run asks belongs to that run's Conversation, like any
  question. A later run of the same Automation sees the open questions of
  its earlier runs, with their ids, and changes one by its id.
- An Automation alert, such as a failed run, belongs to the Automation
  itself. It follows the Automation's Destination: a public channel makes
  it visible to the workspace. Only core changes or closes it, and a person
  can dismiss it.
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
- A reply in a dashboard Conversation is a notice for its starter,
  unless an open action in that Conversation already waits on them or a
  provider Event, such as a pull request review, started the Turn. The
  notice closes when the starter reads the reply or answers an item in
  that Conversation. A Slack thread already tells people, so a Slack
  reply adds no notice.
- Slack and the dashboard ask for the same things. The dashboard can show
  more detail, but not more asks.
- A push goes to each User assigned to an open action, once per item. A
  reply notice pushes to its starter at each new reply, and replaces the
  push before it. When a time or an Event wakes their snooze of that item,
  it pushes to them once more. Everyone items and other notices do not
  push. When the item closes, its push goes away on every device.
- When Slack shows the item in a card, Slack asks first. The push goes only
  to a User who is still away in Slack after a short wait, and an answer,
  a dismiss, or a reply in that time stops it.
- Auto-archive never hides work that waits for a person. It skips a
  Conversation while it or a child has an open action, an open To-do
  for a person, or an answer that its starter has not read.

## Gaps

- An agent in any public Conversation can change, reassign, or close a
  public item that an agent added, and a new item with the same key
  overwrites it. This breaks "only the Conversation or the plugin that added
  an item can change it" and lets a person reassign an item to themselves
  and answer it.
- An alert for a blocked Automation, or for a trigger that is not
  available, is an action that asks no question, not a notice. It counts
  as needing the creator. This breaks "a notice tells a person about
  something that they must fix" and "there is one way to ask a person".
- The "Needs you" list of Conversations also shows actions for Everyone
  and actions with no assignees. This breaks "'Needs you' means one thing".
- A "To do for you" item has no Slack card. In Slack, the person learns of
  the To-do only from the reply. This breaks "its assignees see it in the
  Inbox and in its linked Slack threads".
- Junior adds a "To do for you" item only when its To-do changes. A person
  who can see the Conversation only after that gets no item until the
  To-do changes again. This breaks "a task for a person is a To-do
  assigned to them. They see it with their other asks".
- A typed message leaves a question for Everyone, or a question with no
  assignees, open. Only its card or the Inbox answers it. This breaks "a
  typed message still answers it".
- An Automation alert shows only in the dashboard Inbox. Slack shows no
  card for it. For a blocked Automation, Slack gets a DM with no card. For a
  failed run or a trigger that is not available, Slack gets nothing. This
  breaks "Slack and the dashboard ask for the same things".
- When automatic updates stop at the limit of automated Turns in a row, the
  notice that asks the person to send a message is a plain Slack reply,
  with no Inbox item. A dashboard Conversation gets nothing. This breaks
  "there is one way to ask a person" and "Slack and the dashboard ask for
  the same things".
- An Automation alert is an action for its creator, but it sends no push.
  This breaks "a push goes to each User assigned to an open action".
- When an item closes, its push stays on a device until the next push to
  that User. This breaks "when the item closes, its push goes away on every
  device".
- An item from a private Conversation cannot go to Everyone yet.
- In Slack, a picked single choice cannot be cleared; the person closes and
  reopens the modal.
